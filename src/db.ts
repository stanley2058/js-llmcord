import { Database } from "bun:sqlite";
import path from "node:path";

const db = new Database(path.join(import.meta.dirname, "../data/llmcord.db"));

// Initialize image cache table
db.run(`
  CREATE TABLE IF NOT EXISTS image_cache (
    uploadthing_id TEXT PRIMARY KEY,
    uploadthing_url TEXT NOT NULL,
    original_url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS model_messages (
    message_id TEXT PRIMARY KEY,
    model_message TEXT NOT NULL,
    image_ids TEXT,
    parent_message_id TEXT,
    created_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS message_reasoning (
    message_id TEXT PRIMARY KEY,
    reasoning_summary TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

export default db;
