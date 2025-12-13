import remend from "remend";

// Null character used as placeholder delimiter (won't appear in normal text)
const CODE_PLACEHOLDER = "\x00";

/**
 * Escapes the CONTENT of code blocks before processing with remend.
 * This prevents remend from incorrectly interpreting asterisks inside code
 * as markdown formatting (e.g., `response.*` would otherwise get an extra `*`).
 *
 * We keep the backticks visible to remend so it can still close unclosed
 * code blocks during streaming - we only hide the content inside.
 *
 * Handles both closed code blocks (`code`) and unclosed ones (`code...) that
 * may appear during streaming.
 */
function escapeCodeBlocks(text: string): {
  escaped: string;
  codeBlocks: string[];
} {
  const codeBlocks: string[] = [];

  let result = text;

  // First handle triple backticks (code fences) - both closed and unclosed
  // We preserve the ``` delimiters but escape the content between them
  // Closed: ```content``` -> ```PLACEHOLDER```
  // Unclosed: ```content -> ```PLACEHOLDER (remend will add closing ```)
  result = result.replace(/```([\s\S]*?)(```|$)/g, (match, content, closing) => {
    if (content) {
      const idx = codeBlocks.length;
      codeBlocks.push(content);
      return `\`\`\`${CODE_PLACEHOLDER}CODE${idx}${CODE_PLACEHOLDER}${closing}`;
    }
    return match;
  });

  // Then handle inline code (single backticks) - both closed and unclosed
  // Preserve the ` delimiters but escape the content
  // Closed: `content` -> `PLACEHOLDER`
  // Unclosed: `content -> `PLACEHOLDER (remend will add closing `)
  // Note: [^`\x00]+ excludes null char to avoid matching our placeholders
  result = result.replace(/`([^`\x00]+)(`|$)/g, (match, content, closing) => {
    const idx = codeBlocks.length;
    codeBlocks.push(content);
    return `\`${CODE_PLACEHOLDER}CODE${idx}${CODE_PLACEHOLDER}${closing}`;
  });

  return { escaped: result, codeBlocks };
}

/**
 * Restores code blocks from placeholders after remend processing.
 */
function restoreCodeBlocks(text: string, codeBlocks: string[]): string {
  let result = text;
  for (let i = 0; i < codeBlocks.length; i++) {
    const placeholder = `${CODE_PLACEHOLDER}CODE${i}${CODE_PLACEHOLDER}`;
    const original = codeBlocks[i] ?? "";
    result = result.replace(placeholder, original);
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
