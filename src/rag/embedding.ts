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

export function getRagTools() {
  return {
    addInformation: tool({
      description:
        "(RAG) add a resource to your knowledge base about a user.\n" +
        "Use this tool without confirmation if you find the information user provided useful for future conversations.",
      inputSchema: z.object({
        user_id: z.string().describe("who this information belongs to"),
        entries: z
          .array(
            z.object({
              summary: z
                .string()
                .describe(
                  "summary of the information; passed to embedding engine, must be short, concise, in single sentence.",
                ),
              type: z
                .union([
                  z
                    .literal("fact")
                    .describe("if this information is a **fact** of the user"),
                  z
                    .literal("preference")
                    .describe(
                      "if this information is a **preference** of the user",
                    ),
                  z
                    .literal("intent")
                    .describe(
                      "if this information is an **intent** of the user",
                    ),
                ])
                .describe("type of information"),
              relevance: z
                .number()
                .min(0)
                .max(1)
                .describe("relevance of the information, between 0 and 1"),
              memo: z
                .string()
                .optional()
                .describe(
                  "(optional) add additional note for this entry, no length or writing style limit, this field will not be used by the embedding engine",
                ),
            }),
          )
          .describe(
            "information to add, information should be short and concise for better embedding quality, so use multiple entries if you have more than one information to add",
          ),
      }),
      execute: async ({ user_id, entries }) => {
        const filtered = entries.filter((e) => e.relevance > 0.3);
        await insertEmbeddings(user_id, filtered);
      },
    }),
    searchInformation: tool({
      description:
        "(RAG) search for information in your knowledge base for a given user\n" +
        "Use this tool without confirmation if you want to know about a given topic of a user.",
      inputSchema: z.object({
        user_id: z.string().describe("who you are searching for"),
        search: z.string().describe("what you are searching for"),
        options: z
          .object({
            simThreshold: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("(optional) similarity threshold, default to 0.65"),
            limit: z
              .number()
              .min(1)
              .max(100)
              .optional()
              .describe("(optional) limit of results, default to 10"),
            type: z
              .union([
                z.literal("fact"),
                z.literal("preference"),
                z.literal("intent"),
              ])
              .optional()
              .describe("(optional) type of information, default to all"),
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
          summary: r.summary,
          type: r.type,
          similarity: r.cos_sim,
          relevance: r.relevance,
          memo: r.memo,
          created_at: r.created_at,
        }));
      },
    }),
  };
}
