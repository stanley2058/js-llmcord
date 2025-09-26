import { SQL } from "bun";
import { getConfig } from "../config-parser";

let sql: SQL | null = null;
export async function pg() {
  if (sql) return sql;

  const config = await getConfig();
  if (!config.rag?.postgres_uri) throw new Error("postgres_uri not supplied");

  sql = new SQL(config.rag.postgres_uri);

  await sql.unsafe(`
    -- Enable required extensions (safe to run repeatedly)
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- embeddings table
    CREATE TABLE IF NOT EXISTS embeddings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id TEXT NOT NULL,
      summary TEXT,
      memo TEXT,
      type TEXT NOT NULL CHECK (type IN ('intent', 'fact', 'preference')),
      relevance REAL NOT NULL CHECK (relevance >= 0 AND relevance <= 1),
      embedding VECTOR(1536) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Useful indexes

    -- Filter by type quickly (optional but cheap)
    CREATE INDEX IF NOT EXISTS embeddings_type_idx
      ON embeddings (type);

    -- If you frequently query by recent items
    CREATE INDEX IF NOT EXISTS embeddings_created_at_idx
      ON embeddings (created_at);

    -- ANN search on embeddings using HNSW (pgvector >= 0.5)
    -- Adjust m / ef_construction based on data size and latency needs
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_idx
      ON embeddings
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 200);

    -- Optional: partial HNSW indexes per type if you often search within one type
    -- (keeps graphs smaller and queries faster)
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_intent_idx
      ON embeddings USING hnsw (embedding vector_cosine_ops)
      WHERE type = 'intent';
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_fact_idx
      ON embeddings USING hnsw (embedding vector_cosine_ops)
      WHERE type = 'fact';
    CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_preference_idx
      ON embeddings USING hnsw (embedding vector_cosine_ops)
      WHERE type = 'preference';

    CREATE INDEX IF NOT EXISTS embeddings_user_id_idx
      ON embeddings (user_id);

    CREATE INDEX IF NOT EXISTS embeddings_summary_trgm_idx
      ON embeddings
      USING gin (summary gin_trgm_ops);
  `);

  return sql;
}
