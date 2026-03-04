#!/usr/bin/env bun
/**
 * Seed minimal test data for integration tests
 *
 * Uses createDatabase() to ensure schema (migrations + FTS5)
 * is initialized before seeding.
 */
import { createDatabase } from "../src/db/index.ts";

const { sqlite } = createDatabase();

console.log(`Seeding test data to: ${sqlite.filename}`);

const now = Date.now();

// Insert test documents into main table
const insertDoc = sqlite.prepare(`
  INSERT OR IGNORE INTO oracle_documents (id, type, source_file, concepts, created_at, updated_at, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Insert into FTS5 table for content search
const insertFts = sqlite.prepare(`
  INSERT OR IGNORE INTO oracle_fts (id, type, title, content, concepts)
  VALUES (?, ?, ?, ?, ?)
`);

const testDocs = [
  {
    id: 'test_principle_1',
    type: 'principle',
    title: 'Nothing is Deleted',
    content: 'All data is preserved. History is append-only. Timestamps are truth.',
    concepts: '["oracle", "philosophy", "data"]',
    source_file: 'test/principle.md'
  },
  {
    id: 'test_learning_1',
    type: 'learning',
    title: 'Test Learning',
    content: 'This is a test learning for integration tests.',
    concepts: '["test", "ci"]',
    source_file: 'test/learning.md'
  },
  {
    id: 'test_pattern_1',
    type: 'pattern',
    title: 'Test Pattern',
    content: 'Patterns guide behavior. This is a test pattern.',
    concepts: '["test", "pattern"]',
    source_file: 'test/pattern.md'
  }
];

for (const doc of testDocs) {
  insertDoc.run(doc.id, doc.type, doc.source_file, doc.concepts, now, now, now);
  insertFts.run(doc.id, doc.type, doc.title, doc.content, doc.concepts);
}

console.log(`✅ Seeded ${testDocs.length} test documents`);
sqlite.close();
