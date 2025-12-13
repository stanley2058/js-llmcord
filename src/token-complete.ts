import remend from "remend";

// Null character used as placeholder delimiter (won't appear in normal text)
const CODE_PLACEHOLDER = "\x00";

/**
 * Escapes code blocks before processing with remend.
 * This prevents remend from incorrectly interpreting asterisks inside code
 * as markdown formatting (e.g., `response.*` would otherwise get an extra `*`).
 *
 * Strategy:
 * - Closed code blocks: completely replace with placeholders (content hidden from remend)
 * - Unclosed code blocks: keep the opening marker visible so remend can close it,
 *   but hide the content
 */
function escapeCodeBlocks(text: string): {
  escaped: string;
  codeBlocks: Array<{
    type: "fence" | "inline";
    content: string;
    lang: string;
    closed: boolean;
  }>;
} {
  const codeBlocks: Array<{
    type: "fence" | "inline";
    content: string;
    lang: string;
    closed: boolean;
  }> = [];

  let result = text;

  // First handle triple backticks (code fences) - both closed and unclosed
  // Regex captures: optional language, optional newline, content, optional closing ```
  result = result.replace(
    /```(\w*)(\n?)([\s\S]*?)(```|$)/g,
    (match, lang, newline, content, closing) => {
      const idx = codeBlocks.length;
      const isClosed = closing === "```";
      codeBlocks.push({
        type: "fence",
        content,
        lang: lang || "",
        closed: isClosed,
      });

      if (isClosed) {
        // Closed: completely replace with placeholder (no backticks visible)
        return `${CODE_PLACEHOLDER}FENCE${idx}${CODE_PLACEHOLDER}`;
      } else {
        // Unclosed: keep ``` visible so remend can close it, hide content
        // Preserve original newline (or lack thereof) after language
        return `\`\`\`${lang}${newline}${CODE_PLACEHOLDER}FENCECONTENT${idx}${CODE_PLACEHOLDER}`;
      }
    },
  );

  // Then handle inline code (single backticks) - both closed and unclosed
  // Now safe because all ``` are replaced with placeholders
  result = result.replace(/`([^`\x00]+)(`|$)/g, (match, content, closing) => {
    const idx = codeBlocks.length;
    const isClosed = closing === "`";
    codeBlocks.push({ type: "inline", content, lang: "", closed: isClosed });

    if (isClosed) {
      // Closed: completely replace with placeholder
      return `${CODE_PLACEHOLDER}INLINE${idx}${CODE_PLACEHOLDER}`;
    } else {
      // Unclosed: keep ` visible so remend can close it, hide content
      return `\`${CODE_PLACEHOLDER}INLINECONTENT${idx}${CODE_PLACEHOLDER}`;
    }
  });

  return { escaped: result, codeBlocks };
}

/**
 * Restores code blocks from placeholders after remend processing.
 * Reconstructs the original markdown syntax including backticks.
 */
function restoreCodeBlocks(
  text: string,
  codeBlocks: Array<{
    type: "fence" | "inline";
    content: string;
    lang: string;
    closed: boolean;
  }>,
): string {
  let result = text;
  for (let i = 0; i < codeBlocks.length; i++) {
    const block = codeBlocks[i];
    if (!block) continue;

    if (block.type === "fence") {
      if (block.closed) {
        // Was completely replaced
        const placeholder = `${CODE_PLACEHOLDER}FENCE${i}${CODE_PLACEHOLDER}`;
        const langPart = block.lang ? block.lang + "\n" : "";
        const restored = "```" + langPart + block.content + "```";
        result = result.replace(placeholder, restored);
      } else {
        // Only content was replaced, ``` markers kept visible
        const placeholder = `${CODE_PLACEHOLDER}FENCECONTENT${i}${CODE_PLACEHOLDER}`;
        result = result.replace(placeholder, block.content);
      }
    } else {
      if (block.closed) {
        // Was completely replaced
        const placeholder = `${CODE_PLACEHOLDER}INLINE${i}${CODE_PLACEHOLDER}`;
        const restored = "`" + block.content + "`";
        result = result.replace(placeholder, restored);
      } else {
        // Only content was replaced, ` marker kept visible
        const placeholder = `${CODE_PLACEHOLDER}INLINECONTENT${i}${CODE_PLACEHOLDER}`;
        result = result.replace(placeholder, block.content);
      }
    }
  }
  return result;
}

/**
 * Wrapper around remend that properly handles code blocks.
 * remend doesn't understand that asterisks inside backticks should be ignored,
 * so we temporarily replace code blocks with placeholders before processing.
 */
function safeRemend(text: string): string {
  const { escaped, codeBlocks } = escapeCodeBlocks(text);
  const completed = remend(escaped);
  return restoreCodeBlocks(completed, codeBlocks);
}

/**
 * Detects which markdown tags were auto-closed by remend by comparing
 * the original input with the completed output.
 * Returns the opening tags that need to be prepended to continuation text.
 */
function detectClosedTags(original: string, completed: string): string[] {
  const openingTags: string[] = [];

  // Get the suffix that remend added
  const addedSuffix = completed.slice(original.length);
  if (!addedSuffix) return openingTags;

  // Parse the closing tags that were added (in reverse order for proper nesting)
  // remend adds closing tags in order, so we need to reverse for opening
  let remaining = addedSuffix;

  while (remaining.length > 0) {
    if (remaining.startsWith("***")) {
      openingTags.unshift("***");
      remaining = remaining.slice(3);
    } else if (remaining.startsWith("**")) {
      openingTags.unshift("**");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("__")) {
      openingTags.unshift("__");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("~~")) {
      openingTags.unshift("~~");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("$$")) {
      openingTags.unshift("$$");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("```")) {
      openingTags.unshift("```");
      remaining = remaining.slice(3);
    } else if (remaining.startsWith("`")) {
      openingTags.unshift("`");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("*")) {
      openingTags.unshift("*");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("_")) {
      openingTags.unshift("_");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("\n$$")) {
      // Block math closing with newline
      openingTags.unshift("$$");
      remaining = remaining.slice(3);
    } else {
      // Skip unknown characters (like newlines)
      remaining = remaining.slice(1);
    }
  }

  return openingTags;
}

/**
 * For code blocks, we need to extract the language identifier if present
 * to properly reopen them.
 */
function findCodeBlockLanguage(text: string): string {
  // Find the last unclosed ``` and check if it has a language
  const matches = text.match(/```(\w*)\n?[^`]*$/);
  if (matches) {
    return matches[1] || "";
  }
  return "";
}

/**
 * Builds the opening prefix for the overflow text based on detected closed tags.
 */
function buildOpeningPrefix(
  closedTags: string[],
  originalText: string,
): string {
  return closedTags
    .map((tag) => {
      if (tag === "```") {
        const lang = findCodeBlockLanguage(originalText);
        return "```" + lang + "\n";
      }
      if (tag === "$$") {
        // Check if it was block math (has newline after $$)
        const isBlockMath = /\$\$\n/.test(originalText);
        return isBlockMath ? "$$\n" : "$$";
      }
      return tag;
    })
    .join("");
}

export function tokenComplete(
  input: string,
  maxOutput: number,
): { completed: string; overflow: string } {
  // Use safeRemend to ensure valid markdown for streaming
  // (safeRemend protects code blocks from incorrect asterisk handling)
  const completed = safeRemend(input);

  // If input fits within limit, no splitting needed
  if (completed.length <= maxOutput) {
    return {
      completed: completed,
      overflow: "",
    };
  }

  // Get the portion that will be in the first message
  const firstPart = input.slice(0, maxOutput);
  const remainingPart = input.slice(maxOutput);

  // Use safeRemend to close any open tags in the first part
  const completedFirst = safeRemend(firstPart);

  // Detect what tags were closed
  const closedTags = detectClosedTags(firstPart, completedFirst);

  // Build the opening prefix for the overflow
  const openingPrefix = buildOpeningPrefix(closedTags, firstPart);

  // Recursively process the overflow in case it also needs splitting
  const overflow = openingPrefix + remainingPart;

  return {
    completed: completedFirst,
    overflow: overflow,
  };
}

/**
 * Completes markdown without applying any length-based splitting.
 */
export function completeMarkdown(input: string): string {
  return safeRemend(input);
}

/**
 * Force a split at a specific character offset and return:
 * - `completed`: the first part with any opened tags closed
 * - `overflow`: the remainder with the required opening tags prepended
 */
export function tokenCompleteAt(
  input: string,
  splitAt: number,
): { completed: string; overflow: string } {
  const clampedSplitAt = Math.max(0, Math.min(splitAt, input.length));
  const firstPart = input.slice(0, clampedSplitAt);
  const remainingPart = input.slice(clampedSplitAt);

  const completedFirst = safeRemend(firstPart);
  const closedTags = detectClosedTags(firstPart, completedFirst);
  const openingPrefix = buildOpeningPrefix(closedTags, firstPart);

  return {
    completed: completedFirst,
    overflow: remainingPart.length > 0 ? openingPrefix + remainingPart : "",
  };
}
