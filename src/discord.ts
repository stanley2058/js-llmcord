import {
  ActivityType,
  ChannelType,
  Client,
  Collection,
  Colors,
  ComponentType,
  EmbedBuilder,
  GatewayIntentBits,
  Message,
  MessageType,
  Partials,
  type CacheType,
  type Interaction,
} from "discord.js";
import { getConfig } from "./config-parser";
import {
  getProvidersFromConfig,
  parseProviderModelString,
} from "./model-routing";
import {
  stepCountIs,
  type CallWarning,
  type DataContent,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
} from "ai";
import { getImageUrl } from "./image";
import { ToolManager } from "./tool";
import type { Config } from "./type";
import { type StreamTextParams } from "./streaming-compatible";
import { ModelMessageOperator } from "./model-messages";
import {
  getRecommendedMemoryStringForUsers,
  getUsersFromModelMessages,
} from "./rag/recommend";
import { Logger } from "./logger";
import { randomUUID } from "node:crypto";
import { runStreamAttempt } from "./discord/stream-runner";
import { handleInteraction } from "./discord/interaction-handlers";
import { commands } from "./discord/commands";
import { ensureCommands } from "./discord/ensure-commands";
import {
  getAiGatewayOrderFromModelConfig,
  getAnthropicCacheControlFromModelConfig,
  mergeProviderOptions,
  withAnthropicSystemMessageCacheControl,
  withAnthropicToolCacheControl,
} from "./utils/anthropic-cache";

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

export type ModelChannelRef = {
  id: string;
  parentId?: string | null;
};

/**
 * Resolve the effective provider model for a Discord channel (per-channel mode).
 * Logic:
 * - If channel has a parentId (is a thread), check for thread override first
 * - If no thread override but has parentId, check for parent channel override
 * - If no override, use default model
 */
export function getEffectiveProviderModelPerChannel(
  channel: ModelChannelRef,
  overrides: Map<string, string>,
  defaultModel: string,
): string {
  if (channel.parentId) {
    const threadOverride = overrides.get(channel.id);
    if (threadOverride) return threadOverride;

    const parentOverride = overrides.get(channel.parentId);
    if (parentOverride) return parentOverride;

    return defaultModel;
  }

  return overrides.get(channel.id) ?? defaultModel;
}

/**
 * Resolve the effective provider model based on configuration mode.
 * - If per_channel_model is enabled: uses channel overrides with thread inheritance
 * - If per_channel_model is disabled: returns global model (legacy behavior)
 */
export function getEffectiveProviderModel(
  channel: ModelChannelRef,
  perChannelModeEnabled: boolean,
  perChannelOverrides: Map<string, string>,
  defaultModel: string,
  globalModel: string,
): string {
  return perChannelModeEnabled
    ? getEffectiveProviderModelPerChannel(
        channel,
        perChannelOverrides,
        defaultModel,
      )
    : globalModel;
}

export class DiscordOperator {
  private client: Client;
  private defaultProviderModel = "openai/gpt-4o";
  private globalProviderModel = "openai/gpt-4o"; // Used when per_channel_model is disabled (legacy mode)
  private channelProviderModelOverrides = new Map<string, string>();
  private toolManager: ToolManager;
  private cachedConfig: Config = {} as Config;
  private modelMessageOperator = new ModelMessageOperator();
  private trimInterval: NodeJS.Timeout;
  private logger = new Logger({ module: "discord" });
  private statusInterval: NodeJS.Timeout | null = null;
  private cancellationMap = new Map<string, AbortController>();

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

    this.modelMessageOperator.trim().catch((e) => this.logger.logError(e));
    this.trimInterval = setInterval(
      () =>
        this.modelMessageOperator.trim().catch((e) => this.logger.logError(e)),
      1000 * 60 * 60,
    );

    this.client.once("clientReady", () => this.clientReady());
    this.client.on("shardReady", this.setStatus);
    this.client.on("shardResume", this.setStatus);
    this.client.on("shardReconnecting", this.setStatus);
    this.client.on("interactionCreate", this.interactionCreate);
    this.client.on("messageCreate", this.messageCreate);
    this.client.on("messageDelete", this.messageDelete);
  }

  async init() {
    const config = await getConfig();
    this.logger.setLogLevel(config.log_level ?? "info");

    this.cachedConfig = config;
    const firstModel = Object.keys(config.models || {})[0] ?? "openai/gpt-4o";
    this.defaultProviderModel = firstModel;
    this.globalProviderModel = firstModel;

    await this.client.login(config.bot_token);
    await this.toolManager.init();

    this.statusInterval = setInterval(
      () => this.setStatus().catch(this.logger.logError),
      1000 * 60 * 10,
    );
    this.logger.logDebug("Discord operator initialized");
  }

  private async clientReady() {
    this.cachedConfig = await getConfig();
    await ensureCommands({
      client: this.client,
      commands,
      logger: this.logger,
    });
    await this.setStatus();
    const clientId = this.cachedConfig.client_id
      ? String(this.cachedConfig.client_id)
      : "";
    if (clientId) {
      this.logger.logDebug("Discord client ready, bot online");
      this.logger.logInfo(
        `BOT INVITE URL:\nhttps://discord.com/oauth2/authorize?client_id=${clientId}&permissions=412317191168&scope=bot\n`,
      );
    }
  }

  private setStatus = async () => {
    const status = (this.cachedConfig.status_message || "").slice(0, 128);

    this.client.user?.setPresence({
      activities: [{ type: ActivityType.Custom, state: status, name: status }],
      status: "online",
    });
  };

  private interactionCreate = async (interaction: Interaction<CacheType>) => {
    await handleInteraction(interaction, {
      getConfig,
      setCachedConfig: (config: Config) => {
        this.cachedConfig = config;
      },
      getCachedConfig: () => this.cachedConfig,
      getProviderModelForChannel: (channel: {
        id: string;
        parentId?: string | null;
      }) =>
        getEffectiveProviderModel(
          channel,
          this.cachedConfig.per_channel_model ?? false,
          this.channelProviderModelOverrides,
          this.defaultProviderModel,
          this.globalProviderModel,
        ),
      setProviderModelForChannel: (channelId: string, model: string) => {
        this.channelProviderModelOverrides.set(channelId, model);
      },
      setGlobalProviderModel: (model: string) => {
        this.globalProviderModel = model;
      },
      toolManager: this.toolManager,
      cancellationMap: this.cancellationMap,
      modelMessageOperator: this.modelMessageOperator,
      logger: this.logger,
      decodeIds,
    });
  };

  private async prepareMessageCreate(msg: Message) {
    this.cachedConfig = await getConfig();
    // prevent infinite loop
    if (msg.author.bot) return false;
    const isDM = msg.channel.type === ChannelType.DM;
    if (!isDM && !msg.mentions.users.has(this.client.user!.id)) return false;
    const { roleIds, channelIds } = this.getChannelsAndRolesFromMessage(msg);
    const canRespond = this.getChannelPermission({
      messageAuthorId: msg.author.id,
      isDM,
      roleIds,
      channelIds,
    });
    if (!canRespond) return false;
    const effectiveModel = getEffectiveProviderModel(
      msg.channel,
      this.cachedConfig.per_channel_model ?? false,
      this.channelProviderModelOverrides,
      this.defaultProviderModel,
      this.globalProviderModel,
    );
    const { provider, model, gatewayAdapter } =
      parseProviderModelString(effectiveModel);
    const providers = await getProvidersFromConfig();
    if (!providers[provider]) {
      this.logger.logError(`Configuration not found for provider: ${provider}`);
      return false;
    }
    if (gatewayAdapter) {
      this.logger.logInfo(
        `Using: [${provider}] w/ [${model}] via [AI-GATEWAY (${gatewayAdapter})]`,
      );
    } else {
      this.logger.logInfo(`Using: [${provider}] w/ [${model}]`);
    }
    const isAnthropic =
      provider === "anthropic" || model.startsWith("anthropic/");

    let modelInstance: LanguageModel;
    if (provider === "openai") {
      const api =
        this.cachedConfig.providers.openai.api_schema === "responses"
          ? "responses"
          : "completion";
      modelInstance = providers.openai![api](model);
    } else {
      modelInstance = providers[provider]!(model);
    }

    return {
      modelInstance,
      isAnthropic,
      providers,
      provider,
      model,
      gatewayAdapter,
      effectiveModel,
    };
  }

  private async prepareStreamOptions(msg: Message) {
    const prepared = await this.prepareMessageCreate(msg);
    if (!prepared) return false;
    const {
      modelInstance,
      isAnthropic,
      provider,
      gatewayAdapter,
      effectiveModel,
    } = prepared;

    let { messages, userWarnings, currentMessageImageIds } =
      await this.buildMessages(msg, effectiveModel);

    const usePlainResponses = this.cachedConfig.use_plain_responses ?? false;
    let warnEmbed: EmbedBuilder | null = null;
    if (!usePlainResponses) {
      warnEmbed = new EmbedBuilder();
      const sorted = Array.from(userWarnings).sort();
      if (sorted.length) {
        warnEmbed.setFields(
          sorted.map((w) => ({ name: w, value: "", inline: false })),
        );
      }
    }

    const params = this.cachedConfig.models[effectiveModel];
    const {
      tools: useTools,
      anthropic_cache_control,
      anthropic_cache_ttl,
      anthropic_cache_tools,
      ai_gateway_order,
      temperature,
      max_tokens,
      top_p,
      top_k,
      ...rest
    } = params ?? {};
    const toolsDisabledForModel = useTools === false;
    const useCompatibleTools = useTools === "compatible";

    const anthropicCacheControl =
      isAnthropic && anthropic_cache_control
        ? getAnthropicCacheControlFromModelConfig({
            anthropic_cache_control,
            anthropic_cache_ttl,
          })
        : null;

    const gatewayOrder =
      provider === "ai-gateway" && isAnthropic
        ? getAiGatewayOrderFromModelConfig({ ai_gateway_order })
        : null;

    const configProviderKey = gatewayAdapter ?? provider;
    const configProviderOptions = keysToCamel(rest) as Record<string, unknown>;

    const providerOptions = mergeProviderOptions(
      params
        ? {
            [configProviderKey]: configProviderOptions,
          }
        : undefined,
      provider === "ai-gateway" && gatewayOrder
        ? { gateway: { order: gatewayOrder } }
        : undefined,
    ) as StreamTextParams["providerOptions"];

    const restPart = providerOptions ? ({ providerOptions } as const) : {};

    let tools = toolsDisabledForModel
      ? undefined
      : await this.toolManager.getTools();

    if (anthropicCacheControl) {
      this.logger.logDebug(
        "Patching system messages for Anthropic cache control",
      );
      messages = withAnthropicSystemMessageCacheControl(
        messages,
        anthropicCacheControl,
      );

      if (anthropic_cache_tools === true) {
        this.logger.logDebug("Patching tools for Anthropic cache control");
        tools = withAnthropicToolCacheControl(tools, anthropicCacheControl);
      }
    }

    const controller = new AbortController();
    const id = randomUUID();
    this.cancellationMap.set(id, controller);

    const opts: StreamTextParams = {
      model: modelInstance,
      messages: messages.reverse(),
      maxOutputTokens: typeof max_tokens === "number" ? max_tokens : undefined,
      temperature: typeof temperature === "number" ? temperature : undefined,
      topP: typeof top_p === "number" ? top_p : undefined,
      topK: typeof top_k === "number" ? top_k : undefined,
      ...restPart,
      tools,
      stopWhen: stepCountIs(this.cachedConfig.max_steps ?? 10),
      onStepFinish: (step) => {
        for (const toolCall of step.toolCalls || []) {
          this.logger.logInfo(`[Tool Call] Called: \`${toolCall.toolName}\``);
          this.logger.logDebug(JSON.stringify(toolCall.input));
        }
      },
      abortSignal: controller.signal,
    };

    if (this.cachedConfig.additional_headers) {
      if (this.cachedConfig.additional_headers?.user_id?.enabled) {
        const userIds = getUsersFromModelMessages(messages);
        opts.headers = {
          ...opts.headers,
          [this.cachedConfig.additional_headers?.user_id?.header_name]: [
            ...userIds,
          ].join(","),
        };
      }
    }

    if (tools && useCompatibleTools) {
      this.logger.logDebug("Using tools in compatible mode");
    }

    return {
      id,
      opts,
      messages,
      currentMessageImageIds,
      compatibleMode: Boolean(tools && useCompatibleTools),
      usePlainResponses,
      warnEmbed,
      anthropicCacheControl,
      effectiveModel,
    };
  }

  private logStreamWarning(warns: CallWarning[] | null | undefined) {
    if (!warns || warns.length === 0) return;
    this.logger.logWarn("Warnings from model provider:");
    for (const warn of warns) {
      switch (warn.type) {
        case "unsupported-setting":
          this.logger.logWarn(
            `Unsupported setting: ${warn.setting}`,
            warn.details,
          );
          break;
        case "unsupported-tool":
          this.logger.logWarn(`Unsupported tool: ${warn.tool}`, warn.details);
          break;
        case "other":
          this.logger.logWarn(warn.message);
          break;
      }
    }
  }

  private logStreamFinishReason(reason: FinishReason) {
    switch (reason) {
      case "stop":
      case "tool-calls":
        this.logger.logInfo(`stream finished with reason: ${reason}`);
        break;
      case "length":
        this.logger.logWarn("context too long, truncate input and try again");
        break;
      case "error":
        this.logger.logError("error while generating response");
        break;
      case "content-filter":
        this.logger.logWarn("blocked by content filter");
        break;
      case "other":
      case "unknown":
        this.logger.logInfo(`stream finished with unknown reason (${reason})`);
        break;
    }
  }

  private messageCreate = async (msg: Message) => {
    const options = await this.prepareStreamOptions(msg);
    if (!options) return;
    const {
      id,
      opts,
      messages,
      currentMessageImageIds,
      compatibleMode,
      usePlainResponses,
      warnEmbed,
      anthropicCacheControl,
      effectiveModel,
    } = options;

    const typingInterval = setInterval(() => this.sendTyping(msg), 1000 * 5);
    try {
      this.sendTyping(msg);

      const generateStream = async () => {
        await runStreamAttempt({
          ctx: {
            logger: this.logger,
            config: this.cachedConfig,
            curProviderModel: effectiveModel,
            safeEdit: this.safeEdit.bind(this),
            logStreamWarning: this.logStreamWarning.bind(this),
            logStreamFinishReason: this.logStreamFinishReason.bind(this),
            modelMessageOperator: this.modelMessageOperator,
          },
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
        });
      };

      const maxRetry = Math.max(1, this.cachedConfig.max_retry ?? 3);
      for (let i = 0; i < maxRetry; i++) {
        try {
          await generateStream();
          break;
        } catch (e) {
          if (i + 1 === maxRetry) throw e;
          this.logger.logError(
            `Encountered error while generating response, trying ({${i + 1}/${maxRetry}}`,
            e,
          );
        }
      }
    } catch (e) {
      this.logger.logError("Error while generating response", e);
    } finally {
      clearInterval(typingInterval);
      this.cancellationMap.delete(id);
    }
  };

  private messageDelete = async (msg: { id: string }) => {
    await this.modelMessageOperator.removeAll(msg.id);
  };

  private sendTyping(msg: Message) {
    if (!("sendTyping" in msg.channel)) return;
    msg.channel.sendTyping().catch(console.error);
  }

  /**
   * Safely edit a message, ensuring it's authored by the bot.
   * Returns false if the message was not edited (not owned by bot).
   */
  private async safeEdit(
    msg: Message,
    options: Parameters<Message["edit"]>[0],
  ): Promise<boolean> {
    if (msg.author.id !== this.client.user?.id) {
      this.logger.logError(
        `Attempted to edit message not authored by bot: ${msg.id}`,
      );
      return false;
    }
    await msg.edit(options);
    return true;
  }

  private async buildMessages(msg: Message, effectiveModel: string) {
    const params = this.cachedConfig.models[effectiveModel];
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
        } = await this.messageToModelMessages(currMsg, effectiveModel);

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

    this.logger.logInfo(
      `Message received (user ID: ${msg.author.id}, attachments: ${msg.attachments.size}, conversation length: ${messages.length}):\n${msg.content}`,
    );

    if (!toolsDisabledForModel && this.cachedConfig.rag?.enable) {
      const userIds = getUsersFromModelMessages(messages);
      const memories = await getRecommendedMemoryStringForUsers([
        ...userIds,
        "self",
      ]);
      messages.push(...memories);

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
        "\n\n" +
        "<discord-system>\n" +
        "- Users' names are their Discord IDs and should be typed as '<@ID>'.\n" +
        "- There might be multiple people tagging you in the chat; identify different people using their ID.\n" +
        "  <example>\n" +
        "    <message>\n" +
        "    user_id: 123456789\n" +
        "    username: exampleUser1234\n" +
        "    content: |\n" +
        "    Hello world.\n" +
        "    </message>\n" +
        "  </example>\n" +
        "</discord-system>\n";
      messages.push({ role: "system", content: sys });
    }

    return { messages, userWarnings, currentMessageImageIds };
  }

  private async messageToModelMessages(msg: Message, effectiveModel: string) {
    const visionModels = (VISION_MODEL_TAGS as readonly string[]).concat(
      this.cachedConfig.additional_vision_models || [],
    );
    const acceptImages = visionModels.some((t) =>
      effectiveModel.toLowerCase().includes(t),
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
          this.logger.logError(e);
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
        this.logger.logError(e);
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
        const username = msg.author.username;
        if (typeof contentArr === "string") {
          contentArr =
            "<message>\n" +
            `user_id: ${userId}\n` +
            `username: ${username}\n` +
            `content: |\n${contentArr}\n` +
            "</message>\n";
        } else {
          for (const c of contentArr || []) {
            if (c.type !== "text") continue;
            c.text =
              "<message>\n" +
              `user_id: ${userId}\n` +
              `username: ${username}\n` +
              `content: |\n${c.text}\n` +
              "</message>\n";
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
      this.logger.logError(e);
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

  async destroy() {
    clearInterval(this.trimInterval);
    if (this.statusInterval) clearInterval(this.statusInterval);

    this.client.off("messageDelete", this.messageDelete);
    this.client.off("messageCreate", this.messageCreate);
    this.client.off("interactionCreate", this.interactionCreate);
    this.client.off("shardReady", this.setStatus);
    this.client.off("shardResume", this.setStatus);
    this.client.off("shardReconnecting", this.setStatus);

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
  const tzShort =
    d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop() ||
    "UTC";
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    weekday: "short",
  });
  return {
    date: `${date} (${tzShort})`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${tzShort})`,
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
