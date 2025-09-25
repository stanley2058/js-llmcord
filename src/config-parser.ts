import { UTApi } from "uploadthing/server";
import type { Config } from "./type";

let utApiInitToken: string | null = null;
let utApi: UTApi | null = null;
export async function getConfig() {
  const configPlain = await Bun.file("./config.json").text();
  const config = Bun.YAML.parse(configPlain) as Config;

  const utToken =
    config.uploadthing_apikey || process.env.UPLOADTHING_TOKEN || null;

  if (utApiInitToken !== utToken) {
    utApiInitToken = utToken;
    utApi = utToken ? new UTApi({ token: utToken }) : null;
  }

  return { ...config, utApi };
}
