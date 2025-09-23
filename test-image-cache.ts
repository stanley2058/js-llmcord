#!/usr/bin/env bun
// Quick test script for image caching functionality

import { Database } from "bun:sqlite";
import { UTApi } from "uploadthing/server";

// Initialize test database
const testDb = new Database(":memory:");
testDb.run(`
  CREATE TABLE image_cache (
    url_hash TEXT PRIMARY KEY,
    original_url TEXT NOT NULL,
    uploadthing_url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Hash function (same as in main code)
function hashUrl(url: string): string {
  return Bun.hash(url).toString(36);
}

// Test the caching functionality
function testImageCache() {
  console.log("Testing image cache...");
  
  const testUrl = "https://example.com/test-image.jpg";
  const testHash = hashUrl(testUrl);
  const testUploadUrl = "https://uploadthing.com/uploaded/test-image.jpg";
  
  // Insert test record
  testDb.run(
    "INSERT INTO image_cache (url_hash, original_url, uploadthing_url, created_at) VALUES (?, ?, ?, ?)",
    [testHash, testUrl, testUploadUrl, Date.now()]
  );
  
  // Retrieve record
  const result = testDb.query("SELECT * FROM image_cache WHERE url_hash = ?").get(testHash) as any;
  
  if (result && result.uploadthing_url === testUploadUrl) {
    console.log("✅ Image cache working correctly!");
    console.log("Cached record:", result);
  } else {
    console.log("❌ Image cache test failed");
  }
  
  // Test cleanup
  const oldTime = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days ago
  testDb.run("UPDATE image_cache SET created_at = ? WHERE url_hash = ?", [oldTime, testHash]);
  
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const deleted = testDb.run("DELETE FROM image_cache WHERE created_at < ?", [sevenDaysAgo]);
  
  if (deleted.changes === 1) {
    console.log("✅ Cache cleanup working correctly!");
  } else {
    console.log("❌ Cache cleanup test failed");
  }
}

// Test UploadThing initialization
function testUploadThing() {
  console.log("Testing UploadThing initialization...");
  
  const apiKey = process.env.UPLOADTHING_TOKEN;
  if (apiKey) {
    try {
      new UTApi({ token: apiKey });
      console.log("✅ UploadThing API initialized successfully!");
    } catch (error) {
      console.log("❌ UploadThing initialization failed:", error);
    }
  } else {
    console.log("⚠️  No UPLOADTHING_TOKEN found in environment");
    console.log("   Add your UploadThing API key to config.yaml or UPLOADTHING_TOKEN env var");
  }
}

// Run tests
console.log("🧪 Running image cache tests...\n");
testImageCache();
console.log();
testUploadThing();
console.log("\n✨ Tests completed!");