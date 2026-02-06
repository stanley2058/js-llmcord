import { describe, expect, test } from "bun:test";
import {
  ModelCapability,
  providerModelToModelsDevSpecifier,
} from "../src/utils/model-capability";

describe("model-capability", () => {
  test("providerModelToModelsDevSpecifier handles ai-gateway", () => {
    expect(providerModelToModelsDevSpecifier("ai-gateway/openai/gpt-4o")).toBe(
      "openai/gpt-4o",
    );
  });

  test("providerModelToModelsDevSpecifier strips :vision suffix", () => {
    expect(providerModelToModelsDevSpecifier("openai/gpt-4o:vision")).toBe(
      "openai/gpt-4o",
    );
  });

  test("ModelCapability resolves using provider alias mapping", async () => {
    const registry = {
      xai: {
        id: "xai",
        npm: "@ai-sdk/xai",
        name: "xAI",
        models: {
          "grok-2": {
            id: "grok-2",
            name: "Grok 2",
            family: "grok",
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    };

    const capability = new ModelCapability({
      fetch: (async () =>
        new Response(JSON.stringify(registry), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    const info = await capability.resolve("x-ai/grok-2");
    expect(info.modalities?.input.includes("image")).toBe(true);
  });
});
