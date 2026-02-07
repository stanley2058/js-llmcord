import { SQL } from "bun";
import { getConfig } from "../config-parser";
import { Logger } from "../logger";
import { getRagEmbeddingConfig } from "./config";

let sql: SQL | null = null;
export async function pg() {
  if (sql) return sql;

  const config = await getConfig();
  const logger = new Logger({ module: "rag", logLevel: config.log_level });
  if (!config.rag?.postgres_uri) throw new Error("postgres_uri not supplied");
  if (!config.rag?.enable) throw new Error("[RAG] rag.enable not set");

  const { dimensions, providerModel } = getRagEmbeddingConfig(config);

  sql = new SQL(config.rag.postgres_uri);

  try {
    await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

    await sql`
      CREATE TABLE IF NOT EXISTS rag_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        embedding_model TEXT NOT NULL,
        embedding_dimensions INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // NOTE: vector dimensions cannot be parameterized; use unsafe to inline.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id TEXT NOT NULL,
        summary TEXT,
        memo TEXT,
        type TEXT NOT NULL CHECK (type IN ('intent', 'fact', 'preference')),
        relevance REAL NOT NULL CHECK (relevance >= 0 AND relevance <= 1),
        embedding VECTOR(${dimensions}) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await sql`
      INSERT INTO rag_meta (id, embedding_model, embedding_dimensions)
      VALUES (1, ${providerModel}, ${dimensions})
      ON CONFLICT (id) DO NOTHING
    `;

    const metaRows = await sql`
      SELECT embedding_model, embedding_dimensions
      FROM rag_meta
      WHERE id = 1
      LIMIT 1
    `;
    const meta = metaRows[0] as
      | { embedding_model: string; embedding_dimensions: number }
      | undefined;
    if (!meta) {
      throw new Error("[RAG] rag_meta not initialized");
    }

    const typeRows = await sql`
      SELECT format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND c.relname = 'embeddings'
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped
      LIMIT 1
    `;
    const colType = (typeRows[0] as { type: string } | undefined)?.type;
    if (!colType) {
      throw new Error("[RAG] failed to read embeddings.embedding column type");
    }

    const match = /^vector\((\d+)\)$/.exec(colType);
    if (!match) {
      throw new Error(
        `[RAG] embeddings.embedding column must be vector(n). Found: ${colType}`,
      );
    }
    const dbDimensions = Number(match[1]);
    if (!Number.isFinite(dbDimensions) || dbDimensions <= 0) {
      throw new Error(
        `[RAG] invalid vector dimensions in schema. Found: ${colType}`,
      );
    }

    if (dbDimensions !== dimensions) {
      throw new Error(
        `[RAG] embedding_dimensions mismatch. Config expects ${dimensions} but DB schema is ${dbDimensions}. ` +
          "Delete the RAG database/table and start over.",
      );
    }

    if (meta.embedding_dimensions !== dimensions) {
      throw new Error(
        `[RAG] rag_meta.embedding_dimensions mismatch. Expected ${dimensions}, got ${meta.embedding_dimensions}. ` +
          "Delete the RAG database/table and start over.",
      );
    }

    if (meta.embedding_model !== providerModel) {
      logger.logWarn(
        `[RAG] embedding_model changed from ${meta.embedding_model} to ${providerModel}. ` +
          "This is allowed if dimensions match, but existing memories will not be re-embedded.",
      );
    }
  } catch (e) {
    sql = null;
    throw e;
  }

  await sql`CREATE INDEX IF NOT EXISTS embeddings_type_idx ON embeddings (type)`;

  await sql`
    CREATE INDEX IF NOT EXISTS embeddings_created_at_idx
    ON embeddings (created_at)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_idx
    ON embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_intent_idx
    ON embeddings USING hnsw (embedding vector_cosine_ops)
    WHERE type = 'intent'
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_fact_idx
    ON embeddings USING hnsw (embedding vector_cosine_ops)
    WHERE type = 'fact'
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_preference_idx
    ON embeddings USING hnsw (embedding vector_cosine_ops)
    WHERE type = 'preference'
  `;

  await sql`CREATE INDEX IF NOT EXISTS embeddings_user_id_idx ON embeddings (user_id)`;

  await sql`
    CREATE INDEX IF NOT EXISTS embeddings_summary_trgm_idx
    ON embeddings USING gin (summary gin_trgm_ops)
  `;

  return sql;
}
