import { afterEach, describe, expect, it } from 'bun:test';
import Database from 'bun:sqlite';
import { makeDocumentLoader } from '../source-loader.ts';
import type { EnqueuedJob } from '../jobs.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function harness() {
  const made = Bun.spawnSync(['mktemp', '-d', '/tmp/source-loader.XXXXXX']);
  const root = made.stdout.toString().trim();
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE oracle_documents (
      id TEXT PRIMARY KEY, source_file TEXT, concepts TEXT, project TEXT,
      origin TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts);
  `);
  const source = 'ψ/memory/learnings/test.md';
  const content = 'exact authoritative bytes\n';
  Bun.spawnSync(['mkdir', '-p', '--', `${root}/ψ/memory/learnings`]);
  await Bun.write(`${root}/${source}`, content);
  db.prepare(`
    INSERT INTO oracle_documents
      (id, source_file, concepts, project, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('doc', source, '["one","two"]', 'github.com/example/repo', 'human', 10, 20);
  db.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)')
    .run('doc', content, 'one two');
  const job: EnqueuedJob = {
    id: 'job', docId: 'doc', modelKey: 'test', collection: 'vectors',
    contentHash: new Bun.CryptoHasher('sha256').update(content).digest('hex'),
    indexRevision: 'revision', status: 'claimed', attempts: 1,
  };
  cleanups.push(() => {
    db.close();
    Bun.spawnSync(['rm', '-r', '--', root], { stdout: 'ignore', stderr: 'ignore' });
  });
  return { db, root, content, job, load: makeDocumentLoader({ db, repoRoot: root, metadataSchemaVersion: 1 }) };
}

describe('authoritative worker source loader', () => {
  it('returns exact file text and deterministic metadata only when FTS matches', async () => {
    const h = await harness();
    const result = await h.load(h.job);
    expect(result).toEqual({
      kind: 'ready',
      text: h.content,
      metadata: {
        type: 'learning', source_file: 'ψ/memory/learnings/test.md',
        concepts: 'one,two', project: 'github.com/example/repo', origin: 'human',
        created_at: 10, updated_at: 20, content_hash: h.job.contentHash,
        model_key: 'test', index_revision: 'revision', metadata_schema_version: 1,
      },
    });
  });

  it('closes missing, changed, and stale-FTS sources distinctly', async () => {
    const missing = await harness();
    missing.db.exec('DELETE FROM oracle_documents');
    expect(await missing.load(missing.job)).toEqual({ kind: 'missing' });

    const changed = await harness();
    await Bun.write(`${changed.root}/ψ/memory/learnings/test.md`, 'changed');
    expect(await changed.load(changed.job)).toEqual({ kind: 'content_mismatch' });

    const stale = await harness();
    stale.db.exec(`UPDATE oracle_fts SET content = 'stale'`);
    expect(await stale.load(stale.job)).toEqual({ kind: 'fts_mismatch' });
  });

  it('rejects traversal source paths without accessing outside the root', async () => {
    const h = await harness();
    h.db.exec(`UPDATE oracle_documents SET source_file = '../outside'`);
    expect(await h.load(h.job)).toEqual({ kind: 'missing' });
  });

  it('resolves project-first canonical files from the configured vault root', async () => {
    const h = await harness();
    const vault = `${h.root}/vault`;
    const source = 'github.com/example/repo/ψ/memory/learnings/test.md';
    Bun.spawnSync(['mkdir', '-p', '--', `${vault}/github.com/example/repo/ψ/memory/learnings`]);
    await Bun.write(`${vault}/${source}`, h.content);
    h.db.prepare('UPDATE oracle_documents SET source_file = ?').run(source);
    const load = makeDocumentLoader({
      db: h.db, repoRoot: h.root, vaultRoot: vault, metadataSchemaVersion: 1,
    });
    expect((await load(h.job)).kind).toBe('ready');
  });

  it('rejects a source symlink that escapes its allowed physical root', async () => {
    const h = await harness();
    const outside = `${h.root}-outside`;
    Bun.spawnSync(['mkdir', '-p', '--', outside]);
    await Bun.write(`${outside}/escape.md`, h.content);
    Bun.spawnSync(['ln', '-s', '--', `${outside}/escape.md`, `${h.root}/ψ/memory/learnings/escape.md`]);
    h.db.exec(`UPDATE oracle_documents SET source_file = 'ψ/memory/learnings/escape.md'`);
    cleanups.push(() => Bun.spawnSync(['rm', '-r', '--', outside]));
    expect(await h.load(h.job)).toEqual({ kind: 'missing' });
  });

  it('loads A2 bytes from persisted storage_root after current vault changes', async () => {
    const h = await harness();
    const reserved = `${h.root}/reserved`;
    const source = 'github.com/example/repo/ψ/memory/learnings/test.md';
    Bun.spawnSync(['mkdir', '-p', '--', reserved]);
    await Bun.write(`${reserved}/test.md`, h.content);
    h.db.exec(`CREATE TABLE learn_reservations_v2 (
      doc_id TEXT, source_file TEXT, storage_root TEXT, content_hash TEXT, state TEXT
    )`);
    h.db.prepare(`INSERT INTO learn_reservations_v2 VALUES (?, ?, ?, ?, 'committed')`)
      .run('doc', source, reserved, h.job.contentHash);
    h.db.prepare('UPDATE oracle_documents SET source_file = ?').run(source);
    const load = makeDocumentLoader({
      db: h.db, repoRoot: h.root, vaultRoot: `${h.root}/wrong-vault`, metadataSchemaVersion: 1,
    });
    expect((await load(h.job)).kind).toBe('ready');
  });
});
