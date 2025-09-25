import { getConfig } from "./config-parser";
import db from "./db";

export async function getImageUrl(
  originalUrl: string,
  contentType: string,
): Promise<string> {
  const config = await getConfig();

  // Fetch image data to compute content hash
  const bytes = await fetchAttachmentBytes(originalUrl);
  const imageHash = Bun.hash(bytes).toString(36);

  // Check cache first using content hash
  const cached = db
    .query("SELECT uploadthing_url FROM image_cache WHERE url_hash = ?")
    .get(imageHash) as { uploadthing_url: string } | null;
  if (cached) {
    return cached.uploadthing_url;
  }

  // If no UploadThing config, or image is small, return base64
  const MAX_B64_SIZE = 1 * 1024 * 1024; // 1MB
  const MAX_B64_LENGTH = 100000; // limit token size, since claude treats this as input token
  const b64 = bufferToBase64(bytes);
  const isSmall = bytes.length <= MAX_B64_SIZE && b64.length <= MAX_B64_LENGTH;
  if (!config.utApi || isSmall) {
    console.log(
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
    console.log("Uploading image to UploadThing, url:", response.data?.ufsUrl);

    if (response.error) {
      console.error("UploadThing upload failed:", response.error);
      // Fall back to base64 even if large
      const b64 = bufferToBase64(bytes);
      return `data:${contentType};base64,${b64}`;
    }

    const uploadedUrl = response.data.ufsUrl;

    // Cache the result keyed by content hash
    db.run(
      "INSERT OR REPLACE INTO image_cache (url_hash, original_url, uploadthing_url, created_at) VALUES (?, ?, ?, ?)",
      [imageHash, originalUrl, uploadedUrl, Date.now()],
    );

    return uploadedUrl;
  } catch (error) {
    console.error("Error uploading image:", error);
    // Fall back to base64
    const b64 = bufferToBase64(bytes);
    return `data:${contentType};base64,${b64}`;
  }
}

export function cleanupImageCache() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const deleted = db.run("DELETE FROM image_cache WHERE created_at < ?", [
    sevenDaysAgo,
  ]);
  if (deleted.changes > 0) {
    console.log(`Cleaned up ${deleted.changes} old cached images`);
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
