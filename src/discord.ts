import {
  ActivityType,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  Client,
  Collection,
  Colors,
  ComponentType,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionType,
  Message,
  MessageFlags,
  MessageType,
  Partials,
  type CacheType,
  type Interaction,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { getConfig } from "./config-parser";
import {
  getProvidersFromConfig,
  parseProviderModelString,
} from "./model-routing";
import {
  stepCountIs,
  streamText,
  type DataContent,
  type ModelMessage,
  type TextPart,
} from "ai";
import { getImageUrl } from "./image";
import { inspect } from "bun";
import { ToolManager } from "./tool";
import type { Config } from "./type";
import {
  streamTextWithCompatibleTools,
  type StreamTextParams,
} from "./streaming-compatible";
import { ModelMessageOperator } from "./model-messages";

const VISION_MODEL_TAGS = [
  "claude",
  "gemini",
  "gemma",
  "gpt-4",
  "gpt-5",
  "grok-4",
  "llama",
  "llava",
  "mistral",
  "o3",
  "o4",
  "vision",
  "vl",
] as const;

const STREAMING_INDICATOR = " ⚪";
const EDIT_DELAY_SECONDS = 1;

const EMBED_COLOR_COMPLETE = Colors.DarkGreen;
const EMBED_COLOR_INCOMPLETE = Colors.Orange;

const Warning = {
  maxText: "⚠️ Exceeding max text length per message.",
  maxImages: "⚠️ Exceeding max images per message.",
  cannotSeeImages: "⚠️ Model cannot see images.",
  unsupportedAttachments: "⚠️ Unsupported attachments.",
  messageHistoryTruncated: "⚠️ Older message history truncated.",
} as const;

type JSONLike =
  | null
  | string
  | number
  | boolean
  | JSONLike[]
  | { [k: string]: JSONLike };

export class DiscordOperator {
  private client: Client;
  private curProviderModel = "openai/gpt-4o";
  private toolManager: ToolManager;
  private cachedConfig: Config = {} as Config;
  private lastTypingSentAt = new Map<string, number>();
  private modelMessageOperator = new ModelMessageOperator();
  private trimInterval: NodeJS.Timeout;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.toolManager = new ToolManager();

    this.modelMessageOperator.trim().catch(console.error);
    this.trimInterval = setInterval(
      () => this.modelMessageOperator.trim().catch(console.error),
      1000 * 60 * 60,
    );

    this.client.once("clientReady", () => this.clientReady());
    this.client.on("interactionCreate", this.interactionCreate);
    this.client.on("messageCreate", this.messageCreate);
    this.client.on("messageDelete", this.messageDelete);
  }

  async init() {
    const config = await getConfig();
    this.cachedConfig = config;
    this.curProviderModel =
      Object.keys(config.models || {})[0] ?? "openai/gpt-4o";

    await this.client.login(config.bot_token);
    await this.toolManager.init();
  }

  private async ensureCommands() {
    this.cachedConfig = await getConfig();
    if (!this.client.application) throw new Error("Client not initialized");
    const name = "model";
    const data: RESTPostAPIApplicationCommandsJSONBody = {
      name,
      description: "View or switch the current model",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "model",
          description: "Model name",
          required: true,
          autocomplete: true,
        },
      ],
    };
    const cmds = await this.client.application.commands.fetch();
    const existing = cmds.find((c) => c.name === name);
    if (!existing) await this.client.application.commands.create(data);
  }

  private async clientReady() {
    this.cachedConfig = await getConfig();
    await this.ensureCommands();
    const status = (this.cachedConfig.status_message || "").slice(0, 128);

    this.client.user?.setPresence({
      activities: [{ type: ActivityType.Custom, state: status, name: status }],
      status: "online",
    });
    const clientId = this.cachedConfig.client_id
      ? String(this.cachedConfig.client_id)
      : "";
    if (clientId) {
      console.log(
        `\n\nBOT INVITE URL:\nhttps://discord.com/oauth2/authorize?client_id=${clientId}&permissions=412317191168&scope=bot\n`,
      );
    }
  }

  private interactionCreate = async (interaction: Interaction<CacheType>) => {
    this.cachedConfig = await getConfig();

    if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
      const focused = interaction.options.getFocused(true);
      if (interaction.commandName === "model" && focused.name === "model") {
        try {
          if (interaction.responded) return;
          const curr = this.curProviderModel;
          const currStr = String(focused.value || "").toLowerCase();
          const choices: Array<{ name: string; value: string }> = [];
          if (curr.toLowerCase().includes(currStr))
            choices.push({ name: `◉ ${curr} (current)`, value: curr });
          for (const m of Object.keys(this.cachedConfig.models || {})) {
            if (m === curr) continue;
            if (!m.toLowerCase().includes(currStr)) continue;
            choices.push({ name: `○ ${m}`, value: m });
          }
          await interaction.respond(choices.slice(0, 25));
        } catch (e) {
          console.error(e);
          if (interaction.responded) return;
          try {
            await interaction.respond([]);
          } catch (e) {
            console.error(e);
          }
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "model") {
      const model = interaction.options.getString("model", true);
      const isDM = interaction.channel?.type === ChannelType.DM;
      const adminIds = decodeIds(this.cachedConfig.permissions.users.admin_ids);
      const userIsAdmin = adminIds.has(interaction.user.id);
      let output = "";

      switch (true) {
        case model === this.curProviderModel:
          output = `Current model: \`${this.curProviderModel}\``;
          break;
        case userIsAdmin:
          this.curProviderModel = model;
          output = `Model switched to: \`${model}\``;
          console.log(output);
          break;
        default:
          output = "You don't have permission to change the model.";
          break;
      }

      await interaction.reply({
        content: output,
        flags: isDM ? MessageFlags.Ephemeral : undefined,
      });
    }
  };

  private messageCreate = async (msg: Message) => {
    this.cachedConfig = await getConfig();
    // prevent infinite loop
    if (msg.author.bot) return;
    const isDM = msg.channel.type === ChannelType.DM;
    if (!isDM && !msg.mentions.users.has(this.client.user!.id)) return;
    const { roleIds, channelIds } = this.getChannelsAndRolesFromMessage(msg);
    const canRespond = this.getChannelPermission({
      messageAuthorId: msg.author.id,
      isDM,
      roleIds,
      channelIds,
    });
    if (!canRespond) return;
    const { provider, model } = parseProviderModelString(this.curProviderModel);
    const providers = await getProvidersFromConfig();
    if (!providers[provider]) {
      console.error(`Configuration not found for provider: ${provider}`);
      return;
    }
    console.log(`Using: [${provider}] w/ [${model}]`);
    const modelInstance = providers[provider]!(model);
    const { messages, userWarnings, currentMessageImageIds } =
      await this.buildMessages(msg);

    const usePlainResponses = this.cachedConfig.use_plain_responses ?? false;
    let warnEmbed: EmbedBuilder | null = null;
    if (!usePlainResponses) {
      warnEmbed = new EmbedBuilder();
      const sorted = Array.from(userWarnings).sort();
      if (sorted.length)
        warnEmbed.setFields(
          sorted.map((w) => ({ name: w, value: "", inline: false })),
        );
    }

    let done = false;
    try {
      await this.sendTyping(msg);

      // Decide if tools should be enabled for this model
      const params = this.cachedConfig.models[this.curProviderModel];
      const {
        tools: useTools,
        temperature,
        max_tokens,
        top_p,
        top_k,
        ...rest
      } = params ?? {};
      const toolsDisabledForModel = useTools === false;
      const useCompatibleTools = useTools === "compatible";
      const restPart = params
        ? { providerOptions: { [provider]: keysToCamel(rest) } }
        : {};

      const tools = toolsDisabledForModel
        ? undefined
        : await this.toolManager.getTools();

      const opts: StreamTextParams = {
        model: modelInstance,
        messages: messages.reverse(),
        maxOutputTokens:
          typeof max_tokens === "number" ? max_tokens : undefined,
        temperature: typeof temperature === "number" ? temperature : undefined,
        topP: typeof top_p === "number" ? top_p : undefined,
        topK: typeof top_k === "number" ? top_k : undefined,
        ...restPart,
        tools,
        stopWhen: stepCountIs(this.cachedConfig.max_steps ?? 10),
      };

      const stream = useCompatibleTools
        ? streamTextWithCompatibleTools(opts)
        : streamText(opts);

      const { textStream, finishReason, response } = stream;
      if (this.cachedConfig.debug_message) console.log(inspect(messages));

      let contentAcc = "";
      let pushedIndex = 0;
      let lastMsg = msg;
      const discordMessageCreated: string[] = [];
      let flushed = false;
      const responseQueue: string[] = [];
      const { promise: pusherPromise, resolve: pusherResolve } =
        Promise.withResolvers();
      let pushing = false;
      const getMaxForCurrent = (isStreaming: boolean) =>
        usePlainResponses
          ? 4000
          : isStreaming
            ? 4096 - STREAMING_INDICATOR.length
            : 4096;
      const pusher = setInterval(async () => {
        if (pushing) return; // prevent re-entrancy
        pushing = true;
        try {
          const upToDate = pushedIndex === contentAcc.length;
          if (flushed && done && upToDate) {
            pusherResolve();
            clearInterval(pusher);
            return;
          }
          if (upToDate || (done && !flushed)) return;

          // Consume all new data since last tick
          const delta = contentAcc.slice(pushedIndex);
          pushedIndex = contentAcc.length;

          // Ensure at least one bucket
          if (responseQueue.length === 0) responseQueue.push("");

          let i = 0;
          while (i < delta.length) {
            const isStreamingEmbed = !done && i < delta.length; // last (active) bucket
            const maxLen = getMaxForCurrent(isStreamingEmbed);

            const lastIdx = responseQueue.length - 1;
            const lastLen = responseQueue[lastIdx]!.length;
            const room = Math.max(0, maxLen - lastLen);

            if (room === 0) {
              // Start a new bucket
              responseQueue.push("");
              continue;
            }

            const take = Math.min(room, delta.length - i);
            responseQueue[lastIdx] += delta.slice(i, i + take);
            i += take;
          }

          const emb = warnEmbed
            ? new EmbedBuilder(warnEmbed.toJSON())
            : new EmbedBuilder();

          const accuContent = responseQueue[responseQueue.length - 1]!;
          const desc = done ? accuContent : accuContent + STREAMING_INDICATOR;
          emb.setDescription(desc);
          emb.setColor(done ? EMBED_COLOR_COMPLETE : EMBED_COLOR_INCOMPLETE);
          flushed = done;

          if (!flushed) await this.sendTyping(msg);
          else this.lastTypingSentAt.delete(msg.channel.id);

          // New Discord message only when a new bucket appeared (or first send)
          if (
            discordMessageCreated.length < responseQueue.length ||
            msg === lastMsg
          ) {
            lastMsg = await lastMsg.reply({
              embeds: [emb],
              allowedMentions: { parse: [], repliedUser: false },
            });
            discordMessageCreated.push(lastMsg.id);
          } else {
            await lastMsg.edit({ embeds: [emb] });
          }
        } finally {
          pushing = false;
        }
      }, EDIT_DELAY_SECONDS * 1000);

      for await (const textPart of textStream) contentAcc += textPart;
      await finishReason;
      done = true;

      if (this.cachedConfig.debug_message) {
        console.log(`Stream finished with reason: ${await finishReason}`);
      }

      if (usePlainResponses) {
        for (const content of responseQueue) {
          lastMsg = await lastMsg.reply({
            content,
            allowedMentions: { parse: [], repliedUser: false },
          });
        }
      }

      await pusherPromise;

      const resp = await response;
      await this.modelMessageOperator.create({
        messageId: discordMessageCreated,
        parentMessageId: msg.id,
        messages: resp.messages,
        imageIds:
          currentMessageImageIds.length > 0
            ? currentMessageImageIds
            : undefined,
      });
    } catch (e) {
      done = true;
      console.error("Error while generating response", e);
    }
  };

  private messageDelete = async (msg: { id: string }) => {
    await this.modelMessageOperator.removeAll(msg.id);
  };

  private async buildMessages(msg: Message) {
    const params = this.cachedConfig.models[this.curProviderModel];
    const { tools: useTools } = params ?? {};
    const toolsDisabledForModel = useTools === false;
    const maxMessages = this.cachedConfig.max_messages ?? 25;

    let currMsg: Message | null = msg;
    const messages: ModelMessage[] = []; // new -> old
    const userWarnings = new Set<string>();
    let currentMessageImageIds: string[] = [];
    while (currMsg && messages.length < maxMessages) {
      let history = this.modelMessageOperator.getAll(currMsg.id);
      if (history.length > 0) {
        if (history.length + messages.length > maxMessages) {
          userWarnings.add(Warning.messageHistoryTruncated);
          history = history.slice(0, maxMessages - messages.length);
        }
        messages.push(...history.flatMap((h) => h.model_message));

        const lastId = history.at(-1)!.parent_message_id;

        if (lastId) {
          currMsg = await msg.channel.messages.fetch(lastId);
        } else {
          currMsg = null;
        }
      } else {
        const {
          parent,
          message,
          userWarnings: uw,
          imageIds,
        } = await this.messageToModelMessages(currMsg);

        if (message) {
          messages.push(message);

          // a parent not in db
          if (currMsg.id !== msg.id) {
            await this.modelMessageOperator.create({
              messageId: currMsg.id,
              parentMessageId: currMsg.reference?.messageId,
              messages: [message],
              imageIds,
            });
          } else {
            currentMessageImageIds = imageIds || [];
          }
        }

        if (uw) for (const w of uw) userWarnings.add(w);
        currMsg = parent;
      }
    }

    console.log(
      `Message received (user ID: ${msg.author.id}, attachments: ${msg.attachments.size}, conversation length: ${messages.length}):\n${msg.content}`,
    );

    if (!toolsDisabledForModel && this.cachedConfig.rag?.enable) {
      messages.push({
        role: "system",
        content:
          "You have access to long-term memory tools, use them on behalf of the following rules:\n" +
          "- When a user shares stable facts, preferences, or ongoing goals that are useful for future conversations, store them. (`rememberUserContext`)\n" +
          "- Before giving advice that depends on user context, recall relevant memory. (`recallUserContext`)\n" +
          "- If an item is retracted or incorrect, forget it and optionally store the update. (`forgetUserContext`)\n" +
          "Above rules also applies to you, use `user_id: 'self'` to store your own memory.",
      });
    }

    if (this.cachedConfig.system_prompt) {
      const { date, time } = nowIsoLike();
      let sys = (this.cachedConfig.system_prompt || "")
        .replace("{date}", date)
        .replace("{time}", time)
        .trim();
      sys +=
        "\n\nUser's names are their Discord IDs and should be typed as '<@ID>'.";
      messages.push({ role: "system", content: sys });
    }

    return { messages, userWarnings, currentMessageImageIds };
  }

  private async messageToModelMessages(msg: Message) {
    const visionModels = (VISION_MODEL_TAGS as readonly string[]).concat(
      this.cachedConfig.additional_vision_models || [],
    );
    const acceptImages = visionModels.some((t) =>
      this.curProviderModel.toLowerCase().includes(t),
    );
    const maxText = this.cachedConfig.max_text ?? 100000;
    const maxImages = acceptImages ? (this.cachedConfig.max_images ?? 5) : 0;

    const userWarnings = new Set<string>();
    try {
      const mention = this.client.user ? `<@${this.client.user.id}>` : "";
      const mentionNick = this.client.user ? `<@!${this.client.user.id}>` : "";
      let content = msg.content || "";
      if (content.startsWith(mention))
        content = content.slice(mention.length).trimStart();
      else if (content.startsWith(mentionNick))
        content = content.slice(mentionNick.length).trimStart();

      const embedsText = msg.embeds
        .map((e) =>
          [e.title, e.description, e.footer?.text].filter(Boolean).join("\n"),
        )
        .filter((s) => s && s.length > 0) as string[];

      const componentsText: string[] = [];
      for (const row of msg.components || []) {
        if (row.type === ComponentType.ActionRow) {
          for (const comp of row.components || []) {
            if ("label" in comp && typeof comp.label === "string") {
              componentsText.push(comp.label);
            }
          }
        }
      }

      const goodAttachments = [...msg.attachments.values()].filter(
        (att) =>
          att.contentType &&
          (att.contentType.startsWith("text") ||
            att.contentType.startsWith("image")),
      );
      if (goodAttachments.length !== msg.attachments.size) {
        userWarnings.add(Warning.unsupportedAttachments);
      }

      const texts: string[] = [];
      const images: Array<{
        type: "image";
        image: URL | DataContent;
      }> = [];
      const imageIds: string[] = [];
      for (const att of goodAttachments) {
        try {
          if (att.contentType!.startsWith("text")) {
            texts.push(await fetchAttachmentText(att.url));
          } else if (att.contentType!.startsWith("image")) {
            const image = await getImageUrl(att.url, att.contentType!);
            if (typeof image === "string") {
              images.push({
                type: "image",
                image: image,
              });
            } else {
              imageIds.push(image.key);
              images.push({
                type: "image",
                image: new URL(image.url),
              });
            }
          }
        } catch (e) {
          console.error(e);
        }
      }
      if (images.length > maxImages) {
        userWarnings.add(
          maxImages > 0 ? Warning.maxImages : Warning.cannotSeeImages,
        );
      }

      const combinedText = [content, ...embedsText, ...componentsText, ...texts]
        .filter(Boolean)
        .join("\n");

      const role =
        msg.author.id === this.client.user?.id ? "assistant" : "user";

      let parent: Message | null = null;
      try {
        const isPublicThread = msg.channel.type === ChannelType.PublicThread;
        const parentIsThreadStart =
          isPublicThread &&
          !msg.reference &&
          msg.channel.parent?.type === ChannelType.GuildText;
        if (
          !msg.reference &&
          !content.includes(mention) &&
          !content.includes(mentionNick)
        ) {
          const prev: Collection<string, Message<boolean>> | null =
            await msg.channel.messages
              .fetch({ before: msg.id, limit: 1 })
              .catch(() => null);
          const prevMsg: Message | null =
            prev && prev.first() ? prev.first()! : null;
          if (
            prevMsg &&
            (prevMsg.type === MessageType.Default ||
              prevMsg.type === MessageType.Reply) &&
            prevMsg.author.id ===
              (msg.channel.type === ChannelType.DM
                ? this.client.user?.id
                : msg.author.id)
          ) {
            parent = prevMsg;
          }
        }
        if (!parent) {
          if (parentIsThreadStart) {
            const starter = await msg.channel
              .fetchStarterMessage()
              .catch(() => null);
            parent = starter;
          } else if (msg.reference?.messageId) {
            const cached = msg.reference?.messageId
              ? await msg.fetchReference().catch(() => null)
              : null;
            parent = cached as Message | null;
          }
        }
      } catch (e) {
        console.error(e);
        parent = null;
      }

      let contentArr = images.slice(0, maxImages).length
        ? [
            { type: "text" as const, text: combinedText.slice(0, maxText) },
            ...images.slice(0, maxImages),
          ]
        : combinedText.slice(0, maxText);

      if (contentArr === "") return { parent };
      if (role === "user") {
        const userId = msg.author.id;
        if (typeof contentArr === "string") {
          contentArr = `[name=${String(userId)}]: ${contentArr}`;
        } else {
          for (const c of contentArr || []) {
            if (c.type !== "text") continue;
            c.text = `[name=${String(userId)}]: ${c.text}`;
          }
        }

        return {
          parent,
          userWarnings,
          imageIds,
          message: {
            role,
            content: contentArr,
          } satisfies ModelMessage,
        };
      } else {
        return {
          parent,
          userWarnings,
          message: {
            role,
            content: contentArr as string | TextPart[],
          } satisfies ModelMessage,
        };
      }
    } catch (e) {
      console.error(e);
    }
    return { parent: null };
  }

  private getChannelsAndRolesFromMessage(msg: Message) {
    const roleIds = new Set(
      msg.member?.roles.cache ? [...msg.member.roles.cache.keys()] : [],
    );

    const channelIds = new Set<string>();
    channelIds.add(msg.channel.id);

    if ("parentId" in msg.channel && msg.channel.parentId) {
      channelIds.add(msg.channel.parentId);
    }
    if (
      "parent" in msg.channel &&
      msg.channel.parent &&
      msg.channel.parent.parentId
    ) {
      channelIds.add(msg.channel.parent.parentId);
    }

    return { roleIds, channelIds };
  }

  private getChannelPermission({
    messageAuthorId,
    isDM,
    roleIds,
    channelIds,
  }: {
    messageAuthorId: string;
    isDM: boolean;
    roleIds: Set<string>;
    channelIds: Set<string>;
  }) {
    const allowDMs = this.cachedConfig.allow_dms ?? true;

    const {
      admin_ids: adminIds,
      allowed_ids: allowedUserIds,
      blocked_ids: blockedUserIds,
    } = this.cachedConfig.permissions.users;

    const { allowed_ids: allowedRoleIds, blocked_ids: blockedRoleIds } =
      this.cachedConfig.permissions.roles;

    const { allowed_ids: allowedChannelIds, blocked_ids: blockedChannelIds } =
      this.cachedConfig.permissions.channels;

    const userIsAdmin = adminIds.includes(messageAuthorId);
    if (userIsAdmin) return true;

    const allowAllUsers = isDM
      ? allowedUserIds.length === 0
      : allowedUserIds.length === 0 && allowedRoleIds.length === 0;
    const allowAllChannels = allowedChannelIds.length === 0;

    if (allowAllUsers && allowAllChannels) return true;

    const isGoodUser =
      allowAllUsers ||
      allowedUserIds.includes(messageAuthorId) ||
      [...roleIds].some((r) => allowedRoleIds.includes(r));
    const isBadUser =
      !isGoodUser ||
      blockedUserIds.includes(messageAuthorId) ||
      [...roleIds].some((r) => blockedRoleIds.includes(r));

    const goodByDMOrGlobal = isDM ? allowDMs : allowAllChannels;
    const isGoodChannel =
      goodByDMOrGlobal ||
      [...channelIds].some((c) => allowedChannelIds.includes(c));
    const isBadChannel =
      !isGoodChannel ||
      [...channelIds].some((c) => blockedChannelIds.includes(c));

    if (isBadUser || isBadChannel) return false;
    return true;
  }

  private async sendTyping(msg: Message) {
    const TYPING_EXPIRY = 8 * 1000; // actually 10s, but with some buffer
    const now = Date.now();
    const last = this.lastTypingSentAt.get(msg.channel.id);
    const canTrigger = !last || now - last > TYPING_EXPIRY;
    if (!canTrigger) return;
    if ("sendTyping" in msg.channel) {
      await msg.channel.sendTyping();
      this.lastTypingSentAt.set(msg.channel.id, now);
    }
  }

  async destroy() {
    clearInterval(this.trimInterval);
    this.client.off("messageDelete", this.messageDelete);
    this.client.off("messageCreate", this.messageCreate);
    this.client.off("interactionCreate", this.interactionCreate);
    await this.client.destroy();
  }
}

function decodeIds(xs: Array<string | number> | undefined): Set<string> {
  return new Set((xs || []).map((x) => String(x)));
}

async function fetchAttachmentText(url: string) {
  const res = await fetch(url);
  return await res.text();
}

function nowIsoLike() {
  const d = new Date();
  const pad = (n: number, z = 2) => String(n).padStart(z, "0");
  const sign = d.getTimezoneOffset() > 0 ? "-" : "+";
  const off = Math.abs(d.getTimezoneOffset());
  const hh = pad(Math.floor(off / 60));
  const mm = pad(off % 60);
  const tzShort =
    d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop() ||
    "UTC";
  return {
    date: d.toLocaleDateString("en-US", {
      month: "long",
      day: "2-digit",
      year: "numeric",
    }),
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tzShort}${sign}${hh}${mm}`,
  };
}

const toCamel = (s: string): string =>
  s.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());

function keysToCamel<T extends JSONLike>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((v) => keysToCamel(v)) as T;
  }

  if (input !== null && typeof input === "object") {
    const out: Record<string, JSONLike> = {};
    for (const [k, v] of Object.entries(input)) {
      const newKey = toCamel(k);
      out[newKey] = keysToCamel(v as JSONLike);
    }
    return out as T;
  }

  // Primitives
  return input;
}
