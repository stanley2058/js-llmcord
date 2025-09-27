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
} from "ai";
import { cleanupImageCache, getImageUrl } from "./image";
import { inspect } from "bun";
import { ToolManager } from "./tool";
import type { Config } from "./type";

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
const MAX_MESSAGE_NODES = 500;

const EMBED_COLOR_COMPLETE = Colors.DarkGreen;
const EMBED_COLOR_INCOMPLETE = Colors.Orange;

type MsgNode = {
  text: string | null;
  images: Array<{ type: "image"; image: URL | DataContent }>;
  role: "user" | "assistant";
  userId: string | null;
  hasBadAttachments: boolean;
  fetchParentFailed: boolean;
  parentMsg: Message | null;
};

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
  private msgNodes: Map<string, MsgNode> = new Map();
  private imageCacheCleanupInterval: NodeJS.Timeout;
  private toolManager: ToolManager;
  private cachedConfig: Config = {} as Config;

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

    cleanupImageCache().catch(console.error);
    this.imageCacheCleanupInterval = setInterval(
      () => cleanupImageCache().catch(console.error),
      24 * 60 * 60 * 1000,
    );

    this.toolManager = new ToolManager();

    this.client.once("clientReady", () => this.clientReady());
    this.client.on("interactionCreate", this.interactionCreate);
    this.client.on("messageCreate", this.messageCreate);
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
    const { messages, userWarnings } = await this.buildMessages(msg);

    const usePlainResponses = this.cachedConfig.use_plain_responses ?? false;
    const maxMessageLength = usePlainResponses
      ? 4000
      : 4096 - STREAMING_INDICATOR.length;
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
      if ("sendTyping" in msg.channel) await msg.channel.sendTyping();

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
      const restPart = params
        ? { providerOptions: { [provider]: keysToCamel(rest) } }
        : {};

      const tools = toolsDisabledForModel
        ? undefined
        : await this.toolManager.getTools();
      const { textStream, finishReason } = streamText({
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
      });
      if (this.cachedConfig.debug_message) console.log(inspect(messages));
      if (this.cachedConfig.debug_message) console.log(inspect(tools));

      let contentAcc = "";
      let pushedIndex = 0;
      let outputAccLen = 0;
      let lastMsg = msg;
      let flushed = false;
      const responseQueue: string[] = [];
      const { promise: pusherPromise, resolve: pusherResolve } =
        Promise.withResolvers();
      const pusher = setInterval(async () => {
        const upToDate = pushedIndex === contentAcc.length;
        if (flushed && done && upToDate) {
          pusherResolve();
          return clearInterval(pusher);
        }
        if (upToDate) return;

        const chunk = contentAcc.slice(
          pushedIndex,
          pushedIndex + maxMessageLength,
        );
        pushedIndex += chunk.length;
        const pushNew = chunk.length + outputAccLen > maxMessageLength;

        if (pushNew || responseQueue.length === 0) {
          outputAccLen = chunk.length;
          responseQueue.push(chunk);
        } else {
          outputAccLen += chunk.length;
          responseQueue[responseQueue.length - 1] += chunk;
        }

        const emb = warnEmbed
          ? new EmbedBuilder(warnEmbed.toJSON())
          : new EmbedBuilder();

        const accuContent = responseQueue[responseQueue.length - 1]!;
        const desc = done ? accuContent : accuContent + STREAMING_INDICATOR;
        emb.setDescription(desc);
        emb.setColor(done ? EMBED_COLOR_COMPLETE : EMBED_COLOR_INCOMPLETE);
        flushed = done;

        if (pushNew || msg === lastMsg) {
          lastMsg = await this.replyHelper(msg, lastMsg, { embeds: [emb] });
          const node = this.getOrInsertNode(lastMsg.id);
          node.text = chunk;
        } else {
          await lastMsg.edit({ embeds: [emb] });
          const node = this.getOrInsertNode(lastMsg.id);
          node.text += chunk;
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
          lastMsg = await this.replyHelper(msg, lastMsg, { content });
          const node = this.getOrInsertNode(lastMsg.id);
          node.text = content;
        }
      }

      await pusherPromise;
    } catch (e) {
      done = true;
      console.error("Error while generating response", e);
    }

    if (this.msgNodes.size > MAX_MESSAGE_NODES) {
      const keys = [...this.msgNodes.keys()]
        .map((k) => BigInt(k))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const toDrop = keys.slice(0, this.msgNodes.size - MAX_MESSAGE_NODES);
      for (const id of toDrop) {
        const sid = String(id);
        if (!this.msgNodes.has(sid)) continue;
        this.msgNodes.delete(sid);
      }
    }
  };

  private async replyHelper(
    base: Message,
    target: Message,
    payload: { embeds?: EmbedBuilder[]; content?: string },
  ) {
    const replied = await target.reply({
      ...payload,
      allowedMentions: { parse: [], repliedUser: false },
    });
    this.msgNodes.set(replied.id, {
      text: null,
      images: [],
      role: "assistant",
      userId: null,
      hasBadAttachments: false,
      fetchParentFailed: false,
      parentMsg: base,
    });
    return replied;
  }

  private async buildMessages(msg: Message) {
    const visionModels = (VISION_MODEL_TAGS as readonly string[]).concat(
      this.cachedConfig.additional_vision_models || [],
    );
    const acceptImages = visionModels.some((t) =>
      this.curProviderModel.toLowerCase().includes(t),
    );
    const maxText = this.cachedConfig.max_text ?? 100000;
    const maxImages = acceptImages ? (this.cachedConfig.max_images ?? 5) : 0;
    const maxMessages = this.cachedConfig.max_messages ?? 25;

    const messages: ModelMessage[] = [];
    const userWarnings = new Set<string>();
    let currMsg: Message | null = msg;
    while (currMsg && messages.length < maxMessages) {
      const id = currMsg.id;
      const node = this.getOrInsertNode(id);
      try {
        if (node.text === null) {
          const mention = this.client.user ? `<@${this.client.user.id}>` : "";
          const mentionNick = this.client.user
            ? `<@!${this.client.user.id}>`
            : "";
          let content = currMsg.content || "";
          if (content.startsWith(mention))
            content = content.slice(mention.length).trimStart();
          else if (content.startsWith(mentionNick))
            content = content.slice(mentionNick.length).trimStart();

          const embedsText = currMsg.embeds
            .map((e) =>
              [e.title, e.description, e.footer?.text]
                .filter(Boolean)
                .join("\n"),
            )
            .filter((s) => s && s.length > 0) as string[];

          const componentsText: string[] = [];
          for (const row of currMsg.components || []) {
            if (row.type === ComponentType.ActionRow) {
              for (const comp of (row as any).components || []) {
                if (typeof (comp as any).label === "string")
                  componentsText.push((comp as any).label);
              }
            }
          }

          const goodAttachments = [...currMsg.attachments.values()].filter(
            (att) =>
              att.contentType &&
              (att.contentType.startsWith("text") ||
                att.contentType.startsWith("image")),
          );
          const texts: string[] = [];
          const images: Array<{
            type: "image";
            image: URL | DataContent;
          }> = [];
          for (const att of goodAttachments) {
            try {
              if (att.contentType!.startsWith("text")) {
                texts.push(await fetchAttachmentText(att.url));
              } else if (att.contentType!.startsWith("image")) {
                const imageUrl = await getImageUrl(att.url, att.contentType!);
                images.push({
                  type: "image",
                  image: new URL(imageUrl),
                });
              }
            } catch {}
          }

          node.text = [content, ...embedsText, ...componentsText, ...texts]
            .filter(Boolean)
            .join("\n");
          node.images = images;
          node.role =
            currMsg.author.id === this.client.user?.id ? "assistant" : "user";
          node.userId = node.role === "user" ? currMsg.author.id : null;
          node.hasBadAttachments =
            currMsg.attachments.size > goodAttachments.length;

          try {
            let parent: Message | null = null;
            const isPublicThread =
              currMsg.channel.type === ChannelType.PublicThread;
            const parentIsThreadStart =
              isPublicThread &&
              !currMsg.reference &&
              (currMsg.channel as any).parent?.type === ChannelType.GuildText;
            if (
              !currMsg.reference &&
              !content.includes(mention) &&
              !content.includes(mentionNick)
            ) {
              const prev: Collection<string, Message<boolean>> | null =
                await currMsg.channel.messages
                  .fetch({ before: currMsg.id, limit: 1 })
                  .catch(() => null);
              const prevMsg: Message | null =
                prev && prev.first() ? prev.first()! : null;
              if (
                prevMsg &&
                (prevMsg.type === MessageType.Default ||
                  prevMsg.type === MessageType.Reply) &&
                prevMsg.author.id ===
                  (currMsg.channel.type === ChannelType.DM
                    ? this.client.user?.id
                    : currMsg.author.id)
              ) {
                parent = prevMsg;
              }
            }
            if (!parent) {
              if (parentIsThreadStart) {
                const starter = await (currMsg.channel as any)
                  .fetchStarterMessage()
                  .catch(() => null);
                parent = starter as Message | null;
              } else if (currMsg.reference?.messageId) {
                const cached = currMsg.reference?.messageId
                  ? await currMsg.fetchReference().catch(() => null)
                  : null;
                parent = cached as Message | null;
              }
            }
            node.parentMsg = parent;
          } catch {
            node.fetchParentFailed = true;
          }
        }

        const contentArr = node.images.slice(0, maxImages).length
          ? [
              ...asTextContent(node.text?.slice(0, maxText) || null),
              ...node.images.slice(0, maxImages),
            ]
          : node.text
            ? node.text.slice(0, maxText)
            : "";

        if (contentArr !== "") {
          const msg: ModelMessage = {
            content: contentArr as any,
            role: node.role,
          };
          if (node.userId) {
            if (typeof msg.content === "string") {
              msg.content = `[name=${String(node.userId)}]: ${msg.content}`;
            } else {
              for (const c of msg.content || []) {
                if (c.type !== "text") continue;
                c.text = `[name=${String(node.userId)}]: ${c.text}`;
              }
            }
          }
          messages.push(msg);
        }

        if ((node.text || "").length > maxText)
          userWarnings.add(
            `⚠️ Max ${maxText.toLocaleString()} characters per message`,
          );
        if (node.images.length > maxImages)
          userWarnings.add(
            maxImages > 0
              ? `⚠️ Max ${maxImages} image${maxImages === 1 ? "" : "s"} per message`
              : "⚠️ Can't see images",
          );
        if (node.hasBadAttachments)
          userWarnings.add("⚠️ Unsupported attachments");
        if (
          node.fetchParentFailed ||
          (node.parentMsg && messages.length === maxMessages)
        )
          userWarnings.add(
            `⚠️ Only using last ${messages.length} message${messages.length === 1 ? "" : "s"}`,
          );

        currMsg = node.parentMsg;
      } catch (e) {
        console.error(e);
      }
    }

    console.log(
      `Message received (user ID: ${msg.author.id}, attachments: ${msg.attachments.size}, conversation length: ${messages.length}):\n${msg.content}`,
    );

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

    return { messages, userWarnings };
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

  private getOrInsertNode(id: string) {
    const node = this.msgNodes.get(id) || {
      text: null,
      images: [],
      role: "assistant",
      userId: null as string | null,
      hasBadAttachments: false,
      fetchParentFailed: false,
      parentMsg: null as Message | null,
    };
    this.msgNodes.set(id, node);

    return node;
  }

  async destroy() {
    clearInterval(this.imageCacheCleanupInterval);
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

function asTextContent(s: string | null | undefined) {
  return s ? ([{ type: "text", text: s }] as const) : ([] as const);
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
