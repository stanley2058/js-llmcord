import { UTApi } from "uploadthing/server";
import config from "../config.yaml";

let utApiInitToken: string | null = null;
let utApi: UTApi | null = null;
export function getConfig() {
  const utToken =
    config.uploadthing_apikey || process.env.UPLOADTHING_TOKEN || null;

  if (utApiInitToken !== utToken) {
    utApiInitToken = utToken;
    utApi = utToken ? new UTApi({ token: utToken }) : null;
  }

  return { ...config, utApi };
}
