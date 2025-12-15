import {
  ActionRowBuilder,
  ChannelType,
  InteractionType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type CacheType,
  type Interaction,
} from "discord.js";
import type { Logger } from "../logger";

export type InteractionHandlerContext = {
  getConfig: () => Promise<unknown>;
  setCachedConfig: (config: unknown) => void;
  getCachedConfig: () => any;
  getCurProviderModel: () => string;
  setCurProviderModel: (model: string) => void;
  toolManager: {
    disabledTools: Set<string>;
    getAllTools: () => Promise<Record<string, any> | undefined>;
    destroy: () => Promise<void>;
    init: () => Promise<void>;
  };
  cancellationMap: Map<string, AbortController>;
  modelMessageOperator: {
    getReasoning: (messageId: string) => any;
  };
  logger: Logger;
  decodeIds: (xs: Array<string | number> | undefined) => Set<string>;
};

export async function handleInteraction(
  interaction: Interaction<CacheType>,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const config = await ctx.getConfig();
  ctx.setCachedConfig(config);
  const cachedConfig = ctx.getCachedConfig();

  if (interaction.isButton()) {
    if (interaction.customId === "show_reasoning_modal") {
      ctx.logger.logDebug("[Interaction] show_reasoning_modal");

      const messageId = interaction.message.id;
      const reasoning = ctx.modelMessageOperator.getReasoning(messageId);
      const existing = reasoning?.reasoning_summary ?? "No reasoning found.";

      const modal = new ModalBuilder()
        .setCustomId(`reasoning_modal:${messageId}`)
        .setTitle("Reasoning summary");

      const input = new TextInputBuilder()
        .setCustomId("reasoning_text")
        .setLabel("Model's reasoning summary")
        .setStyle(TextInputStyle.Paragraph)
        .setValue(existing.slice(0, 1900))
        .setRequired(false);

      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId.startsWith("cancel_")) {
      const id = interaction.customId.replace("cancel_", "");
      const controller = ctx.cancellationMap.get(id);

      if (!controller) {
        await interaction.reply({
          content: "This generation is no longer active.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      controller.abort();
      ctx.cancellationMap.delete(id);
      await interaction.reply({
        content: "Request cancelled.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    const focused = interaction.options.getFocused(true);
    if (interaction.commandName === "model" && focused.name === "model") {
      ctx.logger.logDebug("[Interaction] model");
      try {
        if (interaction.responded) return;
        const curr = ctx.getCurProviderModel();
        const currStr = String(focused.value || "").toLowerCase();
        const choices: Array<{ name: string; value: string }> = [];
        if (curr.toLowerCase().includes(currStr))
          choices.push({ name: `◉ ${curr} (current)`, value: curr });
        for (const m of Object.keys(cachedConfig.models || {})) {
          if (m === curr) continue;
          if (!m.toLowerCase().includes(currStr)) continue;
          choices.push({ name: `○ ${m}`, value: m });
        }
        await interaction.respond(choices.slice(0, 25));
      } catch (e) {
        ctx.logger.logError(e);
        if (interaction.responded) return;
        try {
          await interaction.respond([]);
        } catch (e) {
          ctx.logger.logError(e);
        }
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const isDM = interaction.channel?.type === ChannelType.DM;

  if (interaction.commandName === "model") {
    const model = interaction.options.getString("model", true);
    const adminIds = ctx.decodeIds(cachedConfig.permissions.users.admin_ids);
    const userIsAdmin = adminIds.has(interaction.user.id);
    let output = "";

    switch (true) {
      case model === ctx.getCurProviderModel():
        output = `Current model: \`${ctx.getCurProviderModel()}\``;
        break;
      case userIsAdmin:
        ctx.setCurProviderModel(model);
        output = `Model switched to: \`${model}\``;
        ctx.logger.logInfo(output);
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

  if (interaction.commandName === "tools") {
    const toolsRaw = interaction.options.getString("tools", true);
    const adminIds = ctx.decodeIds(cachedConfig.permissions.users.admin_ids);
    const userIsAdmin = adminIds.has(interaction.user.id);

    let output = "";
    if (!userIsAdmin) {
      output = "You don't have permission to change the model.";
    } else {
      const tools = toolsRaw.split(",").map((t) => t.trim());
      const outputs: string[] = [];
      for (const tool of tools) {
        if (ctx.toolManager.disabledTools.has(tool)) {
          ctx.toolManager.disabledTools.delete(tool);
          outputs.push(`- ◉ \`${tool}\``);
        } else {
          ctx.toolManager.disabledTools.add(tool);
          outputs.push(`- ○ \`${tool}\``);
        }
      }
      output = "**Updated tools:**\n" + outputs.join("\n");
      ctx.logger.logInfo(output);
    }

    await interaction.reply({
      content: output,
      flags: isDM ? MessageFlags.Ephemeral : undefined,
    });
  }

  if (interaction.commandName === "list-tools") {
    const toolDetail = interaction.options.getString("tool", false);
    await interaction.deferReply({
      flags: isDM ? MessageFlags.Ephemeral : undefined,
    });

    const allTools = await ctx.toolManager.getAllTools();
    const tools = Object.keys(allTools || {});
    const list: string[] = [];
    for (const tool of tools) {
      const { description } = allTools?.[tool] || {};
      let output = "";
      if (ctx.toolManager.disabledTools.has(tool)) {
        output = `- ○ \`${tool}\``;
      } else {
        output = `- ◉ \`${tool}\``;
      }
      if (toolDetail && toolDetail === tool) output += `\n  - ${description}`;
      list.push(output);
    }
    await interaction.editReply({ content: list.join("\n").slice(0, 2000) });
  }

  if (interaction.commandName === "reload-tools") {
    await interaction.deferReply({
      flags: isDM ? MessageFlags.Ephemeral : undefined,
    });
    await interaction.editReply({ content: "Reloading tools..." });
    await ctx.toolManager.destroy();
    await ctx.toolManager.init();
    ctx.logger.logDebug("[Interaction] reload-tools");
    await interaction.editReply({ content: "Tools reloaded." });
  }
}
