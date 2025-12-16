import db from "./db";
import type { DbMessageReasoning, DbModelMessage } from "./type";
import JSON from "superjson";
import { getConfig } from "./config-parser";
import type { ModelMessage } from "ai";
import { Logger } from "./logger";

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

  getReasoning(messageId: string) {
    const reasoning = db
      .query(`SELECT * FROM message_reasoning WHERE message_id = ?`)
      .get(messageId) as DbMessageReasoning | null;
    return reasoning;
  }

  async create({
    messageId,
    parentMessageId,
    messages,
    imageIds,
    reasoningSummary,
  }: {
    messageId: string | string[];
    parentMessageId?: string;
    messages: ModelMessage[];
    imageIds?: string[];
    reasoningSummary?: string;
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

    if (reasoningSummary) {
      db.run(
        "INSERT INTO message_reasoning (message_id, reasoning_summary, created_at) VALUES (?, ?, ?)",
        [messageIds.at(-1)!, reasoningSummary, Date.now()],
      );
    }
  }

  async removeMany(messageIds: string[]) {
    const uniqueMessageIds = [...new Set(messageIds)].filter(Boolean);
    if (uniqueMessageIds.length === 0) return;

    const MAX_BATCH_DELETE = 900;

    const msgRows: Array<{ message_id: string; image_ids: string | null }> = [];
    let offset = 0;
    while (offset < uniqueMessageIds.length) {
      const batch = uniqueMessageIds.slice(offset, offset + MAX_BATCH_DELETE);
      offset += batch.length;

      const placeholders = batch.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT message_id, image_ids FROM model_messages WHERE message_id IN (${placeholders})`,
        )
        .all(...batch) as Array<{ message_id: string; image_ids: string | null }>;
      msgRows.push(...rows);
    }

    if (msgRows.length === 0) return;

    const actualImageIds = [
      ...new Set(
        msgRows
          .map((r) => r.image_ids)
          .filter(Boolean)
          .flatMap((ids) => {
            try {
              return JSON.parse(ids!) as string[];
            } catch {
              return [];
            }
          }),
      ),
    ];

    const config = await getConfig();
    const logger = new Logger({ module: "mmo", logLevel: config.log_level });

    if (config.utApi && actualImageIds.length > 0) {
      try {
        await config.utApi.deleteFiles(actualImageIds);
      } catch (e) {
        logger.logError("Error deleting from UploadThing:", e);
      }
    }

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
    while (msgDelOffset < uniqueMessageIds.length) {
      const batch = uniqueMessageIds.slice(
        msgDelOffset,
        msgDelOffset + MAX_BATCH_DELETE,
      );
      msgDelOffset += batch.length;

      const placeholders = batch.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM model_messages WHERE message_id IN (${placeholders})`,
      ).run(...batch);
      db.prepare(
        `DELETE FROM message_reasoning WHERE message_id IN (${placeholders})`,
      ).run(...batch);
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
    const logger = new Logger({ module: "mmo", logLevel: config.log_level });
    if (config.utApi) {
      try {
        await config.utApi.deleteFiles(actualImageIds);
      } catch (e) {
        logger.logError("Error deleting from UploadThing:", e);
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
      db.prepare(
        `DELETE FROM model_messages WHERE message_id IN (${placeholders})`,
      ).run(...batch);
      db.prepare(
        `DELETE FROM message_reasoning WHERE message_id IN (${placeholders})`,
      ).run(...batch);
    }
  }

  async trim() {
    const config = await getConfig();
    const logger = new Logger({ module: "mmo", logLevel: config.log_level });
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const images = db
      .query("SELECT uploadthing_id FROM image_cache WHERE created_at < ?")
      .all(oneWeekAgo) as { uploadthing_id: string }[];

    if (config.utApi) {
      try {
        await config.utApi.deleteFiles(images.map((i) => i.uploadthing_id));
      } catch (e) {
        logger.logError("Error deleting from UploadThing:", e);
        return;
      }
    }

    db.run("DELETE FROM image_cache WHERE created_at < ?", [oneWeekAgo]);
    db.run("DELETE FROM model_messages WHERE created_at < ?", [oneWeekAgo]);
    db.run("DELETE FROM message_reasoning WHERE created_at < ?", [oneWeekAgo]);
  }
}
