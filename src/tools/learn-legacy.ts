import { oracleDocuments } from '../db/schema.ts';
import { getVectorStoreByModel } from '../vector/factory.ts';
import type { LearnStorage } from '../learn/storage.ts';
import type { ToolContext, ToolResponse, OracleLearnInput } from './types.ts';

function coerceConcepts(concepts: unknown): string[] {
  if (Array.isArray(concepts)) return concepts.map(String);
  if (typeof concepts === 'string') {
    return concepts.split(',').map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

function slugify(pattern: string, now: number): string {
  return pattern.slice(0, 50).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '') || `pattern-${now}`;
}

export async function handleLegacyLearn(
  ctx: ToolContext,
  input: OracleLearnInput,
  project: string | null,
  storage: LearnStorage,
): Promise<ToolResponse> {
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const slug = slugify(input.pattern, now);
  const filename = `${date}_${slug}.md`;
  const directory = storage.learningDir;
  const filePath = `${directory}/${filename}`;
  const sourceFile = `${storage.sourceFilePrefix}/${filename}`;
  if ((Bun.spawnSync(['mkdir', '-p', '--', directory])).exitCode !== 0) {
    throw new Error('Failed to create legacy learning directory');
  }
  if (await Bun.file(filePath).exists()) throw new Error(`File already exists: ${filename}`);
  const concepts = coerceConcepts(input.concepts);
  const title = input.pattern.split('\n', 1)[0].slice(0, 80);
  const content = [
    '---', `title: ${title}`, `tags: [${concepts.join(', ')}]`, `created: ${date}`,
    `source: ${input.source || 'Oracle Learn'}`, ...(project ? [`project: ${project}`] : []),
    '---', '', `# ${title}`, '', input.pattern, '', '---', '*Added via Oracle Learn*', '',
  ].join('\n');
  await Bun.write(filePath, content, { mode: 0o600, createPath: false });
  const id = `learning_${date}_${slug}`;
  ctx.db.insert(oracleDocuments).values({
    id, type: 'learning', sourceFile, concepts: JSON.stringify(concepts),
    createdAt: now, updatedAt: now, indexedAt: now, origin: null,
    project, createdBy: 'arra_learn',
  }).run();
  ctx.sqlite.prepare('DELETE FROM oracle_fts WHERE id = ?').run(id);
  ctx.sqlite.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)')
    .run(id, content, concepts.join(' '));
  let embedding: 'ok' | 'failed' = 'ok';
  try {
    const store = getVectorStoreByModel(process.env.ORACLE_EMBEDDING_MODEL || 'bge-m3');
    await store.addDocuments([{
      id, document: content,
      metadata: { type: 'learning', source_file: sourceFile, project: project || '', concepts: concepts.join(',') },
    }]);
  } catch {
    embedding = 'failed';
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true, file: sourceFile, id, embedding,
      ...(storage.warning ? { warning: storage.warning } : {}),
    }, null, 2) }],
  };
}
