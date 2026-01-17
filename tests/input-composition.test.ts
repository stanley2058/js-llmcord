import { describe, expect, it } from "bun:test";
import { z } from "zod/v3";

import {
  buildInputCompositionFooterLine,
  estimateInputCompositionChars,
} from "../src/discord/input-composition";

describe("input-composition", () => {
  it("computes stable percentages for single-call prompts", () => {
    const initialMessages = [
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
      { role: "assistant", content: "ASSIST" },
    ] as any;

    const chars = estimateInputCompositionChars({
      initialMessages,
      responseMessages: [],
      tools: null,
      compatibleMode: false,
    });

    expect(chars.callCount).toBe(1);
    expect(chars.systemChars).toBeGreaterThan(0);
    expect(chars.userChars).toBeGreaterThan(0);
    expect(chars.assistantChars).toBeGreaterThan(0);
    expect(chars.toolDefsChars).toBe(0);
    expect(chars.toolResultChars).toBe(0);

    const line = buildInputCompositionFooterLine({
      statsForNerds: { verbose: true },
      totalUsage: { inputTokens: 100 } as any,
      initialMessages,
      responseMessages: [],
      tools: null,
      compatibleMode: false,
    });

    expect(line).toStartWith("[IC] ");
    expect(line).toContain("S:");
    expect(line).toContain("A:");
    expect(line).toContain("U:");
    expect(line).toContain("TD:");
    expect(line).toContain("TR:");
  });

  it("counts tool-call payloads as assistant chars", () => {
    const initialMessages = [{ role: "user", content: "hi" }] as any;
    const responseMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool-call", toolName: "t", toolCallId: "1", input: { q: 1 } },
        ],
      },
    ] as any;

    const chars = estimateInputCompositionChars({
      initialMessages,
      responseMessages,
      tools: null,
      compatibleMode: false,
    });

    expect(chars.assistantChars).toBeGreaterThan(0);
    expect(chars.toolResultChars).toBe(0);
  });

  it("treats tool results as TR and increases call count", () => {
    const initialMessages = [{ role: "user", content: "hi" }] as any;
    const responseMessages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolName: "t", toolCallId: "1", input: { q: 1 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "t",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      { role: "assistant", content: "done" },
    ] as any;

    const chars = estimateInputCompositionChars({
      initialMessages,
      responseMessages,
      tools: null,
      compatibleMode: false,
    });

    // one extra call after tool results
    expect(chars.callCount).toBe(2);
    expect(chars.toolResultChars).toBeGreaterThan(0);
  });

  it("counts tool defs (TD) when tools are present", () => {
    const tools = {
      t: {
        description: "x",
        inputSchema: z.object({ q: z.number() }),
        execute: async () => "ok",
      },
    };

    const chars = estimateInputCompositionChars({
      initialMessages: [{ role: "user", content: "hi" }] as any,
      responseMessages: [],
      tools,
      compatibleMode: false,
    });

    expect(chars.toolDefsChars).toBeGreaterThan(0);
  });

  it("detects compatible tool-result wrapper and increments call count", () => {
    const initialMessages = [{ role: "user", content: "hi" }] as any;
    const responseMessages = [
      { role: "assistant", content: "<tool-call tool=\"x\">{}</tool-call>" },
      {
        role: "assistant",
        content:
          "[{\"type\":\"tool-result\",\"toolCallId\":\"1\",\"toolName\":\"x\",\"output\":{\"type\":\"text\",\"value\":\"ok\"}}]",
      },
      { role: "assistant", content: "done" },
    ] as any;

    const chars = estimateInputCompositionChars({
      initialMessages,
      responseMessages,
      tools: null,
      compatibleMode: true,
    });

    expect(chars.callCount).toBe(2);
    expect(chars.toolResultChars).toBeGreaterThan(0);
  });
});
