import type { ModelMessage, Tool } from "ai";
import type { ILogger } from "../logger";

export type AnthropicCacheControl = {
  type: "ephemeral";
  ttl?: string;
};

export function getAnthropicCacheControlFromModelConfig(
  modelConfig: Record<string, unknown> | undefined,
): AnthropicCacheControl | null {
  if (!modelConfig) return null;
  if (modelConfig.anthropic_cache_control !== true) return null;

  const ttl =
    typeof modelConfig.anthropic_cache_ttl === "string"
      ? modelConfig.anthropic_cache_ttl
      : undefined;

  return ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
}

const DEFAULT_AI_GATEWAY_ORDER = ["anthropic", "vertex", "bedrock"] as const;

export function getAiGatewayOrderFromModelConfig(
  modelConfig: Record<string, unknown> | undefined,
): Array<(typeof DEFAULT_AI_GATEWAY_ORDER)[number]> {
  const configured = modelConfig?.ai_gateway_order;
  if (!configured) return [...DEFAULT_AI_GATEWAY_ORDER];

  if (!Array.isArray(configured)) {
    throw new Error("models.*.ai_gateway_order must be an array");
  }

  if (configured.length === 0) {
    throw new Error(
      "models.*.ai_gateway_order cannot be empty; provide an order or omit it",
    );
  }

  for (const v of configured) {
    if (v !== "anthropic" && v !== "vertex" && v !== "bedrock") {
      throw new Error(
        `models.*.ai_gateway_order contains invalid value: ${String(v)}`,
      );
    }
  }

  return configured as Array<(typeof DEFAULT_AI_GATEWAY_ORDER)[number]>;
}

export function withAnthropicToolCacheControl(
  tools: Record<string, Tool> | undefined,
  cacheControl: AnthropicCacheControl | null,
): Record<string, Tool> | undefined {
  if (!tools || !cacheControl) return tools;

  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const toolWithOptions = tool;
    const providerOptions = {
      ...(toolWithOptions.providerOptions ?? {}),
      anthropic: {
        ...(toolWithOptions.providerOptions?.anthropic ?? {}),
        cacheControl,
      },
    };

    out[name] = { ...toolWithOptions, providerOptions };
  }

  return out;
}

export function withAnthropicMessageCacheControl(
  message: ModelMessage,
  cacheControl: AnthropicCacheControl | null,
): ModelMessage {
  if (!cacheControl) return message;

  const existing = message.providerOptions;

  return {
    ...message,
    providerOptions: {
      ...(existing ?? {}),
      anthropic: {
        ...(existing?.anthropic ?? {}),
        cacheControl,
      },
    },
  };
}

function systemMessageContentToString(message: ModelMessage): string {
  const content = message.content as unknown;

  if (typeof content === "string") return content;

  // System messages should typically be strings, but be defensive.
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .filter(Boolean)
      .join("");
  }

  return String(content ?? "");
}

export function collapseLeadingSystemMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  const firstNonSystemIndex = messages.findIndex((m) => m.role !== "system");
  const systemSlice =
    firstNonSystemIndex === -1
      ? messages
      : messages.slice(0, firstNonSystemIndex);

  if (systemSlice.length <= 1) return messages;

  const mergedProviderOptions = mergeProviderOptions(
    ...systemSlice.map(
      (m) =>
        (m as unknown as { providerOptions?: Record<string, unknown> })
          .providerOptions,
    ),
  );

  const combined = systemSlice
    .map((m) => systemMessageContentToString(m))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");

  const collapsed: ModelMessage = {
    role: "system",
    content: combined,
    providerOptions:
      mergedProviderOptions as unknown as ModelMessage["providerOptions"],
  };

  const rest =
    firstNonSystemIndex === -1 ? [] : messages.slice(firstNonSystemIndex);
  return [collapsed, ...rest];
}

export function withAnthropicLeadingSystemCacheControl(
  messages: ModelMessage[],
  cacheControl: AnthropicCacheControl | null,
): ModelMessage[] {
  if (!cacheControl) return messages;

  const firstNonSystemIndex = messages.findIndex((m) => m.role !== "system");
  const systemCount =
    firstNonSystemIndex === -1 ? messages.length : firstNonSystemIndex;
  if (systemCount === 0) return messages;

  // Cache only the first system message to keep cache breakpoints low.
  const first = messages[0]!;
  if (first.role !== "system") return messages;

  const patchedFirst = withAnthropicMessageCacheControl(first, cacheControl);
  return [patchedFirst, ...messages.slice(1)];
}

export function withAnthropicToolCacheControlLimit(
  tools: Record<string, Tool> | undefined,
  cacheControl: AnthropicCacheControl | null,
  limit: number,
  logger?: ILogger,
): Record<string, Tool> | undefined {
  if (!tools || !cacheControl) return tools;
  if (!Number.isFinite(limit) || limit < 0) return tools;

  const entries = Object.entries(tools).sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, Tool> = {};

  let patched = 0;
  for (const [name, tool] of entries) {
    if (patched < limit) {
      out[name] = (
        withAnthropicToolCacheControl({ [name]: tool }, cacheControl) as Record<
          string,
          Tool
        >
      )[name]!;
      patched++;
    } else {
      out[name] = tool;
    }
  }

  if (logger && entries.length > limit) {
    logger.logWarn(
      `Anthropic cache enabled; limiting cached tools to ${limit} (of ${entries.length})`,
    );
  }

  return out;
}

/**
 * Backwards-compatible: previously patched every system message.
 * Now we collapse leading system messages and cache only the first.
 */
export function withAnthropicSystemMessageCacheControl(
  messages: ModelMessage[],
  cacheControl: AnthropicCacheControl | null,
): ModelMessage[] {
  if (!cacheControl) return messages;
  const collapsed = collapseLeadingSystemMessages(messages);
  return withAnthropicLeadingSystemCacheControl(collapsed, cacheControl);
}

export function validateAnthropicCacheControlCoverage(
  messages: ModelMessage[],
  cacheControl: AnthropicCacheControl | null,
  logger: ILogger,
  context: {
    providerModel: string;
    toolMode: string;
  },
) {
  if (!cacheControl) return;

  const firstNonSystemIndex = messages.findIndex((m) => m.role !== "system");
  const systemSlice =
    firstNonSystemIndex === -1
      ? messages
      : messages.slice(0, firstNonSystemIndex);

  if (systemSlice.length === 0) {
    logger.logError(
      "Anthropic cache enabled but no system messages exist",
      context,
    );
    return;
  }

  // We allow multiple system messages (e.g. code-execution prepends one),
  // but we require that EACH leading system message is cache-marked.
  // This makes it easy to debug missing patching without being too strict.
  const missing: number[] = [];
  for (let i = 0; i < systemSlice.length; i++) {
    const msg = systemSlice[i]!;
    const cc = (
      msg as unknown as {
        providerOptions?: { anthropic?: { cacheControl?: unknown } };
      }
    ).providerOptions?.anthropic?.cacheControl;

    if (!cc) missing.push(i);
  }

  if (missing.length > 0) {
    logger.logError(
      "Anthropic cache enabled but some leading system messages lack cacheControl",
      {
        ...context,
        missingSystemMessageIndexes: missing,
        totalSystemMessages: systemSlice.length,
      },
    );
  }
}

export function mergeProviderOptions(
  ...parts: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) {
      if (v == null) continue;
      // Shallow merge only; nested objects are expected to be provider-scoped.
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function insertSystemMessageAfterLastSystem(
  messages: ModelMessage[],
  systemMessage: ModelMessage,
): ModelMessage[] {
  const out: ModelMessage[] = [...messages];
  const lastSystemIndex = out.findLastIndex((m) => m.role === "system");
  out.splice(lastSystemIndex + 1, 0, systemMessage);
  return out;
}
