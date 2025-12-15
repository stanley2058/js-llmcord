import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type ApplicationCommandData,
} from "discord.js";

export const commands: Record<string, ApplicationCommandData> = {
  model: {
    name: "model",
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
  },
  "reload-tools": {
    name: "reload-tools",
    description: "Reload tools",
    type: ApplicationCommandType.ChatInput,
  },
  tools: {
    name: "tools",
    description:
      "Toggle tools for the models (use `/list-tools` to see available tools)",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "tools",
        description: "Tools to toggle on/off (comma-separated)",
        required: true,
      },
    ],
  },
  "list-tools": {
    name: "list-tools",
    description: "List all available tools",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "tool",
        description: "Tool to get details for",
        required: false,
      },
    ],
  },
};
