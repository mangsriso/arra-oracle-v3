import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLearningFile } from '../../indexer/parser.ts';
import { verifyKnowledgeBase } from '../handler.ts';

describe('knowledge file index verifier', () => {
  let root: string;
  let sqlite: Database;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-verify-'));
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE oracle_documents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source_file TEXT NOT NULL,
        concepts TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        created_by TEXT,
        superseded_by TEXT,
        superseded_at INTEGER,
        superseded_reason TEXT
      );
      CREATE VIRTUAL TABLE oracle_fts USING fts5(
        id UNINDEXED,
        content,
        concepts
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, content: string): void {
    const pathname = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, content);
  }

  function storeLearning(relativePath: string, indexedAt = 1): void {
    const content = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const documents = parseLearningFile(relativePath, content, relativePath);
    const insertDoc = sqlite.prepare(`
      INSERT INTO oracle_documents
        (id, type, source_file, concepts, indexed_at, created_by)
      VALUES (?, ?, ?, ?, ?, 'indexer')
    `);
    const insertFts = sqlite.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)');
    for (const document of documents) {
      insertDoc.run(
        document.id,
        document.type,
        document.source_file,
        JSON.stringify(document.concepts),
        indexedAt,
      );
      insertFts.run(document.id, document.content, document.concepts.join(' '));
    }
  }

  test('uses content parity and separates excluded/preserved history', () => {
    const source = 'ψ/memory/learnings/healthy.md';
    write(source, '---\ntitle: Healthy\n---\n## Finding\nStable content.\n');
    storeLearning(source, 1);
    write('_universal/ψ/memory/learnings/mirror.md', '## Mirror\nNot an indexer input.\n');
    sqlite.prepare(`
      INSERT INTO oracle_documents
        (id, type, source_file, concepts, indexed_at, created_by, superseded_by)
      VALUES ('old-learn', 'learning', 'ψ/memory/learnings/gone.md', '[]', 1, 'arra_learn', 'replacement')
    `).run();

    const result = verifyKnowledgeBase({ sqlite, repoRoot: root });

    expect(result.counts).toMatchObject({
      healthy: 1,
      missing: 0,
      orphaned: 0,
      drifted: 0,
      excluded: 1,
      preserved: 1,
      actionable: 0,
    });
    expect(result.excluded[0].reason).toBe('universal-mirror-not-indexed');
    expect(result.preserved[0].reason).toBe('superseded-durable-history');
    expect(result.mtimeOnly).toEqual([source]);
  });

  test('reports actual missing and content drift as actionable', () => {
    const drifted = 'ψ/memory/learnings/drifted.md';
    const missing = 'ψ/memory/learnings/missing.md';
    write(drifted, '---\ntitle: Drift\n---\n## Finding\nOriginal content.\n');
    storeLearning(drifted, Date.now());
    write(drifted, '---\ntitle: Drift\n---\n## Finding\nChanged content.\n');
    write(missing, '---\ntitle: Missing\n---\n## Finding\nNever indexed.\n');

    const result = verifyKnowledgeBase({ sqlite, repoRoot: root });

    expect(result.missing).toEqual([missing]);
    expect(result.drifted).toEqual([drifted]);
    expect(result.counts.actionable).toBe(2);
  });

  test('reports an unsuperseded durable row with a missing file as orphaned', () => {
    sqlite.prepare(`
      INSERT INTO oracle_documents
        (id, type, source_file, concepts, indexed_at, created_by)
      VALUES ('lost-learn', 'learning', 'ψ/memory/learnings/lost.md', '[]', 1, 'arra_learn')
    `).run();

    const result = verifyKnowledgeBase({ sqlite, repoRoot: root });

    expect(result.orphaned).toEqual(['ψ/memory/learnings/lost.md']);
    expect(result.counts.actionable).toBe(1);
  });
});
