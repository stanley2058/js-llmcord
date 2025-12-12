import remend from "remend";

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
  // Always use remend to ensure valid markdown for streaming
  const completed = remend(input);

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

  // Use remend to close any open tags in the first part
  const completedFirst = remend(firstPart);

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
