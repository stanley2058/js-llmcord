import { describe, expect, it } from "bun:test";
import { chunkMarkdownForEmbeds } from "../src/markdown-chunker";

describe("markdown-chunker", () => {
  it("should not drop content for plain text", () => {
    const input = "0123456789ABCDEFGHIJ";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 7,
      maxLastChunkLength: 7,
      useSmartSplitting: true,
    });

    // Note: smart splitting may trim whitespace at boundaries.
    expect(chunks.join("")).toBe(input);
  });

  it("should prefer splitting on whitespace (lexical)", () => {
    const input = "This is a sentence";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 12,
      maxLastChunkLength: 12,
      useSmartSplitting: true,
    });

    // Avoid mid-word split: "This is a" + "sentence"
    expect(chunks).toEqual(["This is a", "sentence"]);
  });

  it("should prefer splitting on nearby newlines", () => {
    const input = "Line1\nLine2 more text";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 13,
      maxLastChunkLength: 13,
      useSmartSplitting: true,
    });

    // Prefer the newline boundary over mid-word.
    expect(chunks[0]).toBe("Line1");
    expect(chunks.join(" ")).toContain("Line2");
  });

  it("should keep earlier chunks stable after splitting", () => {
    const opts = {
      maxChunkLength: 10,
      maxLastChunkLength: 8,
      useSmartSplitting: true,
    };

    const beforeSplit = chunkMarkdownForEmbeds("0123456789AB", opts);
    expect(beforeSplit).toEqual(["0123456789", "AB"]);

    const afterSplit = chunkMarkdownForEmbeds("0123456789ABCDEFG", opts);
    expect(afterSplit[0]).toBe("0123456789");
    expect(afterSplit.join("")).toBe("0123456789ABCDEFG");
  });

  it("should keep code fence chunks renderable", () => {
    const input = "```js\nconsole.log(1)";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 10,
      maxLastChunkLength: 10,
      useSmartSplitting: true,
    });

    // The first chunk should be independently renderable.
    expect(chunks[0]).toContain("```");
  });

  it("should split fenced code blocks on line boundaries", () => {
    const input = "```js\nconsole.log(1)\nnextLine\nthird";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 22,
      maxLastChunkLength: 22,
      useSmartSplitting: true,
    });

    // First chunk should include the full first code line.
    expect(chunks[0]).toBe("```js\nconsole.log(1)\n```");

    // Next chunk should start from the next line (not mid-line).
    expect(chunks[1]).toContain("nextLine");
  });

  it("should rechunk last chunk to reserve indicator space", () => {
    const opts = {
      maxChunkLength: 10,
      maxLastChunkLength: 8,
      useSmartSplitting: false,
    };

    const chunks = chunkMarkdownForEmbeds("0123456789ABCDEFGHI", opts);
    // Initial chunking at 10 gives: 0123456789 + ABCDEFGHI
    // Rechunk last at 8 gives: ABCDEFGH + I
    expect(chunks).toEqual(["0123456789", "ABCDEFGH", "I"]);
  });
});
