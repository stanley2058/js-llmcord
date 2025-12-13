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

/**
 * Get zones where splitting would break markdown syntax
 * (inside ** markers, `` markers, etc.)
 */
function getUnsafeZones(
  node: Root | RootContent | PhrasingContent,
  zones: UnsafeZone[] = [],
): UnsafeZone[] {
  if (!("position" in node) || !node.position) return zones;

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
    case "code":
      // Entire fenced code block is unsafe to split
      zones.push({ start, end });
      break;
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
      getUnsafeZones(child as RootContent | PhrasingContent, zones);
    }
  }

  return zones;
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
  
  const zones = getUnsafeZones(tree);

  // Walk backwards from target to find safe point
  for (let i = target; i >= Math.max(0, target - maxBacktrack); i--) {
    if (isPositionSafe(i, zones)) {
      return i;
    }
  }

  // If nothing found backwards, try forwards (reluctantly)
  for (let i = target + 1; i < Math.min(source.length, target + maxBacktrack); i++) {
    if (isPositionSafe(i, zones)) {
      return i;
    }
  }

  // Last resort: use target anyway
  return target;
}
