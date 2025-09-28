import { tool } from "ai";
import { getConfig } from "../config-parser";
import { pg } from "./db";
import z from "zod";
import type { RagEmbedding } from "./type";
import { getProvidersFromConfig } from "../model-routing";

export async function findRelevantContent(
  userId: string,
  search: string,
  {
    simThreshold = 0.65,
    limit = 10,
    type,
  }: {
    simThreshold?: number;
    limit?: number;
    type?: "intent" | "fact" | "preference";
  },
) {
  const config = await getConfig();
  if (!config.rag?.embedding_model) {
    throw new Error("[RAG] embedding_model not supplied");
  }

  const { openai } = await getProvidersFromConfig();
  if (!openai) throw new Error("[RAG] OpenAI provider not configured");

  if (config.debug_message) console.log({ simThreshold, limit, type });

  const { embeddings } = await openai
    .embedding(config.rag.embedding_model)
    .doEmbed({
      values: [search],
    });

  const embedding = embeddings[0]!;
  const vecLiteral = `[${embedding.join(",")}]`;

  const sql = await pg();
  let results: RagEmbedding[];
  if (type) {
    results = await sql`
      WITH ranked AS (
        SELECT
          e.*,
          e.embedding <=> ${vecLiteral}::vector AS dist
        FROM embeddings e
        WHERE e.user_id = ${userId}
          AND e.type = ${type}
          AND e.embedding <=> ${vecLiteral}::vector <= (1 - ${simThreshold})
      )
      SELECT
        r.*,
        1 - r.dist AS cos_sim
      FROM ranked r
      ORDER BY r.dist
      LIMIT ${limit};
    `;
  } else {
    results = await sql`
      WITH ranked AS (
        SELECT
          e.*,
          e.embedding <=> ${vecLiteral}::vector AS dist
        FROM embeddings e
        WHERE e.user_id = ${userId}
          AND e.embedding <=> ${vecLiteral}::vector <= (1 - ${simThreshold})
      )
      SELECT
        r.*,
        1 - r.dist AS cos_sim
      FROM ranked r
      ORDER BY r.dist
      LIMIT ${limit};
    `;
  }

  console.log(
    `[RAG] search returned ${results.length} results for user: ${userId}, with search: "${search}"`,
  );
  return results;
}

export async function insertEmbeddings(
  userId: string,
  entries: {
    type: "intent" | "fact" | "preference";
    summary: string;
    relevance: number;
    memo?: string;
  }[],
) {
  const config = await getConfig();
  if (!config.rag?.embedding_model) {
    throw new Error("[RAG] embedding_model not supplied");
  }
  const { openai } = await getProvidersFromConfig();
  if (!openai) throw new Error("[RAG] OpenAI provider not configured");

  console.log(`[RAG] adding ${entries.length} information for user: ${userId}`);
  if (config.debug_message) console.log(entries);

  const { embeddings } = await openai
    .embedding(config.rag.embedding_model)
    .doEmbed({
      values: entries.map((e) => e.summary),
    });

  const sql = await pg();
  await sql.begin(async (tx) => {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const embedding = embeddings[i]!;
      const vecLiteral = `[${embedding.join(",")}]`;
      await tx`
        INSERT INTO embeddings (
          user_id,
          summary,
          memo,
          type,
          relevance,
          embedding
        ) VALUES (
          ${userId},
          ${e.summary},
          ${e.memo || ""},
          ${e.type},
          ${e.relevance},
          ${vecLiteral}::vector
        )
      `;
    }
  });
}

export async function removeEmbeddings(userId: string, embeddingIds: string[]) {
  const sql = await pg();
  await sql`DELETE FROM embeddings WHERE id in ${sql(embeddingIds)} and user_id = ${userId}`;
}

export function getRagTools() {
  return {
    addInformation: tool({
      name: "remember_user_context",
      description:
        "Write-to-memory. Store concise, durable facts, preferences, or intents for a user (or for 'self') so future answers are more personalized.\n" +
        "When to use:\n" +
        "- The user states a stable fact (job, timezone, tools, constraints).\n" +
        "- The user expresses a preference (tone, format, stack choices, do/don’t).\n" +
        "- The user declares an ongoing goal or intent.\n" +
        "Rules:\n" +
        "- Use immediately without confirmation if the info helps future conversations.\n" +
        "- Summaries must be a single, short sentence (embedding-ready).\n" +
        "- Use multiple entries for multiple distinct items.\n" +
        "Also supports 'self' to store assistant operating constraints or learnings.",
      inputSchema: z.object({
        user_id: z
          .string()
          .describe(
            "Owner of this information, or 'self' to store assistant knowledge about itself.",
          ),
        entries: z
          .array(
            z.object({
              summary: z
                .string()
                .describe(
                  "One-sentence summary (short, atomic, embedding-ready).",
                ),
              type: z
                .union([
                  z.literal("fact").describe("Stable, objective user detail."),
                  z
                    .literal("preference")
                    .describe("User likes/dislikes, tone, format."),
                  z
                    .literal("intent")
                    .describe("Declared goals or ongoing plans."),
                ])
                .describe("Information category."),
              relevance: z
                .number()
                .min(0)
                .max(1)
                .describe("0–1 importance for future responses."),
              memo: z
                .string()
                .optional()
                .describe(
                  "(Optional) Free-form notes; not embedded. Use for nuance, citations, or any kind of context.",
                ),
            }),
          )
          .describe(
            "Use multiple entries for separate items. Keep each summary short and specific.",
          ),
      }),
      execute: async ({ user_id, entries }) => {
        const filtered = entries.filter((e) => e.relevance > 0.3);
        await insertEmbeddings(user_id, filtered);
      },
    }),
    searchInformation: tool({
      name: "recall_user_context",
      description:
        "Read-from-memory. Retrieve previously stored facts, preferences, or intents for a user (or 'self') to personalize the current answer.\n" +
        "When to use:\n" +
        "- Before giving advice that depends on the user’s stack, tone, or constraints.\n" +
        "- When the user references 'what I said earlier' or 'my usual preferences'.\n" +
        "- To resolve ambiguity about prior goals, choices, or profile details.\n" +
        "Rules:\n" +
        "- Use proactively without confirmation when context could change the answer.\n" +
        "- Provide a focused search phrase (topic or question).",
      inputSchema: z.object({
        user_id: z
          .string()
          .describe("Whose context to load, or 'self' for assistant memory."),
        search: z
          .string()
          .describe(
            "Topic to recall (e.g., 'frontend stack', 'tone', 'deadlines').",
          ),
        options: z
          .object({
            simThreshold: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("(Optional) Similarity threshold. Default 0.65."),
            limit: z
              .number()
              .min(1)
              .max(100)
              .optional()
              .describe("(Optional) Max results. Default 10."),
            type: z
              .union([
                z.literal("fact"),
                z.literal("preference"),
                z.literal("intent"),
              ])
              .optional()
              .describe("(Optional) Filter by category."),
          })
          .optional(),
      }),
      execute: async ({ user_id, search, options }) => {
        const { simThreshold = 0.65, limit = 10, type } = options ?? {};
        const results = await findRelevantContent(user_id, search, {
          simThreshold,
          limit,
          type,
        });
        return results.map((r) => ({
          id: r.id,
          summary: r.summary,
          type: r.type,
          similarity: r.cos_sim,
          relevance: r.relevance,
          memo: r.memo,
          created_at: r.created_at,
        }));
      },
    }),
    removeInformation: tool({
      name: "forget_user_context",
      description:
        "Forget-from-memory. Remove stale, incorrect, or user-retracted facts, preferences, or intents for a user (or 'self') to keep personalization accurate.\n" +
        "When to use:\n" +
        "- The user updates or contradicts a previously stored detail.\n" +
        "- A preference or goal is explicitly withdrawn or has expired.\n" +
        "- You detect duplicates or low-quality entries that could mislead future answers.\n" +
        "Rules:\n" +
        "- Use immediately without confirmation when the prior info would cause wrong advice.\n" +
        "- Target specific entries by `id` to avoid unintended loss.\n" +
        "Tips:\n" +
        "- Prefer replacing: forget the old entry, then call remember_user_context with the updated one.\n" +
        "- If unsure which to delete, first call recall_user_context to review candidates.",
      inputSchema: z.object({
        user_id: z
          .string()
          .describe("Whose context to modify, or 'self' for assistant memory."),
        memory_ids: z
          .array(
            z
              .string()
              .describe(
                "IDs of entries to remove (from prior search results).",
              ),
          )
          .min(1)
          .max(10)
          .describe(
            "IDs of entries to remove from memory. (1 to 10 entries at a time)",
          ),
      }),
      execute: async ({ user_id, memory_ids }) => {
        await removeEmbeddings(user_id, memory_ids);
      },
    }),
  };
}
