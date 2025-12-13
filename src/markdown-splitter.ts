import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";

/**
 * Represents a zone in the source text where splitting would break syntax
 */
interface UnsafeZone {
  start: number;
  end: number;
}

interface CodeFenceRange {
  start: number;
  end: number;
  contentStart: number;
}

/**
 * Get zones where splitting would break markdown syntax
 * (inside ** markers, `` markers, etc.)
 */
function getUnsafeZones(
  node: Root | RootContent | PhrasingContent,
  zones: UnsafeZone[] = [],
  codeFences: CodeFenceRange[] = [],
): { zones: UnsafeZone[]; codeFences: CodeFenceRange[] } {
  if (!("position" in node) || !node.position) {
    return { zones, codeFences };
  }

  const start = node.position.start.offset ?? 0;
  const end = node.position.end.offset ?? 0;

  switch (node.type) {
    case "strong":
      // ** at start and end
      zones.push({ start, end: start + 2 });
      zones.push({ start: end - 2, end });
      break;
    case "emphasis":
      // * or _ at start and end
      zones.push({ start, end: start + 1 });
      zones.push({ start: end - 1, end });
      break;
    case "delete":
      // ~~ at start and end
      zones.push({ start, end: start + 2 });
      zones.push({ start: end - 2, end });
      break;
    case "inlineCode":
      // ` at start and end (could be multiple)
      zones.push({ start, end: start + 1 });
      zones.push({ start: end - 1, end });
      break;
    case "code": {
      // Allow splitting *inside* fenced code blocks.
      // We close + reopen fences at chunk boundaries, so the content is safe,
      // but the fence markers themselves are not.
      const fenceSize = 3;
      zones.push({ start, end: Math.min(end, start + fenceSize) });
      zones.push({ start: Math.max(start, end - fenceSize), end });

      // Record fenced code ranges so we can apply code-specific splitting rules
      // (eg. only split on line boundaries).
      const lang = (node.lang || "").trim();
      const openerLength = 3 + lang.length; // ``` + lang
      const contentStart = Math.min(end, start + openerLength + 1); // plus newline
      codeFences.push({ start, end, contentStart });
      break;
    }
    case "link":
    case "image":
      // Entire link/image is unsafe
      zones.push({ start, end });
      break;
    case "html":
      // HTML blocks are unsafe
      zones.push({ start, end });
      break;
  }

  if ("children" in node && node.children) {
    for (const child of node.children) {
      getUnsafeZones(child as RootContent | PhrasingContent, zones, codeFences);
    }
  }

  return { zones, codeFences };
}

/**
 * Check if a position is inside any unsafe zone
 */
function isPositionSafe(pos: number, zones: UnsafeZone[]): boolean {
  for (const zone of zones) {
    if (pos > zone.start && pos < zone.end) {
      return false;
    }
  }
  return true;
}

/**
 * Find a safe split point at or before the target position.
 * Uses binary search starting from target and walking backwards.
 * 
 * @param source - The markdown source text
 * @param target - The target split position (e.g., maxLength)
 * @param maxBacktrack - Maximum characters to backtrack before giving up
 * @returns A safe position to split at
 */
export function findSafeSplitPoint(
  source: string,
  target: number,
  maxBacktrack: number = 100,
): number {
  // Clamp target to valid range
  target = Math.min(target, source.length);

  // If source is short enough, no split needed
  if (target >= source.length) {
    return source.length;
  }

  // Parse to get AST
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const { zones } = getUnsafeZones(tree);


  // Walk backwards from target to find safe point
  for (let i = target; i >= Math.max(0, target - maxBacktrack); i--) {
    if (isPositionSafe(i, zones)) {
      return i;
    }
  }

  // If nothing found backwards, try forwards (reluctantly)
  for (
    let i = target + 1;
    i < Math.min(source.length, target + maxBacktrack);
    i++
  ) {
    if (isPositionSafe(i, zones)) {
      return i;
    }
  }

  // Last resort: use target anyway
  return target;
}

export interface LexicalSplitOptions {
  /**
   * Maximum characters to backtrack to find a preferred split.
   * (Also used as a small forward-search window when necessary.)
   */
  maxBacktrack?: number;

  /** Prefer splitting on a newline if within this many chars. */
  newlineBacktrack?: number;

  /** Locale passed to Intl.Segmenter. */
  locale?: string;
}

function findPreferredBoundaryInWindow(
  source: string,
  target: number,
  zones: UnsafeZone[],
  codeFences: CodeFenceRange[],
  { maxBacktrack, newlineBacktrack, locale }: Required<LexicalSplitOptions>,
): number | null {
  const safeTarget = Math.min(target, source.length);
  const start = Math.max(0, safeTarget - maxBacktrack);

  const activeFence = codeFences.find(
    (f) => safeTarget > f.contentStart && safeTarget < f.end,
  );

  // If we're inside a fenced code block, treat a *line* as the smallest
  // splittable unit: only split right after a newline.
  if (activeFence) {
    // Ignore the newline that ends the fence header. Splitting there produces an
    // empty code block and can cause zero-progress loops when we reopen fences.
    const minPos = Math.max(activeFence.contentStart + 1, start);

    for (let i = safeTarget; i >= minPos; i--) {
      if (!isPositionSafe(i, zones)) continue;
      if (source[i - 1] === "\n") return i;
    }

    return null;
  }

  // 1) Prefer newline boundaries ("paragraph-ish") if they are close.
  const newlineStart = Math.max(0, safeTarget - newlineBacktrack);
  for (let i = safeTarget; i >= newlineStart; i--) {
    if (i <= 0) continue;
    if (!isPositionSafe(i, zones)) continue;

    // Split right AFTER a newline.
    if (source[i - 1] === "\n") {
      return i;
    }
  }

  // 2) Prefer whitespace boundaries.
  // We split after whitespace so the next chunk starts at a word.
  for (let i = safeTarget; i >= start; i--) {
    if (i <= 0) continue;
    if (!isPositionSafe(i, zones)) continue;

    if (/\s/u.test(source[i - 1] ?? "")) {
      return i;
    }
  }

  // 3) Locale-based word segmentation fallback.
  // Use a small window to avoid segmenting very long strings repeatedly.
  const window = source.slice(start, safeTarget);
  if (window.length > 0 && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(locale, { granularity: "word" });

    // Track the last word boundary that is safe.
    let best: number | null = null;
    for (const seg of segmenter.segment(window)) {
      const boundary = start + seg.index + seg.segment.length;
      if (boundary <= start || boundary > safeTarget) continue;
      if (!isPositionSafe(boundary, zones)) continue;

      if (seg.isWordLike) {
        best = boundary;
      }
    }
    if (best !== null) return best;
  }

  return null;
}

/**
 * Find a markdown-safe split point that also prefers lexical boundaries.
 *
 * Preference order:
 * 1) Newline boundary within `newlineBacktrack`
 * 2) Whitespace boundary within `maxBacktrack`
 * 3) Intl.Segmenter word boundary within `maxBacktrack`
 * 4) Fallback to the closest markdown-safe split (findSafeSplitPoint)
 */
export function findLexicalSafeSplitPoint(
  source: string,
  target: number,
  options: LexicalSplitOptions = {},
): number {
  const maxBacktrack = options.maxBacktrack ?? 100;
  const newlineBacktrack = options.newlineBacktrack ?? 100;
  const locale = options.locale ?? "en-US";

  target = Math.min(target, source.length);

  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const { zones, codeFences } = getUnsafeZones(tree);

  // First get the closest safe split as an upper bound.
  const baseSafe = (() => {
    for (let i = target; i >= Math.max(0, target - maxBacktrack); i--) {
      if (isPositionSafe(i, zones)) return i;
    }
    for (
      let i = target + 1;
      i < Math.min(source.length, target + maxBacktrack);
      i++
    ) {
      if (isPositionSafe(i, zones)) return i;
    }
    return target;
  })();

  const preferred = findPreferredBoundaryInWindow(source, baseSafe, zones, codeFences, {
    maxBacktrack,
    newlineBacktrack,
    locale,
  });

  return preferred ?? baseSafe;
}
