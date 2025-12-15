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

export function buildStatsForNerdsLogLine({
  providerModel,
  totalUsage,
  ttftSeconds,
  outputSeconds,
}: {
  providerModel: string;
  totalUsage: LanguageModelUsage | null;
  ttftSeconds: number | null;
  outputSeconds: number | null;
}): string {
  const model = lastPathSegment(providerModel);

  const inputTokens = totalUsage?.inputTokens;
  const cachedInputTokens = totalUsage?.cachedInputTokens;
  const outputTokens = totalUsage?.outputTokens;
  const reasoningTokens = totalUsage?.reasoningTokens;

  const parts: string[] = [`[M]: ${model}`];

  const tokenParts: string[] = [];
  if (typeof inputTokens === "number") {
    const cachedNote =
      typeof cachedInputTokens === "number"
        ? ` (C: ${formatNumber(cachedInputTokens)})`
        : "";
    tokenParts.push(`↑${formatNumber(inputTokens)}${cachedNote}`);
  }
  if (typeof outputTokens === "number") {
    const reasoningNote =
      typeof reasoningTokens === "number"
        ? ` (R: ${formatNumber(reasoningTokens)})`
        : "";
    tokenParts.push(`↓${formatNumber(outputTokens)}${reasoningNote}`);
  }
  if (tokenParts.length) {
    parts.push(`[T]: ${tokenParts.join(" ")}`);
  }

  const ttft = toFixedIfNumber(ttftSeconds, 1);
  if (ttft !== null) parts.push(`[TTFT]: ${ttft}s`);

  const tps =
    typeof outputTokens === "number" &&
    typeof outputSeconds === "number" &&
    outputSeconds > 0
      ? outputTokens / outputSeconds
      : null;
  const tpsFixed = toFixedIfNumber(tps, 1);
  if (tpsFixed !== null) parts.push(`[TPS]: ${tpsFixed}`);

  return parts.join("; ");
}

export function buildStatsForNerdsField({
  providerModel,
  totalUsage,
  ttftSeconds,
  outputSeconds,
}: {
  providerModel: string;
  totalUsage: LanguageModelUsage | null;
  ttftSeconds: number | null;
  outputSeconds: number | null;
}): { name: string; value: string; inline: false } | null {
  const model = lastPathSegment(providerModel);

  const inputTokens = totalUsage?.inputTokens;
  const cachedInputTokens = totalUsage?.cachedInputTokens;
  const outputTokens = totalUsage?.outputTokens;
  const reasoningTokens = totalUsage?.reasoningTokens;

  const parts: string[] = [`[M]: ${model}`];

  const tokenParts: string[] = [];
  if (typeof inputTokens === "number") {
    const cachedNote =
      typeof cachedInputTokens === "number"
        ? ` (C: ${formatNumber(cachedInputTokens)})`
        : "";
    tokenParts.push(`↑${formatNumber(inputTokens)}${cachedNote}`);
  }
  if (typeof outputTokens === "number") {
    const reasoningNote =
      typeof reasoningTokens === "number"
        ? ` (R: ${formatNumber(reasoningTokens)})`
        : "";
    tokenParts.push(`↓${formatNumber(outputTokens)}${reasoningNote}`);
  }
  if (tokenParts.length) {
    parts.push(`[T]: ${tokenParts.join(" ")}`);
  }

  const ttft = toFixedIfNumber(ttftSeconds, 1);
  if (ttft !== null) parts.push(`[TTFT]: ${ttft}s`);

  const tps =
    typeof outputTokens === "number" &&
    typeof outputSeconds === "number" &&
    outputSeconds > 0
      ? outputTokens / outputSeconds
      : null;
  const tpsFixed = toFixedIfNumber(tps, 1);
  if (tpsFixed !== null) parts.push(`[TPS]: ${tpsFixed}`);

  if (parts.length <= 1) return null;

  let value = `*${parts.join("; ")}*`;
  if (value.length > 1024) value = value.slice(0, 1021) + "...*";
  return { name: " ", value, inline: false };
}
