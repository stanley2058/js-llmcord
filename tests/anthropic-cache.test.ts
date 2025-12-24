import { describe, expect, test } from "bun:test";
import { z } from "zod/v3";

import {
  collapseLeadingSystemMessages,
  getAiGatewayOrderFromModelConfig,
  getAnthropicCacheControlFromModelConfig,
  withAnthropicMessageCacheControl,
  withAnthropicToolCacheControl,
} from "../src/utils/anthropic-cache";

describe("anthropic cache helpers", () => {
  test("returns null when cache disabled", () => {
    expect(getAnthropicCacheControlFromModelConfig(undefined)).toBeNull();
    expect(
      getAnthropicCacheControlFromModelConfig({
        anthropic_cache_control: false,
      }),
    ).toBeNull();
  });

  test("returns ephemeral when enabled", () => {
    expect(
      getAnthropicCacheControlFromModelConfig({
        anthropic_cache_control: true,
      }),
    ).toEqual({ type: "ephemeral" });
  });

  test("returns ttl when configured", () => {
    expect(
      getAnthropicCacheControlFromModelConfig({
        anthropic_cache_control: true,
        anthropic_cache_ttl: "1h",
      }),
    ).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("default AI gateway order is stable", () => {
    expect(getAiGatewayOrderFromModelConfig(undefined)).toEqual([
      "anthropic",
      "vertex",
      "bedrock",
    ]);
  });

  test("throws on empty AI gateway order", () => {
    expect(() =>
      getAiGatewayOrderFromModelConfig({ ai_gateway_order: [] }),
    ).toThrow();
  });

  test("patches system message providerOptions", () => {
    const msg = { role: "system", content: "x" } as const;
    const patched = withAnthropicMessageCacheControl(msg, {
      type: "ephemeral",
    });
    expect((patched as any).providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  test("patches tool providerOptions", () => {
    const tools = {
      t: {
        description: "x",
        inputSchema: z.object({}),
        execute: async () => "ok",
      },
    };

    const patched = withAnthropicToolCacheControl(tools as any, {
      type: "ephemeral",
    });

    expect((patched as any).t.providerOptions.anthropic.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  test("collapses leading system prompts into one", () => {
    const messages = [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hi" },
    ] as any;

    const collapsed = collapseLeadingSystemMessages(messages);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]!.role).toBe("system");
    expect(collapsed[0]!.content).toBe("A\n\nB");
    expect(collapsed[1]!.role).toBe("user");
  });
});
