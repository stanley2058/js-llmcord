import { describe, it, expect } from "bun:test";

import { getEffectiveProviderModel } from "../src/discord";

describe("Per-Channel Model Resolution", () => {
  describe("Per-Channel Mode Enabled (per_channel_model: true)", () => {
    describe("Regular channels (non-thread)", () => {
      it("returns default model when no override set", () => {
        const channel = { id: "channel-1" };
        const overrides = new Map<string, string>();
        const defaultModel = "openai/gpt-4o";
        const globalModel = "anthropic/claude-opus";

        const result = getEffectiveProviderModel(
          channel,
          true,
          overrides,
          defaultModel,
          globalModel,
        );
        expect(result).toBe("openai/gpt-4o");
      });

      it("returns channel override when set", () => {
        const channel = { id: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-1", "anthropic/claude-opus");

        const result = getEffectiveProviderModel(
          channel,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("anthropic/claude-opus");
      });

      it("ignores channel override from another channel", () => {
        const channel = { id: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-2", "anthropic/claude-opus");

        const result = getEffectiveProviderModel(
          channel,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("openai/gpt-4o");
      });
    });

    describe("Threads (channels with parentId)", () => {
      it("returns default model when no overrides set", () => {
        const threadChannel = { id: "thread-1", parentId: "channel-1" };
        const overrides = new Map<string, string>();

        const result = getEffectiveProviderModel(
          threadChannel,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("openai/gpt-4o");
      });

      it("returns parent channel override when thread has no override", () => {
        const threadChannel = { id: "thread-1", parentId: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-1", "anthropic/claude-opus");

        const result = getEffectiveProviderModel(
          threadChannel,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("anthropic/claude-opus");
      });

      it("returns thread override, preferring it over parent override", () => {
        const threadChannel = { id: "thread-1", parentId: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-1", "anthropic/claude-opus");
        overrides.set("thread-1", "openai/gpt-4-turbo");

        const result = getEffectiveProviderModel(
          threadChannel,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("openai/gpt-4-turbo");
      });

      it("returns default when parent has no override and thread has no override", () => {
        const threadChannel = { id: "thread-1", parentId: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-2", "anthropic/claude-opus");

        const result = getEffectiveProviderModel(
          threadChannel,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("openai/gpt-4o");
      });

      it("handles thread with parentId=null as regular channel", () => {
        const channelLike = { id: "some-1", parentId: null };
        const overrides = new Map<string, string>();
        overrides.set("some-1", "anthropic/claude-opus");

        const result = getEffectiveProviderModel(
          channelLike,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("anthropic/claude-opus");
      });

      it("handles thread with parentId=undefined as regular channel", () => {
        const channelLike = { id: "some-1" };
        const overrides = new Map<string, string>();
        overrides.set("some-1", "anthropic/claude-opus");

        const result = getEffectiveProviderModel(
          channelLike,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("anthropic/claude-opus");
      });

      it("multiple threads in same channel can have independent overrides", () => {
        const thread1 = { id: "thread-1", parentId: "channel-1" };
        const thread2 = { id: "thread-2", parentId: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("thread-1", "openai/gpt-4-turbo");
        overrides.set("thread-2", "anthropic/claude-opus");

        const result1 = getEffectiveProviderModel(
          thread1,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        const result2 = getEffectiveProviderModel(
          thread2,
          true,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );

        expect(result1).toBe("openai/gpt-4-turbo");
        expect(result2).toBe("anthropic/claude-opus");
      });
    });
  });

  describe("Per-Channel Mode Disabled (per_channel_model: false)", () => {
    describe("Regular channels (non-thread)", () => {
      it("returns global model regardless of overrides", () => {
        const channel = { id: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-1", "anthropic/claude-opus");

        const result = getEffectiveProviderModel(
          channel,
          false,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("openai/gpt-4");
      });

      it("always uses global model when disabled", () => {
        const channel = { id: "any-channel" };
        const overrides = new Map<string, string>();

        const result = getEffectiveProviderModel(
          channel,
          false,
          overrides,
          "openai/gpt-4o",
          "anthropic/claude-opus",
        );
        expect(result).toBe("anthropic/claude-opus");
      });
    });

    describe("Threads (channels with parentId)", () => {
      it("returns global model for thread, ignoring parent override", () => {
        const threadChannel = { id: "thread-1", parentId: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-1", "anthropic/claude-opus");
        overrides.set("thread-1", "openai/gpt-4-turbo");

        const result = getEffectiveProviderModel(
          threadChannel,
          false,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        expect(result).toBe("openai/gpt-4");
      });

      it("threads do not inherit parent override when disabled", () => {
        const thread1 = { id: "thread-1", parentId: "channel-1" };
        const thread2 = { id: "thread-2", parentId: "channel-1" };
        const overrides = new Map<string, string>();
        overrides.set("channel-1", "anthropic/claude-opus");

        const result1 = getEffectiveProviderModel(
          thread1,
          false,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );
        const result2 = getEffectiveProviderModel(
          thread2,
          false,
          overrides,
          "openai/gpt-4o",
          "openai/gpt-4",
        );

        expect(result1).toBe("openai/gpt-4");
        expect(result2).toBe("openai/gpt-4");
      });
    });
  });

  describe("Autocomplete ordering scenario", () => {
    it("identifies current model for autocomplete when per-channel enabled", () => {
      const channel = { id: "channel-1" };
      const overrides = new Map<string, string>();
      overrides.set("channel-1", "anthropic/claude-opus");

      const current = getEffectiveProviderModel(
        channel,
        true,
        overrides,
        "openai/gpt-4o",
        "openai/gpt-4",
      );
      expect(current).toBe("anthropic/claude-opus");
    });

    it("identifies global model for autocomplete when per-channel disabled", () => {
      const channel = { id: "channel-1" };
      const overrides = new Map<string, string>();
      overrides.set("channel-1", "anthropic/claude-opus");

      const current = getEffectiveProviderModel(
        channel,
        false,
        overrides,
        "openai/gpt-4o",
        "openai/gpt-4",
      );
      expect(current).toBe("openai/gpt-4");
    });

    it("correctly identifies thread override as current when per-channel enabled", () => {
      const thread = { id: "thread-1", parentId: "channel-1" };
      const overrides = new Map<string, string>();
      overrides.set("channel-1", "anthropic/claude-opus");
      overrides.set("thread-1", "openai/gpt-4-turbo");

      const current = getEffectiveProviderModel(
        thread,
        true,
        overrides,
        "openai/gpt-4o",
        "openai/gpt-4",
      );
      expect(current).toBe("openai/gpt-4-turbo");
    });
  });
});
