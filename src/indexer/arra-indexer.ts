import type Database from 'bun:sqlite';
import {
  enqueueIndexJob,
  jobsByStatus,
  type QueueModel,
} from './jobs.ts';
import { cancelJob, requeueTerminalJob } from './job-transitions.ts';

export interface ParsedArgs {
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseCli(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { subcommand: '', positional: [], flags: {} };
  if (argv.length === 0) return out;
  out.subcommand = argv[0];

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        out.flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i++;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

export interface CliDeps {
  db: Database;
  models: Record<string, QueueModel>;
  /** Print to stdout. Tests inject a recorder. */
  out: (s: string) => void;
  /** Print to stderr. */
  err: (s: string) => void;
}

const HELP_TEXT = `arra-indexer — vector job queue CLI

Usage:
  arra-indexer status [--model <key>] [--status <state>] [--limit <n>]
  arra-indexer enqueue <doc_id> (--model <key> | --all-models)
  arra-indexer cancel <job_id>
  arra-indexer requeue <job_id> --reason <reason>
  arra-indexer daemon                    # start the worker daemon (M3)
  arra-indexer help

`;

export function cmdHelp(deps: CliDeps): number {
  deps.out(HELP_TEXT);
  return 0;
}

export function cmdStatus(deps: CliDeps, args: ParsedArgs): number {
  const modelKey = typeof args.flags.model === 'string' ? args.flags.model : undefined;
  const statusFilter = typeof args.flags.status === 'string' ? args.flags.status : undefined;
  const limit = typeof args.flags.limit === 'string' ? parseInt(args.flags.limit, 10) : 50;

  const counts = jobsByStatus(deps.db, modelKey);
  if (counts.length === 0) {
    deps.out('queue empty\n');
  } else {
    deps.out('Counts (status × model):\n');
    for (const r of counts) {
      deps.out(`  ${r.status.padEnd(8)} ${r.model_key.padEnd(20)} ${r.count}\n`);
    }
  }

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (modelKey) { where.push('model_key = ?'); params.push(modelKey); }
  if (statusFilter) { where.push('status = ?'); params.push(statusFilter); }
  const sql = `SELECT id, doc_id, model_key, status, attempts, created_at, finished_at, error
               FROM indexing_jobs_v2
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = deps.db
    .query<{
      id: string; doc_id: string; model_key: string; status: string;
      attempts: number; created_at: number; finished_at: number | null; error: string | null;
    }, typeof params>(sql)
    .all(...params);

  if (rows.length === 0) {
    deps.out('\nNo jobs match the filter.\n');
    return 0;
  }
  deps.out(`\nRecent jobs (${rows.length}):\n`);
  for (const r of rows) {
    const errSuffix = r.error ? `  err: ${r.error.slice(0, 60)}` : '';
    deps.out(`  ${r.id}  ${r.status.padEnd(8)}  ${r.model_key.padEnd(20)}  ${r.doc_id}${errSuffix}\n`);
  }
  return 0;
}

export function cmdEnqueue(deps: CliDeps, args: ParsedArgs): number {
  const docId = args.positional[0];
  if (!docId) {
    deps.err('error: doc_id required\n');
    return 1;
  }
  const modelKey = typeof args.flags.model === 'string' ? args.flags.model : undefined;
  const allModels = args.flags['all-models'] === true;
  if ((!modelKey && !allModels) || (modelKey && allModels)) {
    deps.err('error: specify exactly one --model <key>, or --all-models\n');
    return 1;
  }
  const fts = deps.db.query<{ content: string }, [string]>(
    'SELECT content FROM oracle_fts WHERE id = ?',
  ).get(docId);
  if (!fts) {
    deps.err(`error: document '${docId}' has no FTS projection\n`);
    return 1;
  }
  const contentHash = new Bun.CryptoHasher('sha256').update(fts.content).digest('hex');
  let jobs;
  try {
    jobs = enqueueIndexJob(deps.db, {
      docId, contentHash, modelKey, allModels, models: deps.models,
    });
  } catch (error) {
    deps.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (jobs.length === 0) {
    if (modelKey) {
      deps.err(`error: unknown model_key '${modelKey}'\n`);
      return 1;
    }
    deps.err('error: no models registered\n');
    return 1;
  }
  deps.out(`Enqueued ${jobs.length} job(s):\n`);
  for (const j of jobs) {
    deps.out(`  ${j.id}  ${j.modelKey}\n`);
  }
  return 0;
}

export function cmdCancel(deps: CliDeps, args: ParsedArgs): number {
  const jobId = args.positional[0];
  if (!jobId) {
    deps.err('error: job_id required\n');
    return 1;
  }
  const before = deps.db.query<{ status: string; external_write_started_at: number | null }, [string]>(
    'SELECT status, external_write_started_at FROM indexing_jobs_v2 WHERE id = ?',
  ).get(jobId);
  if (!cancelJob(deps.db, jobId, 'cancelled by CLI')) {
    deps.err(`error: no eligible job with id '${jobId}'\n`);
    return 1;
  }
  deps.out(before?.status === 'claimed'
    ? before.external_write_started_at !== null
      ? `Cancellation requested too late for claimed job ${jobId}; external write already started\n`
      : `Cancellation requested for claimed job ${jobId}\n`
    : `Cancelled job ${jobId}\n`);
  return 0;
}

export function cmdRequeue(deps: CliDeps, args: ParsedArgs): number {
  const jobId = args.positional[0];
  const reason = typeof args.flags.reason === 'string' ? args.flags.reason.trim() : '';
  if (!jobId || !reason) {
    deps.err('error: job_id and --reason <reason> are required\n');
    return 1;
  }
  if (!requeueTerminalJob(deps.db, jobId, reason)) {
    deps.err(`error: no terminal job with id '${jobId}'\n`);
    return 1;
  }
  deps.out(`Requeued job ${jobId}: ${reason}\n`);
  return 0;
}

export type SubcommandFn = (deps: CliDeps, args: ParsedArgs) => number | Promise<number>;

export const COMMANDS: Record<string, SubcommandFn> = {
  status: cmdStatus,
  enqueue: cmdEnqueue,
  cancel: cmdCancel,
  requeue: cmdRequeue,
  help: cmdHelp,
  '': cmdHelp,                  // bare arra-indexer prints help
  '--help': cmdHelp,
  '-h': cmdHelp,
};

export async function dispatch(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseCli(argv);
  // daemon is special — delegates to the M3 entrypoint, dynamic-imported
  // so the CLI doesn't pull the daemon's heavy deps for status/enqueue/cancel.
  if (args.subcommand === 'daemon') {
    await import('./daemon.ts').catch(() => null);
    return 0;
  }
  const fn = COMMANDS[args.subcommand] ?? cmdHelp;
  return await fn(deps, args);
}

if (import.meta.main) {
  const { DB_PATH } = await import('../config.ts');
  const { createDatabase } = await import('../db/index.ts');
  const { sqlite: db } = createDatabase(DB_PATH);
  db.exec('PRAGMA synchronous = FULL');
  const command = parseCli(process.argv.slice(2)).subcommand;
  let models: Record<string, QueueModel> = {};
  if (command === 'enqueue') {
    const { getEmbeddingModels } = await import('../vector/factory.ts');
    const { resolveAsyncIndexerConfig } = await import('../vector/indexer-config.ts');
    const runtime = resolveAsyncIndexerConfig(getEmbeddingModels());
    if (runtime.modelKey) models[runtime.modelKey] = {
      collection: runtime.collection!, indexRevision: runtime.indexRevision!,
    };
  }
  const deps: CliDeps = {
    db,
    models,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
  const code = await dispatch(process.argv.slice(2), deps);
  db.close();
  process.exit(code);
}
