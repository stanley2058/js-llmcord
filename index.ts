import { DiscordOperator } from "./src/discord";

const discordOperator = new DiscordOperator();
async function main() {
  await discordOperator.init();
}

process.on("SIGINT", async () => {
  await discordOperator.destroy();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await discordOperator.destroy();
  process.exit(0);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", reason, promise);
});

main().catch(console.error);
