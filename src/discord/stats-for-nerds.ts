import type { LanguageModelUsage } from "ai";

function formatNumber(v: number): string {
  return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
}

function toFixedIfNumber(v: number | null, digits: number): string | null {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : null;
}

function lastPathSegment(providerModel: string): string {
  const clean = providerModel.replace(/:vision$/i, "");
  const lastSlash = clean.lastIndexOf("/");
  return lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
}

export function buildStatsForNerdsLogLine(input: {
  providerModel: string;
  totalUsage: LanguageModelUsage | null;
  ttftSeconds: number | null;
  totalSeconds: number | null;
}): string {
  const { model, tokenParts, ttft, tps } = buildStatsForNerds(input);
  const parts: string[] = [`[M]: ${model}`];
  parts.push(`[T]: ${tokenParts.join(" ")}`);
  if (ttft !== null) parts.push(`[TTFT]: ${ttft}s`);
  if (tps !== null) parts.push(`[TPS]: ${tps}`);

  return parts.join("; ");
}

export function buildStatsForNerdsField(input: {
  providerModel: string;
  totalUsage: LanguageModelUsage | null;
  ttftSeconds: number | null;
  totalSeconds: number | null;
}): { name: string; value: string; inline: false } | null {
  const { model, tokenParts, ttft, tps } = buildStatsForNerds(input);
  const parts: string[] = [`[M]: ${model}`];
  parts.push(`[T]: ${tokenParts.join(" ")}`);
  if (ttft !== null) parts.push(`[TTFT]: ${ttft}s`);
  if (tps !== null) parts.push(`[TPS]: ${tps}`);

  if (parts.length <= 1) return null;

  let value = `*${parts.join("; ")}*`;
  if (value.length > 1024) value = value.slice(0, 1021) + "...*";
  return { name: " ", value, inline: false };
}

function buildStatsForNerds({
  providerModel,
  totalUsage,
  ttftSeconds,
  totalSeconds,
}: {
  providerModel: string;
  totalUsage: LanguageModelUsage | null;
  ttftSeconds: number | null;
  totalSeconds: number | null;
}) {
  const model = lastPathSegment(providerModel);

  const inputTokens = totalUsage?.inputTokens;
  const { cacheReadTokens, cacheWriteTokens, noCacheTokens } =
    totalUsage?.inputTokenDetails ?? {};
  const outputTokens = totalUsage?.outputTokens;
  const { reasoningTokens } = totalUsage?.outputTokenDetails ?? {};

  const tokenParts: string[] = [];
  if (typeof inputTokens === "number") {
    const cachedNotes: string[] = [];
    if (cacheReadTokens) {
      cachedNotes.push(`CR: ${formatNumber(cacheReadTokens)}`);
    }
    if (cacheWriteTokens) {
      cachedNotes.push(`CW: ${formatNumber(cacheWriteTokens)}`);
    }
    if (noCacheTokens) {
      cachedNotes.push(`NC: ${formatNumber(noCacheTokens)}`);
    }

    const cachedNote = cachedNotes.length ? ` (${cachedNotes.join("; ")})` : "";
    tokenParts.push(`↑${formatNumber(inputTokens)}${cachedNote}`);
  }
  if (typeof outputTokens === "number") {
    const reasoningNote =
      typeof reasoningTokens === "number"
        ? ` (R: ${formatNumber(reasoningTokens)})`
        : "";
    tokenParts.push(`↓${formatNumber(outputTokens)}${reasoningNote}`);
  }

  const ttft = toFixedIfNumber(ttftSeconds, 1);

  const totalOutputTokens =
    (typeof outputTokens === "number" ? outputTokens : 0) +
    (typeof reasoningTokens === "number" ? reasoningTokens : 0);
  const tps =
    totalOutputTokens > 0 &&
    typeof totalSeconds === "number" &&
    totalSeconds > 0
      ? totalOutputTokens / totalSeconds
      : null;
  const tpsFixed = toFixedIfNumber(tps, 1);

  return {
    model,
    tokenParts,
    ttft,
    tps: tpsFixed,
  };
}
