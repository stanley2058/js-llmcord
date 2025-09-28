import db from "./db";
import type { DbModelMessage } from "./type";
import JSON from "superjson";
import { getConfig } from "./config-parser";
import type { ModelMessage } from "ai";

export class ModelMessageOperator {
  getAll(messageId: string) {
    return this.getAllRaw(messageId).map((m) => ({
      ...m,
      model_message: JSON.parse(m.model_message) as ModelMessage[],
    }));
  }

  getAllRaw(messageId: string): DbModelMessage[] {
    const message = db
      .query(`SELECT * FROM model_messages WHERE message_id = ?`)
      .get(messageId) as DbModelMessage | null;
    if (!message) return [];
    if (message.parent_message_id) {
      return [message, ...this.getAllRaw(message.parent_message_id)];
    }
    return [message];
  }

  async create({
    messageId,
    parentMessageId,
    messages,
    imageIds,
  }: {
    messageId: string | string[];
    parentMessageId?: string;
    messages: ModelMessage[];
    imageIds?: string[];
  }) {
    const messageIds = Array.isArray(messageId) ? messageId : [messageId];

    for (const id of messageIds) {
      db.run(
        "INSERT INTO model_messages (message_id, model_message, image_ids, parent_message_id, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          id,
          JSON.stringify(messages),
          imageIds ? JSON.stringify(imageIds) : null,
          parentMessageId ?? null,
          Date.now(),
        ],
      );
    }
  }

  async removeAll(messageId: string) {
    const msg = db
      .query(`SELECT * FROM model_messages WHERE message_id = ?`)
      .get(messageId) as DbModelMessage | null;
    if (!msg) return;

    const toDelete: string[] = [];
    const imagesToDelete: string[] = msg.image_ids ? [msg.image_ids] : [];
    const queue = [messageId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id) continue;
      toDelete.push(id);

      const children = db
        .query(`SELECT * FROM model_messages WHERE parent_message_id = ?`)
        .all(id) as DbModelMessage[];
      queue.push(...children.map((c) => c.message_id));
      imagesToDelete.push(
        ...(children.map((c) => c.image_ids).filter(Boolean) as string[]),
      );
    }

    const actualImageIds = imagesToDelete.flatMap(
      (ids) => JSON.parse(ids) as string[],
    );

    const config = await getConfig();
    if (config.utApi) {
      try {
        await config.utApi.deleteFiles(actualImageIds);
      } catch (e) {
        console.error("Error deleting from UploadThing:", e);
        return;
      }
    }

    const MAX_BATCH_DELETE = 900;

    let imgDelOffset = 0;
    while (imgDelOffset < actualImageIds.length) {
      const batch = actualImageIds.slice(
        imgDelOffset,
        imgDelOffset + MAX_BATCH_DELETE,
      );
      imgDelOffset += batch.length;

      const placeholders = batch.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM image_cache WHERE uploadthing_id IN (${placeholders})`,
      ).run(...batch);
    }

    let msgDelOffset = 0;
    while (msgDelOffset < toDelete.length) {
      const batch = toDelete.slice(
        msgDelOffset,
        msgDelOffset + MAX_BATCH_DELETE,
      );
      msgDelOffset += batch.length;

      const placeholders = batch.map(() => "?").join(", ");
      db.prepare(`DELETE FROM your_table WHERE id IN (${placeholders})`).run(
        ...batch,
      );
    }
  }
}
