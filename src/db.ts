import { Database } from "bun:sqlite";
import path from "node:path";

const db = new Database(path.join(import.meta.dirname, "../data/llmcord.db"));

// Initialize image cache table
db.run(`
  CREATE TABLE IF NOT EXISTS image_cache (
    url_hash TEXT PRIMARY KEY,
    original_url TEXT NOT NULL,
    uploadthing_url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

export default db;
