import type { ModelMessage, SystemModelMessage } from "ai";
import { pg } from "./db";
import type { RagEmbedding } from "./type";

type EmbeddingType = "intent" | "fact" | "preference";
const DEFAULT_CAPS: Record<EmbeddingType, number> = {
  intent: 8,
  preference: 8,
  fact: 16,
};

const DEFAULT_THRESHOLDS: Record<EmbeddingType, number> = {
  intent: 0.6,
  preference: 0.55,
  fact: 0.65,
};

// Combined score = 0.75 * relevance + 0.25 * time_score
const RELEVANCE_WEIGHT = 0.75;
const TIME_WEIGHT = 0.25;

export async function getRecommendedMemoryForUser(userId: string) {
  const sql = await pg();

  const results = await sql<RagEmbedding[]>`
    SELECT *
    FROM embeddings
    WHERE user_id = ${userId};
  `;

  if (!results?.length) return { intent: [], fact: [], preference: [] };

  const times = results
    .map((r) => new Date(r.created_at).getTime())
    .sort((a, b) => a - b);
  const timeBase = times.at(-1)! - times[0]!;

  const scored = results.map((r) => {
    if (r.relevance === 1) return { ...r, score: 1 };

    const timeScore = new Date(r.created_at).getTime() / timeBase;
    const score = RELEVANCE_WEIGHT * r.relevance + TIME_WEIGHT * timeScore;

    return { ...r, score };
  });
  const selected = scored.filter((r) => {
    if (r.relevance === 1) return true;
    return r.score >= DEFAULT_THRESHOLDS[r.type];
  });

  const intent = selected
    .filter((r) => r.type === "intent")
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_CAPS.intent);
  const preference = selected
    .filter((r) => r.type === "preference")
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_CAPS.preference);
  const fact = selected
    .filter((r) => r.type === "fact")
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_CAPS.fact);

  return { intent, fact, preference };
}

export function getUsersFromModelMessages(messages: ModelMessage[]) {
  const userIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "user") continue;

    if (typeof message.content === "string") {
      for (const line of message.content.split("\n")) {
        if (!line.startsWith("user_id:")) continue;
        userIds.add(line.replace("user_id:", "").trim());
      }
    } else {
      for (const part of message.content) {
        if (part.type !== "text") continue;

        for (const line of part.text.split("\n")) {
          if (!line.startsWith("user_id:")) continue;
          userIds.add(line.replace("user_id:", "").trim());
        }
      }
    }
  }

  return userIds;
}

export async function getRecommendedMemoryStringForUsers(userIds: string[]) {
  const messages = await Promise.all(userIds.map(getRecommendedMemoryForUser));

  const systemMessages: SystemModelMessage[] = [];

  for (let i = 0; i < userIds.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const totalMessages =
      msg.intent.length + msg.fact.length + msg.preference.length;
    if (totalMessages === 0) continue;

    let content = `<memory for-user="${userIds[i]}">\n`;
    if (msg.fact.length > 0) {
      content += "<facts>\n";
      content += `${msg.fact.map(mapEmbeddingsToMessages).join("\n")}\n`;
      content += "</facts>\n";
    }

    if (msg.intent.length > 0) {
      content += "<intents>\n";
      content += `${msg.intent.map(mapEmbeddingsToMessages).join("\n")}\n`;
      content += "</intents>\n";
    }

    if (msg.preference.length > 0) {
      content += "<preferences>\n";
      content += `${msg.preference.map(mapEmbeddingsToMessages).join("\n")}\n`;
      content += "</preferences>\n";
    }

    content += "</memory>\n";

    systemMessages.push({
      role: "system",
      content,
    });
  }

  return systemMessages;
}

function mapEmbeddingsToMessages(
  embeddingEntry: RagEmbedding & { score: number },
) {
  return `- ${JSON.stringify({
    id: embeddingEntry.id,
    relevance: embeddingEntry.relevance,
    summary: embeddingEntry.summary,
    has_memo: embeddingEntry.memo ? true : false,
    created_at: embeddingEntry.created_at,
  })}`;
}
