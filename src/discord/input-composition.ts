import { asSchema, type LanguageModelUsage, type ModelMessage } from "ai";

import type { Config } from "../type";

const COMPATIBLE_TOOL_DEFS_PREFIX =
  "Important rule to call tools:\n" +
  '- If you want to call a tool, you MUST ONLY output the tool call syntax: <tool-call tool="{name}">{payload}</tool-call>\n' +
  "- Examples:\n" +
  '  - <tool-call tool="fetch">{\"url\":\"https://example.com\",\"max_length\":10000,\"raw\":false}</tool-call>\n' +
  '  - <tool-call tool="eval">{\"code\":\"print(\\\'Hello World\\\')\"}</tool-call>\n' +
  "\nAvailable tools:\n";

export type StatsForNerdsOptions = {
  enabled: boolean;
  verbose: boolean;
};

export function getStatsForNerdsOptions(
  statsForNerds: Config["stats_for_nerds"],
): StatsForNerdsOptions {
  if (statsForNerds === true) return { enabled: true, verbose: false };
  if (statsForNerds && typeof statsForNerds === "object") {
    return { enabled: true, verbose: statsForNerds.verbose === true };
  }
  return { enabled: false, verbose: false };
}

type InputCompositionChars = {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolDefsChars: number;
  toolResultChars: number;
  callCount: number;
};

type ToolsLike = Record<string, { description?: string; inputSchema?: unknown }>;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getToolDefsText(tools: ToolsLike | null, pretty: boolean): string {
  if (!tools) return "";
  const entries = Object.entries(tools);
  if (entries.length === 0) return "";

  const toolDesc = entries.map(([name, tool]) => {
    let jsonSchema: unknown = {};
    try {
      jsonSchema = asSchema(tool?.inputSchema as any).jsonSchema;
    } catch {
      jsonSchema = {};
    }
    return {
      name,
      description: tool?.description ?? "",
      jsonSchema,
    };
  });

  return pretty
    ? JSON.stringify(toolDesc, null, 2)
    : JSON.stringify(toolDesc);
}

function isAssistantToolCallMessage(message: ModelMessage): boolean {
  if (message.role !== "assistant") return false;
  if (!Array.isArray(message.content)) return false;

  return message.content.some((part) => {
    return Boolean(part && typeof part === "object" && "type" in part)
      ? (part as any).type === "tool-call"
      : false;
  });
}

function isCompatibleToolResultMessage(message: ModelMessage): boolean {
  if (message.role !== "assistant") return false;
  if (typeof message.content !== "string") return false;

  const raw = message.content.trim();
  if (!raw.startsWith("[")) return false;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    return parsed.some(
      (item) =>
        item &&
        typeof item === "object" &&
        "type" in item &&
        (item as any).type === "tool-result",
    );
  } catch {
    return false;
  }
}

function countCharsInMessage(message: ModelMessage): Omit<InputCompositionChars, "toolDefsChars" | "callCount"> {
  let systemChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolResultChars = 0;

  const role = message.role;

  if (role === "tool") {
    toolResultChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "system") {
    systemChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "user") {
    userChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "assistant") {
    if (isCompatibleToolResultMessage(message)) {
      toolResultChars += safeStringify(message.content).length;
      return { systemChars, assistantChars, userChars, toolResultChars };
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const t = (part as any).type;
        if (t === "tool-result") {
          toolResultChars += safeStringify(part).length;
          continue;
        }
        assistantChars += safeStringify(part).length;
      }
      return { systemChars, assistantChars, userChars, toolResultChars };
    }

    assistantChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  // Unknown role; treat as assistant-ish overhead.
  assistantChars += safeStringify((message as any).content).length;
  return { systemChars, assistantChars, userChars, toolResultChars };
}

function buildPromptSnapshots(params: {
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  compatibleMode: boolean;
}): ModelMessage[][] {
  const { initialMessages, responseMessages, compatibleMode } = params;

  const snapshots: ModelMessage[][] = [];
  const state: ModelMessage[] = [...initialMessages];
  snapshots.push([...state]);

  for (let i = 0; i < responseMessages.length; i++) {
    const msg = responseMessages[i];
    if (!msg) continue;

    if (!compatibleMode && isAssistantToolCallMessage(msg)) {
      state.push(msg);

      // In tool mode, tool results come in as `role: "tool"` messages.
      let j = i + 1;
      while (j < responseMessages.length) {
        const next = responseMessages[j];
        if (!next || next.role !== "tool") break;
        state.push(next);
        j++;
      }

      snapshots.push([...state]);
      i = j - 1;
      continue;
    }

    state.push(msg);

    // Compatible mode: the wrapper "tool-result" message is an assistant message
    // emitted *after* tool execution, right before the next model call.
    if (compatibleMode && isCompatibleToolResultMessage(msg)) {
      snapshots.push([...state]);
    }
  }

  return snapshots;
}

export function estimateInputCompositionChars(input: {
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  tools: unknown;
  compatibleMode: boolean;
}): InputCompositionChars {
  const tools = (input.tools && typeof input.tools === "object"
    ? (input.tools as ToolsLike)
    : null) satisfies ToolsLike | null;

  const snapshots = buildPromptSnapshots({
    initialMessages: input.initialMessages,
    responseMessages: input.responseMessages,
    compatibleMode: input.compatibleMode,
  });

  const toolDefsText = getToolDefsText(tools, input.compatibleMode);
  const perCallToolDefsChars = toolDefsText.length;
  const perCallCompatibleSystemOverhead = input.compatibleMode
    ? COMPATIBLE_TOOL_DEFS_PREFIX.length
    : 0;

  let systemChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolResultChars = 0;

  for (const snapshot of snapshots) {
    systemChars += perCallCompatibleSystemOverhead;

    for (const message of snapshot) {
      const counts = countCharsInMessage(message);
      systemChars += counts.systemChars;
      assistantChars += counts.assistantChars;
      userChars += counts.userChars;
      toolResultChars += counts.toolResultChars;
    }
  }

  return {
    systemChars,
    assistantChars,
    userChars,
    toolDefsChars: perCallToolDefsChars * snapshots.length,
    toolResultChars,
    callCount: snapshots.length,
  };
}

function computePercentages(chars: {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolDefsChars: number;
  toolResultChars: number;
}): { S: number; A: number; U: number; TD: number; TR: number } | null {
  const entries = [
    ["S", chars.systemChars],
    ["A", chars.assistantChars],
    ["U", chars.userChars],
    ["TD", chars.toolDefsChars],
    ["TR", chars.toolResultChars],
  ] as const;

  const total = entries.reduce((acc, [, v]) => acc + v, 0);
  if (total <= 0) return null;

  const raw = entries.map(([k, v]) => {
    const pct = Math.round((v * 100) / total);
    return { k, v, pct };
  });

  let sum = raw.reduce((acc, e) => acc + e.pct, 0);
  const diff = 100 - sum;
  if (diff !== 0) {
    let maxIdx = 0;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i]!.v > raw[maxIdx]!.v) maxIdx = i;
    }
    raw[maxIdx]!.pct += diff;
    sum += diff;
  }

  // Defensive clamp.
  const map = Object.fromEntries(
    raw.map((e) => [e.k, Math.max(0, Math.min(100, e.pct))]),
  ) as { S: number; A: number; U: number; TD: number; TR: number };

  return map;
}

export function buildInputCompositionLine(input: {
  statsForNerds: Config["stats_for_nerds"];
  totalUsage: LanguageModelUsage | null;
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  tools: unknown;
  compatibleMode: boolean;
}): string | null {
  const stats = getStatsForNerdsOptions(input.statsForNerds);
  if (!stats.enabled || !stats.verbose) return null;

  const inputTokens = input.totalUsage?.inputTokens;
  if (typeof inputTokens !== "number" || inputTokens <= 0) return null;

  const chars = estimateInputCompositionChars({
    initialMessages: input.initialMessages,
    responseMessages: input.responseMessages,
    tools: input.tools,
    compatibleMode: input.compatibleMode,
  });

  const pct = computePercentages(chars);
  if (!pct) return null;

  return `[IC] S: ${pct.S}%; A: ${pct.A}%; U: ${pct.U}%; TD: ${pct.TD}%; TR: ${pct.TR}%`;
}
