import { SQL } from "bun";
import { getConfig } from "../config-parser";

let sql: SQL | null = null;
export async function pg() {
  if (sql) return sql;

  const config = await getConfig();
  if (!config.rag?.postgres_uri) throw new Error("postgres_uri not supplied");

  sql = new SQL(config.rag.postgres_uri);

  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  await sql`
    CREATE TABLE IF NOT EXISTS embeddings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id TEXT NOT NULL,
      summary TEXT,
      memo TEXT,
      type TEXT NOT NULL CHECK (type IN ('intent', 'fact', 'preference')),
      relevance REAL NOT NULL CHECK (relevance >= 0 AND relevance <= 1),
      embedding VECTOR(1536) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

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
