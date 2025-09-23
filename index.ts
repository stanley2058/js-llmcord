import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageType,
  EmbedBuilder,
  Colors,
  ActivityType,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type Message,
  type RESTPostAPIApplicationCommandsJSONBody,
  InteractionType,
  ComponentType,
} from "discord.js";
import OpenAI from "openai";
import YAML from "yaml";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

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
const PROVIDERS_SUPPORTING_USERNAMES = ["openai", "x-ai"] as const;

const STREAMING_INDICATOR = " ⚪";
const EDIT_DELAY_SECONDS = 1;
const MAX_MESSAGE_NODES = 500;

const EMBED_COLOR_COMPLETE = Colors.DarkGreen;
const EMBED_COLOR_INCOMPLETE = Colors.Orange;

type RoleType = "user" | "assistant";

type ModelMessage = {
  role: RoleType | "system";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
  name?: string;
};

type ProviderConfig = {
  base_url: string;
  api_key?: string;
  extra_headers?: Record<string, string>;
  extra_query?: Record<string, string>;
  extra_body?: Record<string, unknown>;
};

type Permissions = {
  users: {
    admin_ids: Array<string | number>;
    allowed_ids: Array<string | number>;
    blocked_ids: Array<string | number>;
  };
  roles: {
    allowed_ids: Array<string | number>;
    blocked_ids: Array<string | number>;
  };
  channels: {
    allowed_ids: Array<string | number>;
    blocked_ids: Array<string | number>;
  };
};

type Config = {
  bot_token: string;
  client_id?: string | number | null;
  status_message?: string | null;
  max_text?: number;
  max_images?: number;
  max_messages?: number;
  use_plain_responses?: boolean;
  allow_dms?: boolean;
  permissions: Permissions;
  providers: Record<string, ProviderConfig>;
  models: Record<string, Record<string, unknown> | undefined>;
  system_prompt?: string | null;
};

class Lock {
  private locked = false;
  private waiting: Array<() => void> = [];
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((res) => this.waiting.push(res));
    this.locked = true;
    return () => this.release();
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.locked = false;
  }
}

type MsgNode = {
  text: string | null;
  images: Array<{ type: "image_url"; image_url: { url: string } }>;
  role: RoleType;
  userId: string | null;
  hasBadAttachments: boolean;
  fetchParentFailed: boolean;
  parentMsg: Message | null;
  lock: Lock;
  release?: () => void;
};

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

async function getConfig(filename = "config.yaml"): Promise<Config> {
  const raw = await readFile(filename, { encoding: "utf-8" });
  const parsed = YAML.parse(raw) as Config;
  return parsed;
}

function firstModelKey(cfg: Config): string {
  const keys = Object.keys(cfg.models || {});
  return keys[0] || "openai/gpt-4o";
}

const msgNodes = new Map<string, MsgNode>();
let lastTaskTime = 0;
let config: Config;
let currModel: string;

function truncate128(s: string) {
  return s.length <= 128 ? s : s.slice(0, 128);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function decodeIds(xs: Array<string | number> | undefined): Set<string> {
  return new Set((xs || []).map((x) => String(x)));
}

function includesAnyTag(model: string, tags: readonly string[]) {
  const lower = model.toLowerCase();
  return tags.some((t) => lower.includes(t));
}

function bufferToBase64(buf: ArrayBuffer | Uint8Array | Buffer) {
  if (buf instanceof Buffer) return buf.toString("base64");
  if (buf instanceof Uint8Array) return Buffer.from(buf).toString("base64");
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}

async function ensureCommands() {
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
  const cmds = await client.application!.commands.fetch();
  const existing = cmds.find((c) => c.name === name);
  if (!existing) await client.application!.commands.create(data);
}

client.once("ready", async () => {
  try {
    await ensureCommands();
  } catch {}
  const status = truncate128(
    config.status_message || "github.com/jakobdylanc/llmcord",
  );
  try {
    // Cast to any to allow Custom status with state in v14 types
    client.user?.setPresence({
      activities: [{ type: ActivityType.Custom, state: status } as any],
      status: "online",
    } as any);
  } catch {}
  const clientId = config.client_id ? String(config.client_id) : "";
  if (clientId) {
    console.log(
      `\n\nBOT INVITE URL:\nhttps://discord.com/oauth2/authorize?client_id=${clientId}&permissions=412317191168&scope=bot\n`,
    );
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    const focused = interaction.options.getFocused(true);
    if (interaction.commandName === "model" && focused.name === "model") {
      try {
        if (String(focused.value || "") === "") {
          try {
            config = await getConfig();
          } catch {}
        }
        const curr = currModel;
        const currStr = String(focused.value || "").toLowerCase();
        const choices: Array<{ name: string; value: string }> = [];
        if (curr.toLowerCase().includes(currStr))
          choices.push({ name: `◉ ${curr} (current)`, value: curr });
        for (const m of Object.keys(config.models || {})) {
          if (m === curr) continue;
          if (!m.toLowerCase().includes(currStr)) continue;
          choices.push({ name: `○ ${m}`, value: m });
        }
        await interaction.respond(choices.slice(0, 25));
      } catch {
        try {
          await interaction.respond([]);
        } catch {}
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "model") {
    const model = interaction.options.getString("model", true);
    const isDM = interaction.channel?.type === ChannelType.DM;
    const adminIds = decodeIds(config.permissions?.users?.admin_ids || []);
    const userIsAdmin = adminIds.has(interaction.user.id);
    let output: string;
    if (model === currModel) {
      output = `Current model: \`${currModel}\``;
    } else if (userIsAdmin) {
      currModel = model;
      output = `Model switched to: \`${model}\``;
      console.log(output);
    } else {
      output = "You don't have permission to change the model.";
    }
    await interaction.reply({ content: output, ephemeral: isDM });
  }
});

function asTextContent(s: string | null | undefined) {
  return s ? ([{ type: "text", text: s }] as const) : ([] as const);
}

async function fetchAttachmentText(url: string) {
  const res = await fetch(url);
  return await res.text();
}

async function fetchAttachmentBytes(url: string) {
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  return new Uint8Array(arr);
}

async function replyHelper(
  baseMsg: Message,
  responses: Message[],
  payload: { embeds?: EmbedBuilder[]; content?: string },
) {
  const target: Message = responses.length
    ? (responses[responses.length - 1] as Message)
    : baseMsg;
  const replied = await target.reply({
    ...payload,
    allowedMentions: { parse: [], repliedUser: false },
  });
  responses.push(replied);
  const node: MsgNode = {
    text: null,
    images: [],
    role: "assistant",
    userId: null,
    hasBadAttachments: false,
    fetchParentFailed: false,
    parentMsg: baseMsg,
    lock: new Lock(),
  };
  msgNodes.set(replied.id, node);
  node.release = await node.lock.acquire();
}

client.on("messageCreate", async (newMsg) => {
  if (newMsg.author.bot) return;
  const isDM = newMsg.channel.type === ChannelType.DM;
  if (!isDM) {
    if (!newMsg.mentions.users.has(client.user!.id)) return;
  }

  const roleIds = new Set<string>(
    newMsg.member?.roles?.cache ? [...newMsg.member.roles.cache.keys()] : [],
  );

  const channelIds = new Set<string>();
  channelIds.add(newMsg.channel.id);
  if ((newMsg.channel as any).parentId)
    channelIds.add(String((newMsg.channel as any).parentId));
  if ((newMsg.channel as any).parent?.parentId)
    channelIds.add(String((newMsg.channel as any).parent.parentId));

  try {
    config = await getConfig();
  } catch (e) {
    console.error("Failed to read config.yaml", e);
    return;
  }

  const allowDMs = config.allow_dms ?? true;
  const permissions = config.permissions;
  const adminIds = decodeIds(permissions.users.admin_ids);
  const allowedUserIds = decodeIds(permissions.users.allowed_ids);
  const blockedUserIds = decodeIds(permissions.users.blocked_ids);
  const allowedRoleIds = decodeIds(permissions.roles.allowed_ids);
  const blockedRoleIds = decodeIds(permissions.roles.blocked_ids);
  const allowedChannelIds = decodeIds(permissions.channels.allowed_ids);
  const blockedChannelIds = decodeIds(permissions.channels.blocked_ids);

  const userIsAdmin = adminIds.has(newMsg.author.id);

  const allowAllUsers = isDM
    ? allowedUserIds.size === 0
    : allowedUserIds.size === 0 && allowedRoleIds.size === 0;
  const isGoodUser =
    userIsAdmin ||
    allowAllUsers ||
    allowedUserIds.has(newMsg.author.id) ||
    [...roleIds].some((r) => allowedRoleIds.has(r));
  const isBadUser =
    !isGoodUser ||
    blockedUserIds.has(newMsg.author.id) ||
    [...roleIds].some((r) => blockedRoleIds.has(r));

  const allowAllChannels = allowedChannelIds.size === 0;
  const goodByDMOrGlobal = isDM ? allowDMs : allowAllChannels;
  const isGoodChannel =
    userIsAdmin ||
    goodByDMOrGlobal ||
    [...channelIds].some((c) => allowedChannelIds.has(c));
  const isBadChannel =
    !isGoodChannel || [...channelIds].some((c) => blockedChannelIds.has(c));

  if (isBadUser || isBadChannel) return;

  const providerSlashModel = currModel;
  const core = providerSlashModel.replace(/:vision$/i, "");
  const parts = core.split("/", 2);
  const provider = parts[0] || "";
  const model = parts[1] || "";
  const providerCfg = config.providers[provider];
  if (!providerCfg) {
    console.error("Provider not found in config for model", providerSlashModel);
    return;
  }
  const baseURL = providerCfg.base_url;
  const apiKey = providerCfg.api_key || "sk-no-key-required";
  const openai = new OpenAI({ baseURL, apiKey });

  const modelParameters = config.models[providerSlashModel];
  const extraHeaders = providerCfg.extra_headers || undefined;
  const extraQuery = providerCfg.extra_query || undefined;
  const extraBody = {
    ...(providerCfg.extra_body || {}),
    ...(modelParameters || {}),
  };

  const acceptImages = includesAnyTag(providerSlashModel, VISION_MODEL_TAGS);
  const acceptUsernames = includesAnyTag(
    providerSlashModel,
    PROVIDERS_SUPPORTING_USERNAMES,
  );

  const maxText = config.max_text ?? 100000;
  const maxImages = acceptImages ? (config.max_images ?? 5) : 0;
  const maxMessages = config.max_messages ?? 25;

  const messages: ModelMessage[] = [];
  const userWarnings = new Set<string>();
  let currMsg: Message | null = newMsg as Message | null;

  while (currMsg && messages.length < maxMessages) {
    const id = currMsg.id;
    const node = msgNodes.get(id) || {
      text: null,
      images: [],
      role: "assistant" as RoleType,
      userId: null as string | null,
      hasBadAttachments: false,
      fetchParentFailed: false,
      parentMsg: null as Message | null,
      lock: new Lock(),
    };
    msgNodes.set(id, node);

    const release = await node.lock.acquire();
    try {
      if (node.text == null) {
        const mention = client.user ? `<@${client.user.id}>` : "";
        const mentionNick = client.user ? `<@!${client.user.id}>` : "";
        let content = currMsg.content || "";
        if (content.startsWith(mention))
          content = content.slice(mention.length).trimStart();
        else if (content.startsWith(mentionNick))
          content = content.slice(mentionNick.length).trimStart();

        const embedsText = currMsg.embeds
          .map((e) =>
            [e.title, e.description, e.footer?.text].filter(Boolean).join("\n"),
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
        const images: Array<{ type: "image_url"; image_url: { url: string } }> =
          [];
        for (const att of goodAttachments) {
          try {
            if (att.contentType!.startsWith("text")) {
              texts.push(await fetchAttachmentText(att.url));
            } else if (att.contentType!.startsWith("image")) {
              const bytes = await fetchAttachmentBytes(att.url);
              const b64 = bufferToBase64(bytes);
              images.push({
                type: "image_url",
                image_url: { url: `data:${att.contentType};base64,${b64}` },
              });
            }
          } catch {}
        }

        node.text = [content, ...embedsText, ...componentsText, ...texts]
          .filter(Boolean)
          .join("\n");
        node.images = images;
        node.role =
          currMsg.author.id === client.user?.id ? "assistant" : "user";
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
            const prev = await currMsg.channel.messages
              .fetch({ before: currMsg.id, limit: 1 })
              .catch(() => null);
            const prevMsg = prev && prev.first() ? prev.first()! : null;
            if (
              prevMsg &&
              (prevMsg.type === MessageType.Default ||
                prevMsg.type === MessageType.Reply) &&
              prevMsg.author.id ===
                (currMsg.channel.type === ChannelType.DM
                  ? client.user?.id
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
        if (acceptUsernames && node.userId) {
          msg.name = String(node.userId);
        } else if (node.userId) {
          msg.content = `[name=${node.userId}]: ${msg.content}`;
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
    } finally {
      release();
    }
  }

  console.log(
    `Message received (user ID: ${newMsg.author.id}, attachments: ${newMsg.attachments.size}, conversation length: ${messages.length}):\n${newMsg.content}`,
  );

  if (config.system_prompt) {
    const { date, time } = nowIsoLike();
    let sys = (config.system_prompt || "")
      .replace("{date}", date)
      .replace("{time}", time)
      .trim();
    sys +=
      "\n\nUser's names are their Discord IDs and should be typed as '<@ID>'.";
    messages.push({ role: "system", content: sys });
  }

  let currContent: string | null = null;
  let finishReason: string | null = null;
  const responseMsgs: Message[] = [];
  const responseContents: string[] = [];

  const usePlainResponses = config.use_plain_responses ?? false;
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

  try {
    await newMsg.channel.sendTyping();

    const params: any = {
      model,
      messages: messages.slice().reverse(),
      stream: true,
      ...extraBody,
    };

    const stream = await openai.chat.completions.create(params, {
      headers: extraHeaders,
      query: extraQuery,
    } as any);

    for await (const chunk of stream as any) {
      if (finishReason != null) break;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      finishReason = choice.finish_reason || null;
      const prev = currContent || "";
      currContent = choice.delta?.content || "";
      const newContent = finishReason == null ? prev : prev + currContent;
      if (responseContents.length === 0 && newContent === "") continue;
      const startNext =
        responseContents.length === 0 ||
        (responseContents[responseContents.length - 1] + newContent).length >
          maxMessageLength;
      if (startNext) responseContents.push("");
      responseContents[responseContents.length - 1] += newContent;

      if (!usePlainResponses) {
        const timeDelta = Date.now() / 1000 - lastTaskTime;
        const readyToEdit = timeDelta >= EDIT_DELAY_SECONDS;
        const current = responseContents[responseContents.length - 1] ?? "";
        const currDelta = currContent ?? "";
        const msgSplitIncoming =
          finishReason == null &&
          (current + currDelta).length > maxMessageLength;
        const isFinalEdit = finishReason != null || msgSplitIncoming;
        const isGoodFinish =
          finishReason != null &&
          ["stop", "end_turn"].includes(String(finishReason).toLowerCase());
        if (startNext || readyToEdit || isFinalEdit) {
          const emb = warnEmbed
            ? new EmbedBuilder(warnEmbed.toJSON() as any)
            : new EmbedBuilder();
          emb.setDescription(
            isFinalEdit ? current : current + STREAMING_INDICATOR,
          );
          emb.setColor(
            msgSplitIncoming || isGoodFinish
              ? EMBED_COLOR_COMPLETE
              : EMBED_COLOR_INCOMPLETE,
          );
          if (startNext) {
            await replyHelper(newMsg, responseMsgs, { embeds: [emb] });
          } else {
            if (!readyToEdit)
              await new Promise((r) =>
                setTimeout(r, (EDIT_DELAY_SECONDS - timeDelta) * 1000),
              );
            const last = responseMsgs[responseMsgs.length - 1];
            if (last) await last.edit({ embeds: [emb] }).catch(() => {});
          }
          lastTaskTime = Date.now() / 1000;
        }
      }
    }

    if (usePlainResponses) {
      for (const content of responseContents) {
        await replyHelper(newMsg, responseMsgs, { content });
      }
    }
  } catch (e) {
    console.error("Error while generating response", e);
  }

  for (const m of responseMsgs) {
    const node = msgNodes.get(m.id);
    if (node) {
      node.text = responseContents.join("");
      if (node.release) node.release();
    }
  }

  if (msgNodes.size > MAX_MESSAGE_NODES) {
    const keys = [...msgNodes.keys()]
      .map((k) => BigInt(k))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const toDrop = keys.slice(0, msgNodes.size - MAX_MESSAGE_NODES);
    for (const id of toDrop) {
      const node =
        msgNodes.get(String(id)) || ({ lock: new Lock() } as MsgNode);
      const rel = await node.lock.acquire();
      try {
        msgNodes.delete(String(id));
      } finally {
        rel();
      }
    }
  }
});

async function main() {
  config = await getConfig();
  currModel = firstModelKey(config);
  await client.login(config.bot_token);
}

main().catch(() => {});
