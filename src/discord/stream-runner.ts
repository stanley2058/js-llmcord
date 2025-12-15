import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
} from "discord.js";
import { inspect } from "bun";
import { performance } from "node:perf_hooks";
import {
  streamText,
  type CallWarning,
  type FinishReason,
  type LanguageModelUsage,
} from "ai";

import {
  maybeYieldBoundarySeparator,
  streamTextWithCompatibleTools,
  type StreamTextParams,
} from "../streaming-compatible";
import type { Logger } from "../logger";
import type { Config } from "../type";
import { stripToolTraffic, buildToolAuditNote } from "../tool-transform";
import type { ModelMessageOperator } from "../model-messages";
import type { AnthropicCacheControl } from "../utils/anthropic-cache";
import { startContentPusher, getPusherConstants } from "./content-pusher";
import {
  buildStatsForNerdsField,
  buildStatsForNerdsLogLine,
} from "./stats-for-nerds";

export type StreamAttemptContext = {
  logger: Logger;
  config: Config;
  curProviderModel: string;
  safeEdit: (
    msg: Message,
    options: Parameters<Message["edit"]>[0],
  ) => Promise<boolean>;
  logStreamWarning: (warns: CallWarning[] | null | undefined) => void;
  logStreamFinishReason: (reason: FinishReason) => void;
  modelMessageOperator: ModelMessageOperator;
};

export async function runStreamAttempt({
  ctx,
  msg,
  id,
  opts,
  messages,
  currentMessageImageIds,
  compatibleMode,
  usePlainResponses,
  warnEmbed,
  anthropicCacheControl,
  typingInterval,
}: {
  ctx: StreamAttemptContext;
  msg: Message;
  id: string;
  opts: StreamTextParams;
  messages: unknown;
  currentMessageImageIds: string[];
  compatibleMode: boolean;
  usePlainResponses: boolean;
  warnEmbed: EmbedBuilder | null;
  anthropicCacheControl: AnthropicCacheControl | null;
  typingInterval: NodeJS.Timeout;
}): Promise<void> {
  let btnMessage: Message | null = null;

  try {
    const cancelButton = new ButtonBuilder()
      .setCustomId(`cancel_${id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      cancelButton,
    );
    btnMessage = await msg.reply({
      content: "*Replying...*",
      components: [row],
      allowedMentions: { parse: [], repliedUser: false },
    });

    let pendingBoundarySeparator = false;
    const stream = compatibleMode
      ? streamTextWithCompatibleTools({
          ...opts,
          logger: ctx.logger,
          anthropicCacheControl,
        })
      : streamText({
          ...opts,
          onStepFinish: (step) => {
            opts.onStepFinish?.(step);
            if ((step as { toolCalls?: unknown[] }).toolCalls?.length) {
              pendingBoundarySeparator = true;
            }
          },
        });

    const { textStream, finishReason, response, reasoning, warnings } = stream;

    const requestStartMs = performance.now();
    let firstTokenMs: number | null = null;
    if (ctx.config.debug_message) {
      ctx.logger.logDebug(inspect(messages));
    }

    let contentAcc = "";
    let lastAccChar = "";

    const streamingDonePromise = new Promise<void>((resolve) => {
      (async () => {
        for await (const textPart of textStream) {
          if (firstTokenMs === null) {
            firstTokenMs = performance.now();
          }

          if (!compatibleMode && pendingBoundarySeparator) {
            const sep = maybeYieldBoundarySeparator(lastAccChar, textPart, " ");
            if (sep) {
              contentAcc += sep;
              lastAccChar = sep.at(-1) ?? lastAccChar;
            }
            pendingBoundarySeparator = false;
          }

          contentAcc += textPart;
          lastAccChar = textPart.at(-1) ?? lastAccChar;
        }
        resolve();
      })();
    });

    const useSmartSplitting =
      ctx.config.experimental_overflow_splitting ?? false;
    const { STREAMING_INDICATOR, CLOSING_TAG_BUFFER } = getPusherConstants();

    const pusherPromise = startContentPusher({
      baseMsg: msg,
      getContent: () => contentAcc,
      getMaxLength: (isStreaming: boolean) =>
        usePlainResponses
          ? 4000
          : isStreaming
            ? 4096 -
              STREAMING_INDICATOR.length -
              (useSmartSplitting ? CLOSING_TAG_BUFFER : 0)
            : 4096 - (useSmartSplitting ? CLOSING_TAG_BUFFER : 0),
      streamDone: streamingDonePromise,
      warnEmbed,
      useSmartSplitting,
      logger: ctx.logger,
      safeEdit: ctx.safeEdit,
    });

    await streamingDonePromise;
    const reason = await finishReason;

    const requestEndMs = performance.now();
    const ttftSeconds =
      firstTokenMs === null ? null : (firstTokenMs - requestStartMs) / 1000;
    const outputSeconds =
      firstTokenMs === null ? null : (requestEndMs - firstTokenMs) / 1000;

    let { lastMsg, responseQueue, discordMessageCreated } = await pusherPromise;
    if (contentAcc.length === 0) {
      await Promise.all(
        discordMessageCreated.map((messageId: string) =>
          msg.channel.messages.delete(messageId),
        ),
      );
      throw new Error("No content generated");
    }

    if (usePlainResponses) {
      for (const content of responseQueue) {
        lastMsg = await lastMsg.reply({
          content,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    }

    clearInterval(typingInterval);

    ctx.logger.logInfo(`received total text length: ${contentAcc.length}`);
    ctx.logStreamWarning(await warnings);
    ctx.logStreamFinishReason(reason);

    const totalUsage: LanguageModelUsage | null =
      ctx.config.stats_for_nerds && "totalUsage" in stream
        ? (((await (stream as { totalUsage?: Promise<unknown> }).totalUsage) as
            | LanguageModelUsage
            | null
            | undefined) ?? null)
        : null;

    if (ctx.config.debug_message) {
      ctx.logger.logDebug(`Stream finished with reason: ${reason}`);
    }

    if (ctx.config.stats_for_nerds && !usePlainResponses) {
      const field = buildStatsForNerdsField({
        providerModel: ctx.curProviderModel,
        totalUsage,
        ttftSeconds,
        outputSeconds,
      });

      if (field) {
        const emb = warnEmbed
          ? new EmbedBuilder(warnEmbed.toJSON())
          : new EmbedBuilder();

        const desc = responseQueue.at(-1) ?? "";
        emb.setDescription(desc || "*<empty_string>*");
        emb.setColor(3447003);
        emb.addFields(field);
        await ctx.safeEdit(lastMsg, { embeds: [emb] });
      }
    }

    const resp = await response;
    const stripped = stripToolTraffic(resp.messages);

    if (ctx.config.tools?.include_summary) {
      const toolSummary = buildToolAuditNote(resp.messages);
      if (stripped[0]?.role === "assistant" && toolSummary) {
        if (typeof stripped[0].content === "string") {
          stripped[0].content += `\n\n${toolSummary}`;
        } else {
          stripped[0].content.push({ type: "text", text: toolSummary });
        }
      }
    }

    const reasoningMessages: Array<{ text: string }> = [];
    for (const m of resp.messages) {
      if (m.role !== "assistant") continue;
      if (typeof m.content === "string") continue;
      const parts = m.content.filter(
        (p: { type: string }) => p.type === "reasoning",
      );
      if (parts.length === 0) continue;
      reasoningMessages.push(...(parts as Array<{ text: string }>));
    }
    const reasoningResp = await reasoning;

    const reasoningSummary = (
      reasoningResp.length > 0 ? reasoningResp : reasoningMessages
    )
      .map((r) => r.text)
      .join("\n\n");

    await ctx.modelMessageOperator.create({
      messageId: discordMessageCreated,
      parentMessageId: msg.id,
      messages: stripped,
      imageIds:
        currentMessageImageIds.length > 0 ? currentMessageImageIds : undefined,
      reasoningSummary,
    });

    if (reasoningSummary) {
      const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("show_reasoning_modal")
          .setLabel("Show reasoning")
          .setStyle(ButtonStyle.Secondary),
      );
      await ctx.safeEdit(lastMsg, { components: [button] });
    }

    if (ctx.config.stats_for_nerds) {
      ctx.logger.logInfo(
        buildStatsForNerdsLogLine({
          providerModel: ctx.curProviderModel,
          totalUsage,
          ttftSeconds,
          outputSeconds,
        }),
      );
    }
  } finally {
    await btnMessage?.delete().catch(() => {});
  }
}
