import { EmbedBuilder, type Message } from "discord.js";
import { setTimeout } from "node:timers/promises";
import { chunkMarkdownForEmbeds } from "../markdown-chunker";
import type { Logger } from "../logger";

const STREAMING_INDICATOR = " ⚪";
const EDIT_DELAY_SECONDS = 0.1;
// Buffer for potential closing tags when splitting markdown (worst case: **~~*` needs `*~~**)
const CLOSING_TAG_BUFFER = 10;

const EMBED_COLOR_COMPLETE = 3447003; // Colors.Blue
const EMBED_COLOR_INCOMPLETE = 16705372; // Colors.Yellow

export type SafeEdit = (
  msg: Message,
  options: Parameters<Message["edit"]>[0],
) => Promise<boolean>;

export async function startContentPusher({
  baseMsg,
  getContent,
  getMaxLength,
  streamDone,
  warnEmbed,
  useSmartSplitting,
  logger,
  safeEdit,
}: {
  baseMsg: Message;
  getContent: () => string;
  getMaxLength: (isStreaming: boolean) => number;
  streamDone: Promise<void>;
  warnEmbed: EmbedBuilder | null;
  useSmartSplitting: boolean;
  logger: Logger;
  safeEdit: SafeEdit;
}): Promise<{
  lastMsg: Message;
  responseQueue: string[];
  discordMessageCreated: string[];
}> {
  let streaming = true;
  let loopIterations = 0;
  streamDone.then(() => {
    streaming = false;
    logger.logDebug(
      `[Pusher] streamDone resolved, loopIterations=${loopIterations}, contentLength=${getContent().length}`,
    );
  });

  const chunkMessages: Message[] = [];
  const discordMessageCreated: string[] = [];

  // Cache the last embed state we sent, to avoid spamming the Discord API.
  const sentDescriptions: string[] = [];
  const sentColors: number[] = [];

  // Last computed display chunks (no indicator).
  let responseQueue: string[] = [];

  const buildEmbed = (description: string, color: number) => {
    const emb = warnEmbed
      ? new EmbedBuilder(warnEmbed.toJSON())
      : new EmbedBuilder();
    emb.setDescription(description || "*\<empty_string\>*");
    emb.setColor(color);
    return emb;
  };

  const addStreamingIndicator = (chunk: string) => {
    // If the chunk ends with a block-closing marker, keep that marker intact
    // on its own line (e.g. ``` or $$) so the block still renders.
    const lines = chunk.split("\n");
    for (let j = lines.length - 1; j >= 0; j--) {
      const trimmed = (lines[j] ?? "").trim();
      if (trimmed.length === 0) continue;

      if (trimmed === "```" || trimmed === "$$") {
        // Keep indicator length stable ("\n⚪" vs " ⚪").
        return chunk + "\n" + STREAMING_INDICATOR.trimStart();
      }
      break;
    }

    return chunk + STREAMING_INDICATOR;
  };

  const syncToDiscord = async (content: string): Promise<boolean> => {
    // Reserve room for the streaming indicator in the last chunk, even after the
    // stream is done. This keeps message boundaries stable and avoids shrinking.
    const maxChunkLength = getMaxLength(false);
    const maxLastChunkLength = getMaxLength(true);

    const displayChunks = chunkMarkdownForEmbeds(content, {
      maxChunkLength,
      maxLastChunkLength,
      useSmartSplitting,
    });

    responseQueue = displayChunks;

    if (displayChunks.length === 0) {
      return false;
    }

    let didUpdate = false;

    for (let i = 0; i < displayChunks.length; i++) {
      const chunk = displayChunks[i] ?? "";
      const isLast = i === displayChunks.length - 1;
      const showStreamIndicator = streaming && isLast;

      const description = showStreamIndicator
        ? addStreamingIndicator(chunk)
        : chunk;
      const color = showStreamIndicator
        ? EMBED_COLOR_INCOMPLETE
        : EMBED_COLOR_COMPLETE;

      const emb = buildEmbed(description, color);

      if (i >= chunkMessages.length) {
        const parent = i === 0 ? baseMsg : chunkMessages[i - 1]!;
        const msg = await parent.reply({
          embeds: [emb],
          allowedMentions: { parse: [], repliedUser: false },
        });

        chunkMessages.push(msg);
        discordMessageCreated.push(msg.id);
        sentDescriptions[i] = description;
        sentColors[i] = color;
        didUpdate = true;
        continue;
      }

      if (sentDescriptions[i] !== description || sentColors[i] !== color) {
        await safeEdit(chunkMessages[i]!, { embeds: [emb] });
        sentDescriptions[i] = description;
        sentColors[i] = color;
        didUpdate = true;
      }
    }

    return didUpdate;
  };

  while (true) {
    loopIterations++;
    const content = getContent();
    const didUpdate = await syncToDiscord(content);

    if (!streaming) {
      // Keep syncing until we observe a stable (fully finalized) state.
      if (!didUpdate) {
        logger.logDebug(
          `[Pusher] exiting loop: iterations=${loopIterations}, contentLength=${content.length}, messagesCreated=${discordMessageCreated.length}`,
        );
        break;
      }
      continue;
    }

    await setTimeout(EDIT_DELAY_SECONDS * 1000);
  }

  const lastMsg = chunkMessages.at(-1) ?? baseMsg;

  return {
    lastMsg,
    responseQueue,
    discordMessageCreated,
  };
}

export function getPusherConstants() {
  return {
    STREAMING_INDICATOR,
    CLOSING_TAG_BUFFER,
  };
}
