import { DiscordOperator } from "./src/discord";

const discordOperator = new DiscordOperator();
async function main() {
  await discordOperator.login();
}

process.on("SIGINT", async () => {
  await discordOperator.destroy();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await discordOperator.destroy();
  process.exit(0);
});

main().catch(console.error);
