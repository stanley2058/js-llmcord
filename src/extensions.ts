import type { Tool } from "ai";
import { readdir } from "fs/promises";
import path from "path";

export async function loadExtensions() {
  const files = await readdir(path.join(import.meta.dirname, "../extensions/"));
  const extensionFiles = files.filter((f) => {
    if (f === "example.ts") return false;
    return f.endsWith(".ts") || f.endsWith(".js");
  });

  const tools = await Promise.allSettled(
    extensionFiles.map(async (f) => {
      console.log(`Loading extension [${f}]`);
      const mod = await import(`../extensions/${f}`);
      return mod.default() as Promise<Record<string, Tool>>;
    }),
  );

  const failed = tools.filter((t) => t.status === "rejected");
  if (failed.length > 0) {
    console.error(
      "Error loading extensions:",
      failed.map((t) => t.reason),
    );
  }

  const succeed = tools.filter((t) => t.status === "fulfilled");
  return succeed
    .map((t) => t.value)
    .reduce((acc, tools) => ({ ...acc, ...tools }), {} as Record<string, Tool>);
}
