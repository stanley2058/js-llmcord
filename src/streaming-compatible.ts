import {
  streamText,
  type FinishReason,
  type JSONValue,
  type ModelMessage,
  type ToolResultPart,
} from "ai";
import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type StreamTextParams = Parameters<typeof streamText>[0];
export type StreamTextResult = Awaited<ReturnType<typeof streamText>>;
type ResponseMessage = Awaited<
  StreamTextResult["response"]
>["messages"][number];

// Tool syntax: <tool-call tool="{name}">{payload}</tool-call>

const TOOL_CALL_PATTERN =
  /<tool-call\s+tool="([^"]+)">([\s\S]*?)<\/tool-call>/g;
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
export function streamTextWithCompatibleTools({
  tools,
  messages,
  ...rest
}: StreamTextParams) {
  messages = [...(messages || [])];

  const toolDesc = Object.entries((tools = tools || {})).map(([name, tool]) => {
    const jsonSchema = zodToJsonSchema(tool.inputSchema as ZodType);
    return {
      name,
      description: tool.description,
      jsonSchema,
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

  const finalResponsesAccu: ResponseMessage[] = [];
  const { promise: finalResponses, resolve: resolveFinalResponses } =
    Promise.withResolvers<{ messages: ResponseMessage[] }>();

  if (messages.length === 0) {
    throw new Error(
      "streamTextWithCompatibleTools requires at least one message",
    );
  }

  let callSequence = 0;
  const generateCallId = () => `${toolCallIdPrefix}-${++callSequence}`;
  const textStreamOut = async function* () {
    while (true) {
      const { textStream, finishReason, response } = streamText({
        ...rest,
        messages: [compatibleSystemPrompt, ...messages],
        prompt: undefined,
        tools: undefined,
      });

      let buffer = "";
      let toolMatch: RegExpExecArray | null = null;
      for await (const chunk of textStream) {
        if (maybeToolCallStart(buffer || chunk)) {
          buffer += chunk;
          continue;
        } else {
          buffer = "";
        }
        if (maybeToolCallEnd(buffer)) {
          toolMatch = TOOL_CALL_PATTERN.exec(buffer);
          buffer = "";
          continue;
        }

        yield chunk;
      }

      const [, toolName, payload] = toolMatch ?? [];
      const tool = toolName && tools?.[toolName];
      if (!toolName || !tool || !tool.execute) {
        resolveFinishReason(await finishReason);
        resolveFinalResponses({ messages: finalResponsesAccu });
        break;
      }

      // call tool
      const callId = generateCallId();
      const { messages: respMessages } = await response;
      messages.push(...respMessages);
      finalResponsesAccu.push(...respMessages);

      try {
        const toolResult: unknown = await tool.execute(tryParseJson(payload), {
          toolCallId: callId,
          messages: respMessages,
        });

        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: callId,
              toolName,
              output: toToolResultOutput(toolResult),
            },
          ],
        });
      } catch (err) {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: callId,
              toolName,
              output: {
                type: "error-text",
                value: `Tool execution failed: ${String(err)}`,
              },
            },
          ],
        });
      }
    }
  };

  return {
    textStream: textStreamOut(),
    finishReason,
    response: finalResponses,
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
