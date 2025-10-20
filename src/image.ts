import { getConfig } from "./config-parser";
import db from "./db";
import { Logger } from "./logger";

export async function getImageUrl(originalUrl: string, contentType: string) {
  const config = await getConfig();
  const logger = new Logger({ module: "image" });

  // Fetch image data to compute content hash
  const bytes = await fetchAttachmentBytes(originalUrl);

  // If no UploadThing config, or image is small, return base64
  const MAX_B64_SIZE = 1 * 1024 * 1024; // 1MB
  const MAX_B64_LENGTH = 100000; // limit token size, since claude treats this as input token
  const b64 = bufferToBase64(bytes);
  const isSmall = bytes.length <= MAX_B64_SIZE && b64.length <= MAX_B64_LENGTH;
  if (!config.utApi || isSmall) {
    logger.logInfo(
      `Using base64 for image, size: ${bytes.length}, b64len: ${b64.length}`,
    );
    return `data:${contentType};base64,${b64}`;
  }

  try {
    // Create a File-like object for UploadThing
    const file = new File(
      [bytes],
      `image.${contentType.split("/")[1] || "png"}`,
      { type: contentType },
    );

    // Upload to UploadThing
    const response = await config.utApi.uploadFiles(file);
    logger.logInfo(
      "Uploading image to UploadThing, url:",
      response.data?.ufsUrl,
    );

    if (response.error) {
      logger.logError("UploadThing upload failed:", response.error);
      // Fall back to base64 even if large
      const b64 = bufferToBase64(bytes);
      return `data:${contentType};base64,${b64}`;
    }

    const uploadedUrl = response.data.ufsUrl;

    // Cache the result keyed by content hash
    db.run(
      "INSERT OR REPLACE INTO image_cache (uploadthing_id, uploadthing_url, original_url, created_at) VALUES (?, ?, ?, ?)",
      [response.data.key, uploadedUrl, originalUrl, Date.now()],
    );

    return { key: response.data.key, url: uploadedUrl };
  } catch (error) {
    logger.logError("Error uploading image:", error);
    // Fall back to base64
    const b64 = bufferToBase64(bytes);
    return `data:${contentType};base64,${b64}`;
  }
}

function bufferToBase64(buf: ArrayBuffer | Uint8Array | Buffer) {
  if (buf instanceof Buffer) return buf.toString("base64");
  if (buf instanceof Uint8Array) return Buffer.from(buf).toString("base64");
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}

async function fetchAttachmentBytes(url: string) {
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  return new Uint8Array(arr);
}
