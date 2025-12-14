import {
  asSchema,
  streamText,
  type CallWarning,
  type FinishReason,
  type JSONValue,
  type ModelMessage,
  type ReasoningOutput,
  type ToolResultPart,
} from "ai";
import type { ILogger } from "./logger";

export type StreamTextParams = Parameters<typeof streamText>[0];
export type StreamTextResult = Awaited<ReturnType<typeof streamText>>;

// Tool syntax: <tool-call tool="{name}">{payload}</tool-call>
const TOOL_CALL_SINGLE = /<tool-call\s+tool="([^"]+)">([\s\S]*?)<\/tool-call>/;
function maybeToolCallStart(text: string) {
  const start = "<tool-call";
  for (let i = 0; i < Math.min(text.length, start.length); i++) {
    if (text[i] !== start[i]) return false;
  }
  return true;
}
function maybeToolCallEnd(text: string) {
  const end = "</tool-call>";
  for (let i = 0; i < Math.min(text.length, end.length); i++) {
    if (text[text.length - i - 1] !== end[end.length - i - 1]) return false;
  }
  return true;
}

const toolCallIdPrefix = "compatible-tool";

export function shouldInsertBoundarySeparator(
  prevLastChar: string,
  nextFirstChar: string,
): boolean {
  // Insert a small boundary when stitching streamed segments, but only when
  // concatenation would merge markdown delimiters (e.g. `*` + `*` => `**`).
  // This commonly happens around tool-call boundaries.
  if (!prevLastChar || !nextFirstChar) return false;

  const mergeable = new Set(["*", "_", "`", "~", "$"]);
  return prevLastChar === nextFirstChar && mergeable.has(prevLastChar);
}

export function maybeYieldBoundarySeparator(
  prevLastChar: string,
  nextChunk: string,
  separator: string = " ",
): string {
  if (!nextChunk) return "";
  const nextFirstChar = nextChunk[0] ?? "";
  return shouldInsertBoundarySeparator(prevLastChar, nextFirstChar) ? separator : "";
}

export function streamTextWithCompatibleTools({
  tools,
  messages,
  logger,
  ...rest
}: StreamTextParams & { logger: ILogger }) {
  messages = [...(messages || [])];

  const toolDesc = Object.entries((tools = tools || {})).map(([name, tool]) => {
    return {
      name,
      description: tool.description,
      jsonSchema: asSchema(tool.inputSchema).jsonSchema,
    };
  });
  const compatibleSystemPrompt: ModelMessage = {
    role: "system",
    content:
      "Important rule to call tools:\n" +
      '- If you want to call a tool, you MUST ONLY output the tool call syntax: <tool-call tool="{name}">{payload}</tool-call>\n' +
      "- Examples:\n" +
      '  - <tool-call tool="fetch">{"url":"https://example.com","max_length":10000,"raw":false}</tool-call>\n' +
      '  - <tool-call tool="eval">{"code":"print(\'Hello World\')"}</tool-call>\n' +
      "\nAvailable tools:\n" +
      JSON.stringify(toolDesc, null, 2),
  };

  const { promise: finishReason, resolve: resolveFinishReason } =
    Promise.withResolvers<FinishReason>();

  const reasoningMessages: ReasoningOutput[] = [];
  const finalResponsesAccu: ModelMessage[] = [];
  const { promise: finalResponses, resolve: resolveFinalResponses } =
    Promise.withResolvers<{ messages: ModelMessage[] }>();
  const { promise: reasoning, resolve: resolveReasoning } =
    Promise.withResolvers<ReasoningOutput[]>();
  const { promise: warnings, resolve: resolveWarnings } = Promise.withResolvers<
    CallWarning[] | undefined
  >();

  if (messages.length === 0) {
    throw new Error(
      "streamTextWithCompatibleTools requires at least one message",
    );
  }

  let callSequence = 0;
  const generateCallId = () => `${toolCallIdPrefix}-${++callSequence}`;
  const accumulatedWarnings: CallWarning[] = [];
  const textStreamOut = async function* () {
    let lastEmittedChar = "";
    let pendingBoundarySeparator = false;

    while (true) {
      const { textStream, finishReason, response, reasoning, warnings } =
        streamText({
          ...rest,
          messages: [compatibleSystemPrompt, ...messages],
          prompt: undefined,
          tools: undefined,
        });

      let buffer = "";
      let toolMatch: RegExpExecArray | null = null;
      let inToolCall = false;
      let carryOver = "";
      for await (const chunk of textStream) {
        if (inToolCall) {
          buffer += chunk;
        } else if (maybeToolCallStart(chunk) && !toolMatch) {
          inToolCall = true;
          buffer = chunk;
        } else {
          if (pendingBoundarySeparator) {
            const sep = maybeYieldBoundarySeparator(lastEmittedChar, chunk);
            if (sep) {
              yield sep;
              lastEmittedChar = sep.at(-1) ?? lastEmittedChar;
            }
            pendingBoundarySeparator = false;
          }

          yield chunk;
          lastEmittedChar = chunk.at(-1) ?? lastEmittedChar;
          continue;
        }

        if (inToolCall && maybeToolCallEnd(buffer)) {
          const match = buffer.match(TOOL_CALL_SINGLE);
          if (match) {
            const full = match[0];
            const idx = buffer.indexOf(full);
            const endIdx = idx + full.length;
            carryOver = buffer.slice(endIdx);

            toolMatch = [
              full,
              match[1],
              match[2],
            ] as unknown as RegExpExecArray;
          } else {
            yield buffer;
          }
          buffer = "";
          inToolCall = false;
        }
      }

      if (!toolMatch && buffer) {
        if (inToolCall) yield buffer;
        buffer = "";
        inToolCall = false;
      }

      const { messages: respMessages } = await response;
      messages.push(...respMessages);
      finalResponsesAccu.push(...respMessages);
      reasoningMessages.push(...(await reasoning));
      accumulatedWarnings.push(...((await warnings) || []));

      // If the model just asked to call a tool, the next assistant phase will be
      // produced in a subsequent streamText() call. Mark a boundary so we can
      // avoid concatenating markdown tokens across the seam.
      if (toolMatch) pendingBoundarySeparator = true;

      const [, toolName, payload] = toolMatch ?? [];
      const tool = toolName && tools?.[toolName];
      if (!toolName || !tool || !tool.execute) {
        resolveReasoning(reasoningMessages);
        resolveWarnings(
          accumulatedWarnings.length ? accumulatedWarnings : undefined,
        );
        resolveFinishReason(await finishReason);

        if (carryOver) {
          yield carryOver;
          carryOver = "";
        }
        resolveFinalResponses({ messages: finalResponsesAccu });
        break;
      }

      logger.logInfo(`Calling tool in compatible mode: ${toolName}`);

      // call tool
      const callId = generateCallId();
      try {
        const toolResult: unknown = await tool.execute(tryParseJson(payload), {
          toolCallId: callId,
          messages: respMessages,
        });

        const msg: ModelMessage = {
          role: "assistant",
          content: JSON.stringify([
            {
              type: "tool-result",
              toolCallId: callId,
              toolName,
              output: toToolResultOutput(toolResult),
            },
          ]),
        };
        messages.push(msg);
        finalResponsesAccu.push(msg);
      } catch (err) {
        const msg: ModelMessage = {
          role: "assistant",
          content: JSON.stringify([
            {
              type: "tool-result",
              toolCallId: callId,
              toolName,
              output: {
                type: "error-text",
                value: `Tool execution failed: ${String(err)}`,
              },
            },
          ]),
        };
        messages.push(msg);
        finalResponsesAccu.push(msg);
      }

      if (carryOver) {
        yield carryOver;
        carryOver = "";
      }
    }
  };

  return {
    textStream: textStreamOut(),
    finishReason,
    response: finalResponses,
    reasoning,
    warnings,
  };
}

function toToolResultOutput(output: unknown): ToolResultPart["output"] {
  if (typeof output === "string") return { type: "text", value: output };
  // treat undefined/null as empty text
  if (output === undefined || output === null)
    return { type: "text", value: "" };
  try {
    JSON.stringify(output);
    return { type: "json", value: output as JSONValue };
  } catch {
    return { type: "error-text", value: "Non-serializable tool output" };
  }
}

function tryParseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return trimmed;
  }
}
