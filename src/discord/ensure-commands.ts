import type { ApplicationCommandData, Client } from "discord.js";
import type { Logger } from "../logger";

export async function ensureCommands({
  client,
  commands,
  logger,
}: {
  client: Client;
  commands: Record<string, ApplicationCommandData>;
  logger: Logger;
}): Promise<void> {
  if (!client.application) throw new Error("Client not initialized");
  const cmds = await client.application.commands.fetch();
  const existing = new Map(cmds.map((c) => [c.name, c]));

  for (const [name, cmd] of Object.entries(commands)) {
    logger.logDebug(`Register ${name} command`);
    const found = existing.get(name);
    if (found) {
      await found.edit(cmd);
    } else {
      await client.application.commands.create(cmd);
    }
  }
}
