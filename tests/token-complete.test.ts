import { describe, it, expect } from "bun:test";
import { tokenComplete } from "../src/token-complete";

describe("token-complete", () => {
  describe("no splitting needed", () => {
    it("should return input unchanged when within limit (no open tags)", () => {
      const result = tokenComplete("hello world", 100);
      expect(result.completed).toBe("hello world");
      expect(result.overflow).toBe("");
    });

    it("should return input unchanged when exactly at limit", () => {
      const result = tokenComplete("hello", 5);
      expect(result.completed).toBe("hello");
      expect(result.overflow).toBe("");
    });

    it("should close open tags even when within limit (for streaming)", () => {
      const result = tokenComplete("**bold text", 100);
      expect(result.completed).toBe("**bold text**");
      expect(result.overflow).toBe("");
    });

    it("should close multiple open tags when within limit", () => {
      const result = tokenComplete("*italic and **bold", 100);
      expect(result.completed).toBe("*italic and **bold***");
      expect(result.overflow).toBe("");
    });
  });

  describe("bold text (**)", () => {
    it("should close and reopen bold tags when split", () => {
      const input = "**this is bold text**";
      const result = tokenComplete(input, 10);
      expect(result.completed).toBe("**this is **");
      expect(result.overflow).toBe("**bold text**");
    });

    it("should handle unclosed bold at split point", () => {
      const input = "**bold text continues here";
      const result = tokenComplete(input, 8);
      // remend closes at character boundary: "**bold t" -> "**bold t**"
      expect(result.completed).toBe("**bold t**");
      expect(result.overflow).toBe("**ext continues here");
    });
  });

  describe("italic text (*)", () => {
    it("should close and reopen italic tags when split", () => {
      const input = "*this is italic text*";
      const result = tokenComplete(input, 10);
      expect(result.completed).toBe("*this is i*");
      expect(result.overflow).toBe("*talic text*");
    });
  });

  describe("bold + italic (***)", () => {
    it("should close and reopen bold+italic tags when split", () => {
      const input = "***bold and italic***";
      const result = tokenComplete(input, 10);
      expect(result.completed).toBe("***bold an***");
      expect(result.overflow).toBe("***d italic***");
    });
  });

  describe("inline code (`)", () => {
    it("should close and reopen inline code when split", () => {
      const input = "`some code here`";
      const result = tokenComplete(input, 8);
      expect(result.completed).toBe("`some co`");
      expect(result.overflow).toBe("`de here`");
    });
  });

  describe("code blocks (```)", () => {
    // Note: remend does NOT close code blocks with newlines (by design for streaming)
    // So we test inline code block behavior instead
    it("should handle inline code block (no newline)", () => {
      const input = "```code```";
      const result = tokenComplete(input, 6);
      // "```cod" doesn't get closed by remend as it's not a complete pattern
      expect(result.completed).toBe("```cod");
      expect(result.overflow).toBe("e```");
    });
  });

  describe("strikethrough (~~)", () => {
    it("should close and reopen strikethrough when split", () => {
      const input = "~~deleted text here~~";
      const result = tokenComplete(input, 12);
      expect(result.completed).toBe("~~deleted te~~");
      expect(result.overflow).toBe("~~xt here~~");
    });
  });

  describe("underscore bold (__)", () => {
    it("should close and reopen underscore bold when split", () => {
      const input = "__bold text here__";
      const result = tokenComplete(input, 10);
      expect(result.completed).toBe("__bold tex__");
      expect(result.overflow).toBe("__t here__");
    });
  });

  describe("block math ($$)", () => {
    it("should close and reopen block math when split", () => {
      const input = "$$\nx = y + z\n$$";
      const result = tokenComplete(input, 8);
      // remend adds newline before closing $$ for block math
      expect(result.completed).toBe("$$\nx = y\n$$");
      expect(result.overflow).toBe("$$\n + z\n$$");
    });
  });

  describe("nested formatting", () => {
    it("should handle nested bold and italic", () => {
      const input = "**bold *and italic* text**";
      const result = tokenComplete(input, 15);
      // remend should close both tags
      expect(result.completed).toContain("**");
    });
  });

  describe("code block protection", () => {
    it("should not add closing * for asterisks inside inline code", () => {
      const input = "Use `response.*` pattern";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should not add closing * for asterisks inside code fences", () => {
      const input = "```js\nconst x = 5 * 2;\n```";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should still close unclosed italic outside code blocks", () => {
      const input = "*italic with `code*` inside";
      const result = tokenComplete(input, 100);
      // The first * opens italic, the * in code doesn't close it, so we add *
      expect(result.completed).toBe("*italic with `code*` inside*");
    });

    it("should handle mixed code and formatting", () => {
      const input = "**bold** and `code with *` here";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should handle multiple code blocks with asterisks", () => {
      const input = "First `a*b` then `c*d` end";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should close unclosed inline code without adding extra *", () => {
      const input = "`response.*";
      const result = tokenComplete(input, 100);
      // Should add closing backtick, not closing *
      expect(result.completed).toBe("`response.*`");
    });

    it("should handle unclosed code with asterisks and spaces", () => {
      const input = "`a * b";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe("`a * b`");
    });

    it("should handle unclosed code fence with asterisks", () => {
      const input = "```js\nconst x = 5 *";
      const result = tokenComplete(input, 100);
      // remend doesn't close code fences, content preserved as-is
      expect(result.completed).toBe(input);
    });
  });

  describe("real-world scenarios", () => {
    it("should handle LLM response split mid-sentence", () => {
      const input = "*this is a sentence generated by a large language model*";
      const result = tokenComplete(input, 20);
      expect(result.completed).toBe("*this is a sentence *");
      expect(result.overflow).toBe("*generated by a large language model*");
    });

    it("should handle multiple paragraphs with formatting", () => {
      const input = "Normal text\n\n**Bold paragraph that is very long**";
      const result = tokenComplete(input, 25);
      // "Normal text\n\n**Bold parag" = 25 chars, remend closes with **
      expect(result.completed).toBe("Normal text\n\n**Bold parag**");
      expect(result.overflow).toBe("**raph that is very long**");
    });
  });

  describe("streaming buffer simulation", () => {
    it("should not accumulate closing tags when simulating streaming chunks", () => {
      // Simulates the discord.ts streaming behavior:
      // - rawBuffer accumulates raw content (no auto-closed tags)
      // - tokenComplete is only used for display
      const maxLength = 100;

      // Chunk 1: "*this is a sentence"
      const chunk1 = "*this is a sentence";
      let rawBuffer = chunk1; // Store raw, NOT completed
      const display1 = tokenComplete(rawBuffer, maxLength).completed;
      expect(display1).toBe("*this is a sentence*"); // Display has closing tag

      // Chunk 2: " generated by a large language model*"
      const chunk2 = " generated by a large language model*";
      rawBuffer = rawBuffer + chunk2; // Accumulate raw content
      const display2 = tokenComplete(rawBuffer, maxLength).completed;

      // Final result should be correct - no duplicate closing tags
      expect(rawBuffer).toBe(
        "*this is a sentence generated by a large language model*",
      );
      expect(display2).toBe(
        "*this is a sentence generated by a large language model*",
      );
    });

    it("should handle overflow case with proper tag continuation", () => {
      const maxLength = 21;

      // Simulate: "*this is a very long bold sentence*"
      // Use maxLength=21 so split happens at a word boundary
      const chunk1 = "*this is a very long bold sentence*";

      // tokenComplete will complete the first 21 chars and provide overflow with opening tags
      const { completed: display1, overflow: overflowPrefix } = tokenComplete(
        chunk1,
        maxLength,
      );

      // First message: "*this is a very long " (21 chars) + "*" (closing)
      expect(display1).toBe("*this is a very long *"); // First message: properly closed
      expect(overflowPrefix).toBe("*bold sentence*"); // Has opening tag for continuation

      // Second message would start with overflowPrefix
      // When stream ends, tokenComplete is applied to get final display
      const finalDisplay2 = tokenComplete(overflowPrefix, maxLength).completed;
      expect(finalDisplay2).toBe("*bold sentence*"); // Second message: properly formatted
    });

    it("should handle multiple overflows correctly", () => {
      const maxLength = 10;

      // Very long bold text that needs multiple splits
      const fullContent = "**this is a very very long bold text**";

      // First split
      const { completed: msg1, overflow: overflow1 } = tokenComplete(
        fullContent,
        maxLength,
      );
      expect(msg1).toBe("**this is **");
      expect(overflow1.startsWith("**")).toBe(true); // Has opening tags

      // Second split (from overflow)
      const { completed: msg2, overflow: overflow2 } = tokenComplete(
        overflow1,
        maxLength,
      );
      expect(msg2).toContain("**"); // Has closing tags
      expect(msg2.endsWith("**")).toBe(true);

      // Continue until done
      let remaining = overflow2;
      const messages = [msg1, msg2];
      while (remaining.length > 0) {
        const { completed, overflow } = tokenComplete(remaining, maxLength);
        messages.push(completed);
        remaining = overflow;
      }

      // All messages should have proper markdown
      for (const msg of messages) {
        const openCount = (msg.match(/\*\*/g) || []).length;
        expect(openCount % 2).toBe(0); // Even number of ** means balanced
      }
    });
  });

  describe("discord.ts pusher simulation", () => {
    /**
     * Simulates the exact logic from discord.ts startContentPusher
     * to verify no extra closing tags appear.
     *
     * Key insight: tokenComplete is only used for STREAMING display.
     * Final display uses raw content directly to avoid remend's
     * overly aggressive closing (e.g., `response.*` in backticks).
     */
    function simulatePusher(
      chunks: string[],
      maxLength: number,
    ): {
      finalDisplays: string[];
      rawBuffers: string[];
      streamingDisplays: string[];
    } {
      const rawBuffers: string[] = [""];
      const streamingDisplays: string[] = [];
      let pushedIndex = 0;
      let contentAcc = "";

      // Simulate streaming chunks
      for (const chunk of chunks) {
        contentAcc += chunk;
        const content = contentAcc;
        const delta = content.slice(pushedIndex);

        if (delta.length > 0) {
          const rawBuffer = rawBuffers.at(-1) ?? "";
          const tempBuf = rawBuffer.concat(delta);
          const isOverflow = tempBuf.length > maxLength;

          const { completed: displayBuffer, overflow: overflowPrefix } =
            tokenComplete(tempBuf, maxLength);

          // Store raw content (up to maxLength) without auto-closed tags
          const rawContentForThisChunk = tempBuf.slice(0, maxLength);
          rawBuffers[rawBuffers.length - 1] = rawContentForThisChunk;
          pushedIndex += rawContentForThisChunk.length - rawBuffer.length;

          // Record what would be displayed during streaming (with auto-close)
          streamingDisplays.push(displayBuffer);

          if (isOverflow) rawBuffers.push(overflowPrefix);
        }
      }

      // Final display applies tokenComplete to properly close any open tags
      // (safeRemend inside tokenComplete protects code blocks from incorrect handling)
      const finalDisplays = rawBuffers.map(
        (raw) => tokenComplete(raw, maxLength).completed,
      );

      return { finalDisplays, rawBuffers, streamingDisplays };
    }

    it("should not have extra closing tags for simple italic text", () => {
      const chunks = ["*this ", "is a ", "sentence*"];
      const { finalDisplays, rawBuffers } = simulatePusher(chunks, 100);

      expect(rawBuffers).toEqual(["*this is a sentence*"]);
      expect(finalDisplays).toEqual(["*this is a sentence*"]);
    });

    it("should not have extra closing tags for bold text", () => {
      const chunks = ["**bold ", "text ", "here**"];
      const { finalDisplays, rawBuffers } = simulatePusher(chunks, 100);

      expect(rawBuffers).toEqual(["**bold text here**"]);
      expect(finalDisplays).toEqual(["**bold text here**"]);
    });

    it("should handle text that starts open and closes later", () => {
      const chunks = ["*start", " middle", " end*"];
      const { finalDisplays, rawBuffers } = simulatePusher(chunks, 100);

      expect(rawBuffers).toEqual(["*start middle end*"]);
      expect(finalDisplays).toEqual(["*start middle end*"]);
    });

    it("should handle fake article with formatting", () => {
      const article = `**Breaking News: Local Cat Discovers Keyboard**

*By Jane Doe*

A local cat named Whiskers has reportedly discovered the household keyboard, leading to several unexpected emails being sent to coworkers.

"We were *shocked* to find out that Whiskers had been communicating with the IT department," said the cat's owner.

The cat's messages included:
- \`asdfghjkl;\`
- \`qwertyuiop\`
- **urgent meeting request**

More details to follow.`;

      // Split article into small chunks (simulating token-by-token streaming)
      const chunkSize = 15;
      const chunks: string[] = [];
      for (let i = 0; i < article.length; i += chunkSize) {
        chunks.push(article.slice(i, i + chunkSize));
      }

      const { finalDisplays, rawBuffers } = simulatePusher(chunks, 4096);

      // Should be single message (article is short)
      expect(rawBuffers.length).toBe(1);
      expect(finalDisplays.length).toBe(1);

      // Final display should match original article exactly
      const finalDisplay = finalDisplays[0] ?? "";
      expect(finalDisplay).toBe(article);
      // No extra asterisks
      expect(finalDisplay.endsWith("*")).toBe(false);
    });

    it("should handle unclosed formatting that gets closed later", () => {
      // Simulates LLM generating: opens italic, writes content, closes italic
      const chunks = [
        "Here is ",
        "*some italic",
        " text that",
        " continues*",
        " and more",
      ];
      const { finalDisplays, rawBuffers } = simulatePusher(chunks, 100);

      expect(rawBuffers).toEqual([
        "Here is *some italic text that continues* and more",
      ]);
      expect(finalDisplays).toEqual([
        "Here is *some italic text that continues* and more",
      ]);
    });

    it("should handle message split across multiple Discord messages", () => {
      const chunks = [
        "**This is a very ",
        "long bold text ",
        "that will overflow**",
      ];
      const { finalDisplays, rawBuffers } = simulatePusher(chunks, 25);

      // Should split into multiple messages
      expect(rawBuffers.length).toBeGreaterThan(1);

      // Each final display should have balanced markdown
      for (const display of finalDisplays) {
        const doubleStarCount = (display.match(/\*\*/g) || []).length;
        expect(doubleStarCount % 2).toBe(0);
      }
    });
  });
});
