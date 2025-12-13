import { describe, expect, it } from "bun:test";
import { findLexicalSafeSplitPoint, findSafeSplitPoint } from "../src/markdown-splitter";
import { tokenComplete } from "../src/token-complete";

describe("markdown-splitter", () => {
  describe("findSafeSplitPoint", () => {
    it("should return source length if under target", () => {
      const input = "Hello **bold** world";
      const result = findSafeSplitPoint(input, 100);
      expect(result).toBe(input.length);
    });

    it("should not split inside ** markers", () => {
      const input = "Hello **bold** and more";
      // Position 7 is inside the opening **, should back up
      const result = findSafeSplitPoint(input, 7);
      expect(result).toBeLessThanOrEqual(6); // Before the **
    });

    it("should allow split inside bold text (not markers)", () => {
      const input = "Hello **bold text** end";
      // Position 10 is inside "bold" - should be safe
      const result = findSafeSplitPoint(input, 10);
      expect(result).toBe(10);
    });

    it("should allow splitting inside code fence content", () => {
      const input = "Text\n```js\ncode here\n```\nMore";
      // Position 15 is inside code block content; safe splitting is allowed.
      const result = findSafeSplitPoint(input, 15);
      expect(result).toBe(15);
    });

    it("should not split inside link syntax", () => {
      const input = "Check [this link](https://example.com) out";
      // Position 15 is inside the link
      const result = findSafeSplitPoint(input, 15);
      expect(result).toBeLessThanOrEqual(6); // Before the link
    });

    it("should not split inside image syntax", () => {
      const input = "See ![alt](https://example.com/img.png) here";
      // Position 15 is inside the image
      const result = findSafeSplitPoint(input, 15);
      expect(result).toBeLessThanOrEqual(4); // Before the image
    });
  });

  describe("integration: findSafeSplitPoint + tokenComplete", () => {
    it("findLexicalSafeSplitPoint should prefer whitespace", () => {
      const input = "This is a sentence";
      const splitPos = findLexicalSafeSplitPoint(input, 12, {
        maxBacktrack: 100,
        newlineBacktrack: 100,
        locale: "en-US",
      });
      // "This is a " ends at 10.
      expect(splitPos).toBe(10);
    });

    it("should produce valid chunks when combined", () => {
      const input = "Hello **bold prediction** and more text here.";
      const maxLen = 15;

      // Find safe split point
      const splitPos = findSafeSplitPoint(input, maxLen);

      // Complete the first chunk
      const { completed: chunk1, overflow } = tokenComplete(
        input.slice(0, splitPos),
        maxLen,
      );

      // The chunk should have closing tags if needed
      expect(chunk1.length).toBeLessThanOrEqual(maxLen + 10); // Allow for closing tags

      // The overflow contains opening tags for continuation
      // When we split inside bold, overflow should be ** (to reopen bold)
      if (overflow) {
        // overflow is just the opening tags, not the remaining content
        expect(overflow).toBe("**"); // We split inside bold, so need to reopen
      }

      // Verify the split is at a safe position (not inside ** markers)
      expect(splitPos).toBeGreaterThanOrEqual(8); // After opening **
      expect(splitPos).toBeLessThanOrEqual(23); // Before closing **
    });

    it("should chunk long markdown with *italics* without duplication", () => {
      const input = `# The Secret Life of Error Messages

Most people treat error messages as the machine's way of saying *no*. But that's unfair. An error message is closer to a **confession**.

## 1) The Myth of the "Unexpected" Thing

We love the phrase **"unexpected error"**. Consider this spell:

\`\`\`ts
function openDoor(key: string) {
  if (key === "gold") return "open";
  throw new Error("unexpected key");
}
\`\`\`

The door was never truly "confused."

## 2) Errors as Communication

A good error message is a handshake in the dark.

## 3) The Three Roles

An error message plays roles in a tiny stage production.

## 4) The Aesthetics of Failure

A clean error message has a certain aesthetic.

| Trait | Bad | Better |
|---|---|---|
| Specificity | "Failed." | "Failed to parse JSON." |

## 5) A Love Letter to the Catch Block

Sometimes, error messages exist because we failed. That's what \`try/catch\` is: a promise that we will at least *look* when we stumble.

\`\`\`ts
try {
  await doTheThing();
} catch (err) {
  console.error("failed:", err);
}
\`\`\`

The catch block is not pessimism. It's respect for reality.`;

      const maxLen = 500;

      // Simulate chunking
      const chunks: string[] = [];
      let remaining = input;

      while (remaining.length > 0) {
        const splitPos = findSafeSplitPoint(remaining, maxLen);
        const { completed, overflow } = tokenComplete(
          remaining.slice(0, splitPos),
          maxLen,
        );
        chunks.push(completed);
        remaining = overflow + remaining.slice(splitPos);

        // Safety
        if (chunks.length > 20) break;
      }

      // Check chunks are under limit (with small buffer for closing tags)
      expect(chunks.every((c: string) => c.length <= maxLen + 10)).toBe(true);

      // Check for "*look*" appears exactly once (no duplication from splitting)
      const allText = chunks.join("");
      const matches = allText.match(/\*look\*/g) || [];
      expect(matches.length).toBe(1);
    });

    it("should not break **Bold prediction** across chunks", () => {
      // Content crafted so **Bold prediction** falls near the maxLen boundary
      const padding = "x".repeat(380); // Padding to push **Bold prediction** near boundary
      const input = `# Quantum Cryptography

${padding}

## Real-World Deployment

From the office to global nets:

- **Standardization**: NIST finalizes 2024.
- **Hardware**: ARM chips need accelerators.

**Bold prediction**: By 2030, every AI plugs into quantum-secure grids.

## Conclusion

**Quantum-resistant cryptography** is essential.`;

      const maxLen = 500;

      // Find where **Bold prediction** is
      const boldIdx = input.indexOf("**Bold prediction**");
      expect(boldIdx).toBeGreaterThan(0);

      // Find safe split point near maxLen
      const splitPos = findSafeSplitPoint(input, maxLen);

      // Split should either be before the ** or after the **
      // Not in the middle of the ** markers
      const chunk1 = input.slice(0, splitPos);

      // If Bold prediction is in chunk1, it should be complete
      if (chunk1.includes("Bold prediction")) {
        expect(chunk1.includes("**Bold prediction**")).toBe(true);
      }
      // If not, it should be entirely in the remainder
      else {
        const remainder = input.slice(splitPos);
        expect(remainder.includes("**Bold prediction**")).toBe(true);
      }
    });
  });
});
