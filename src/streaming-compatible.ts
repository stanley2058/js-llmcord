import {
  streamText,
  type Tool,
  type FinishReason,
  type ModelMessage,
} from "ai";
import { getConfig } from "./config-parser";

export type StreamTextParams = Parameters<typeof streamText>[0];

export interface ParsedToolCall {
  callId: string;
  toolName: string;
  /** Raw payload contained inside the tool-call tag */
  rawArguments: string;
  /** Attempted JSON parsing of the payload; falls back to raw text if parsing fails */
  arguments: unknown;
}

export interface CompatibleStreamOptions
  extends Omit<StreamTextParams, "tools"> {
  /**
   * Optional tools registry. They are NOT passed to the model; kept here for convenience
   * so callers can resolve or execute tools after parsing directives.
   */
  tools?: Record<string, Tool>;
  /** Hook invoked whenever plain text (sans tool markup) is produced */
  onTextChunk?: (text: string) => void | Promise<void>;
  /** Prefix used when generating tool call identifiers */
  toolCallIdPrefix?: string;
  /** Max number of compatible tool loops to run */
  maxToolLoops?: number;
}

export interface CompatibleStreamResult {
  /** Collapsed assistant text with tool-call directives stripped out */
  text: string;
  /** List of parsed tool-call directives encountered during streaming */
  toolCalls: ParsedToolCall[];
  /** Underlying finish reason reported by the provider */
  finishReason: FinishReason;
}

const TOOL_CALL_PATTERN =
  /<tool-call\s+tool="([^"]+)">([\s\S]*?)<\/tool-call>/g;

export async function runCompatibleStream(
  options: CompatibleStreamOptions,
): Promise<CompatibleStreamResult> {
  const config = await getConfig();
  const {
    messages,
    onTextChunk,
    toolCallIdPrefix = "compatible-tool",
    tools: toolRegistry,
    maxToolLoops = config.max_steps ?? 10,
    ...rest
  } = options;

  if (!messages || messages.length === 0) {
    throw new Error("runCompatibleStream requires at least one message");
  }

  // Prepare working state
  let workingMessages = [...messages] as ModelMessage[];
  let overallText = "";
  const allParsedCalls: ParsedToolCall[] = [];
  let callSequence = 0;
  let finalFinish: FinishReason | undefined;

  // Iterative loop: stream -> parse -> maybe execute tools -> append tool results -> repeat
  for (let step = 0; step < maxToolLoops; step++) {
    const msgWithoutSystem = messages.filter((m) => m.role !== "system");
    const { text, calls, finishReason } = await streamOnce({
      messages: workingMessages,
      onTextChunk,
      generateCallId: () => `${toolCallIdPrefix}-${++callSequence}`,
      rest,
    });

    overallText += text;
    allParsedCalls.push(...calls);
    finalFinish = finishReason;

    if (calls.length === 0) {
      // No tool calls: we are done
      break;
    }

    // Append the assistant text for this step (if any) to the conversation
    if (text && text.trim().length > 0) {
      workingMessages = workingMessages.concat({
        role: "assistant",
        content: text,
      } as ModelMessage);
    }

    // Execute tools and add tool result message
    const toolResultsContent = await Promise.all(
      calls.map(async (c) => {
        const tool = toolRegistry ? toolRegistry[c.toolName] : undefined;
        if (!tool || typeof tool.execute !== "function") {
          return {
            type: "tool-result",
            toolCallId: c.callId,
            toolName: c.toolName,
            output: {
              type: "error-text",
              value: `Tool not available: ${c.toolName}`,
            },
          };
        }

        try {
          const input = c.arguments === "" ? undefined : c.arguments;
          const output = await tool.execute(input, {
            messages: msgWithoutSystem,
            toolCallId: c.callId,
          });
          const outputPart = toToolResultOutput(output);
          return {
            type: "tool-result",
            toolCallId: c.callId,
            toolName: c.toolName,
            output: outputPart,
          };
        } catch (err) {
          return {
            type: "tool-result",
            toolCallId: c.callId,
            toolName: c.toolName,
            output: {
              type: "error-text",
              value: `Tool execution failed: ${String(err)}`,
            },
          };
        }
      }),
    );

    // Add tool results as a single tool message
    workingMessages = workingMessages.concat({
      role: "tool",
      content: toolResultsContent,
    } as ModelMessage);

    // Continue loop, prompting the model again with new messages
  }

  if (!finalFinish) {
    // Should not happen but satisfies type
    throw new Error("streaming did not produce a finish reason");
  }

  return {
    text: overallText,
    toolCalls: allParsedCalls,
    finishReason: finalFinish,
  };
}

async function streamOnce({
  messages,
  onTextChunk,
  generateCallId,
  rest,
}: {
  messages: ModelMessage[];
  onTextChunk?: (text: string) => void | Promise<void>;
  generateCallId: () => string;
  rest: Omit<StreamTextParams, "messages" | "tools">;
}): Promise<{
  text: string;
  calls: ParsedToolCall[];
  finishReason: FinishReason;
}> {
  const response = streamText({
    ...rest,
    messages,
    tools: undefined,
  } as StreamTextParams);

  const { textStream, finishReason } = response;

  let buffer = "";
  let textAccumulator = "";
  const parsedCalls: ParsedToolCall[] = [];

  for await (const chunk of textStream) {
    buffer += chunk;
    const { remainingBuffer } = await flushToolMarkup({
      buffer,
      onTextChunk,
      parsedCalls,
      textAccumulatorRef: (value) => {
        textAccumulator += value;
      },
      generateCallId,
    });
    buffer = remainingBuffer;
  }

  if (buffer.length > 0) {
    const { remainingBuffer } = await flushToolMarkup({
      buffer,
      onTextChunk,
      parsedCalls,
      textAccumulatorRef: (value) => {
        textAccumulator += value;
      },
      generateCallId,
      flushRemainder: true,
    });
    buffer = remainingBuffer;
  }

  const finish = await finishReason;
  return { text: textAccumulator, calls: parsedCalls, finishReason: finish };
}

type FlushArgs = {
  buffer: string;
  parsedCalls: ParsedToolCall[];
  textAccumulatorRef: (value: string) => void;
  generateCallId: () => string;
  onTextChunk?: (text: string) => void | Promise<void>;
  flushRemainder?: boolean;
};

async function flushToolMarkup({
  buffer,
  parsedCalls,
  textAccumulatorRef,
  generateCallId,
  onTextChunk,
  flushRemainder = false,
}: FlushArgs): Promise<{ remainingBuffer: string }> {
  let lastIndex = 0;
  TOOL_CALL_PATTERN.lastIndex = 0;

  while (true) {
    const match = TOOL_CALL_PATTERN.exec(buffer);
    if (!match) break;

    const [matched, toolName, payload] = match;
    const preceding = buffer.slice(lastIndex, match.index);
    if (preceding) {
      textAccumulatorRef(preceding);
      if (onTextChunk) await onTextChunk(preceding);
    }

    if (toolName === undefined || payload === undefined) {
      textAccumulatorRef(matched);
      if (onTextChunk) await onTextChunk(matched);
      lastIndex = match.index + matched.length;
      continue;
    }

    const callId = generateCallId();
    parsedCalls.push({
      callId,
      toolName,
      rawArguments: payload,
      arguments: tryParseJson(payload),
    });

    lastIndex = match.index + matched.length;
  }

  const remaining = buffer.slice(lastIndex);

  if (flushRemainder && remaining) {
    textAccumulatorRef(remaining);
    if (onTextChunk) await onTextChunk(remaining);
    return { remainingBuffer: "" };
  }

  return { remainingBuffer: remaining };
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return trimmed;
  }
}

function toToolResultOutput(output: unknown): any {
  if (typeof output === "string") return { type: "text", value: output };
  // treat undefined/null as empty text
  if (output === undefined || output === null)
    return { type: "text", value: "" };
  // numbers, booleans, arrays, objects -> json
  try {
    // Ensure it's JSON-serializable
    JSON.stringify(output);
    return { type: "json", value: output };
  } catch {
    return { type: "error-text", value: "Non-serializable tool output" };
  }
}
