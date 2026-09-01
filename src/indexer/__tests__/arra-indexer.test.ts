import { describe, expect, it } from 'bun:test';
import {
  cmdCancel, cmdEnqueue, cmdRequeue, cmdStatus, dispatch, parseCli, type CliDeps,
} from '../arra-indexer.ts';
import { enqueueIndexJob } from '../jobs.ts';
import { claimNextJob } from '../jobs.ts';
import { beginExternalWrite } from '../job-transitions.ts';
import { queueDb, TEST_MODELS } from './v2-fixture.ts';

const HASHED_CONTENT = 'queue me';

function harness(): CliDeps & { outText: string[]; errText: string[] } {
  const db = queueDb();
  db.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)')
    .run('doc', HASHED_CONTENT, '');
  const outText: string[] = [];
  const errText: string[] = [];
  return {
    db, models: TEST_MODELS, outText, errText,
    out: (value) => outText.push(value), err: (value) => errText.push(value),
  };
}

describe('indexer CLI v2', () => {
  it('keeps status/cancel/requeue usable while async provider configuration is broken', () => {
    const made = Bun.spawnSync(['mktemp', '-d', `${process.env.TMPDIR}/arra-cli-recovery.XXXXXX`]);
    const root = made.stdout.toString().trim();
    const env = {
      ...process.env,
      ORACLE_DATA_DIR: root,
      ORACLE_DB_PATH: `${root}/oracle.db`,
      ORACLE_INDEXER_ENQUEUE: '1',
      ORACLE_EMBEDDING_MODEL_KEY: '',
      ORACLE_EMBEDDING_DEPLOYMENT_REVISION: '',
    } as Record<string, string>;
    try {
      const status = Bun.spawnSync([process.execPath, 'src/indexer/arra-indexer.ts', 'status'], {
        cwd: `${import.meta.dir}/../../..`, env, stdout: 'pipe', stderr: 'pipe',
      });
      if (status.exitCode !== 0) throw new Error(status.stderr.toString());
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toString()).toContain('queue empty');
      for (const args of [['cancel', 'missing'], ['requeue', 'missing', '--reason', 'repair']]) {
        const result = Bun.spawnSync([process.execPath, 'src/indexer/arra-indexer.ts', ...args], {
          cwd: `${import.meta.dir}/../../..`, env, stdout: 'pipe', stderr: 'pipe',
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).not.toContain('ORACLE_EMBEDDING_MODEL_KEY');
      }
    } finally {
      Bun.spawnSync(['rm', '-r', '--', root]);
    }
  });
  it('parses explicit all-models without consuming a positional', () => {
    expect(parseCli(['enqueue', 'doc', '--all-models'])).toEqual({
      subcommand: 'enqueue', positional: ['doc'], flags: { 'all-models': true },
    });
  });

  it('requires explicit model selection', () => {
    const deps = harness();
    expect(cmdEnqueue(deps, { subcommand: 'enqueue', positional: ['doc'], flags: {} })).toBe(1);
    expect(deps.errText.join('')).toContain('specify exactly one');
  });

  it('enqueues an explicit model from authoritative FTS content', () => {
    const deps = harness();
    expect(cmdEnqueue(deps, {
      subcommand: 'enqueue', positional: ['doc'], flags: { model: 'test' },
    })).toBe(0);
    const row = deps.db.query<{ model_key: string; content_hash: string }, []>(`
      SELECT model_key, content_hash FROM indexing_jobs_v2
    `).get()!;
    expect(row.model_key).toBe('test');
    expect(row.content_hash).toHaveLength(64);
  });

  it('explicit all-models fans out and status reads v2 only', () => {
    const deps = harness();
    expect(cmdEnqueue(deps, {
      subcommand: 'enqueue', positional: ['doc'], flags: { 'all-models': true },
    })).toBe(0);
    expect(cmdStatus(deps, { subcommand: 'status', positional: [], flags: {} })).toBe(0);
    expect(deps.outText.join('')).toContain('other');
    expect(deps.outText.join('')).toContain('test');
  });

  it('cancellation is a closed terminal transition', () => {
    const deps = harness();
    const job = enqueueIndexJob(deps.db, {
      docId: 'doc', contentHash: 'd'.repeat(64), modelKey: 'test', models: TEST_MODELS,
    })[0];
    expect(cmdCancel(deps, {
      subcommand: 'cancel', positional: [job.id], flags: {},
    })).toBe(0);
    expect(cmdCancel(deps, {
      subcommand: 'cancel', positional: [job.id], flags: {},
    })).toBe(1);
    expect((deps.db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
      .toBe('cancelled');
  });

  it('reports claimed cancellation as a request, not completed cancellation', () => {
    const deps = harness();
    const job = enqueueIndexJob(deps.db, {
      docId: 'doc', contentHash: 'e'.repeat(64), modelKey: 'test', models: TEST_MODELS,
    })[0];
    claimNextJob(deps.db, 'test', { workerId: 'worker', leaseMs: 10_000 });
    expect(cmdCancel(deps, { subcommand: 'cancel', positional: [job.id], flags: {} })).toBe(0);
    expect(deps.outText.join('')).toContain('Cancellation requested for claimed job');
    expect(deps.db.query('SELECT status, cancellation_requested_at FROM indexing_jobs_v2').get())
      .toMatchObject({ status: 'claimed', cancellation_requested_at: expect.any(Number) });
  });

  it('reports cancellation after the external-write commit point as too late', () => {
    const deps = harness();
    const job = enqueueIndexJob(deps.db, {
      docId: 'doc', contentHash: 'f'.repeat(64), modelKey: 'test', models: TEST_MODELS,
    })[0];
    const claimed = claimNextJob(deps.db, 'test', { workerId: 'worker', leaseMs: 10_000 })!;
    expect(beginExternalWrite(deps.db, job.id, claimed.claimToken!)).toBe(true);
    expect(cmdCancel(deps, { subcommand: 'cancel', positional: [job.id], flags: {} })).toBe(0);
    expect(deps.outText.join('')).toContain('too late');
  });

  it('requeues only terminal work with an explicit reason', () => {
    const deps = harness();
    const job = enqueueIndexJob(deps.db, {
      docId: 'doc', contentHash: 'd'.repeat(64), modelKey: 'test', models: TEST_MODELS,
    })[0];
    cmdCancel(deps, { subcommand: 'cancel', positional: [job.id], flags: {} });
    expect(cmdRequeue(deps, {
      subcommand: 'requeue', positional: [job.id], flags: { reason: 'fixed source' },
    })).toBe(0);
    expect(deps.db.query('SELECT status, attempts FROM indexing_jobs_v2').get())
      .toEqual({ status: 'pending', attempts: 0 });
    expect(deps.outText.join('')).toContain('fixed source');
  });

  it('dispatch keeps empty status and unknown commands safe', async () => {
    const deps = harness();
    expect(await dispatch(['status'], deps)).toBe(0);
    expect(await dispatch(['unknown'], deps)).toBe(0);
  });
});
