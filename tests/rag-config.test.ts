import { describe, expect, test } from "bun:test";
import {
  parseRagEmbeddingModelString,
  resolveRagEmbeddingDimensions,
} from "../src/rag/config";

describe("rag/config", () => {
  test("parseRagEmbeddingModelString defaults to openai when no provider prefix", () => {
    expect(parseRagEmbeddingModelString("text-embedding-3-small")).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  test("parseRagEmbeddingModelString splits on first slash only", () => {
    expect(parseRagEmbeddingModelString("local/BAAI/bge-large-en-v1.5")).toEqual({
      provider: "local",
      model: "BAAI/bge-large-en-v1.5",
    });
  });

  test("resolveRagEmbeddingDimensions uses known OpenAI defaults", () => {
    expect(
      resolveRagEmbeddingDimensions({
        provider: "openai",
        model: "text-embedding-3-small",
        embeddingDimensions: undefined,
      }),
    ).toBe(1536);
  });

  test("resolveRagEmbeddingDimensions throws for unknown model without explicit dimension", () => {
    expect(() =>
      resolveRagEmbeddingDimensions({
        provider: "local",
        model: "bge-small",
        embeddingDimensions: undefined,
      }),
    ).toThrow();
  });
});
