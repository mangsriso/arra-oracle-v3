#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { verifyKnowledgeBase } from './handler.ts';

interface Args {
  repoRoot: string;
  dbPath: string;
  type?: string;
  json: boolean;
}

function usage(): never {
  console.error(
    'Usage: bun src/verify/cli.ts --repo-root <vault-root> --db <oracle.db> [--type <type>] [--json]\n'
    + 'Both paths are mandatory. The database is opened readonly; vectors are not inspected.',
  );
  process.exit(64);
}

function parseArgs(argv: string[]): Args {
  let repoRoot = '';
  let dbPath = '';
  let type: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--repo-root') repoRoot = argv[++index] || '';
    else if (arg === '--db') dbPath = argv[++index] || '';
    else if (arg === '--type') type = argv[++index] || '';
    else if (arg === '--json') json = true;
    else usage();
  }
  if (!repoRoot || !dbPath) usage();
  return {
    repoRoot: path.resolve(repoRoot),
    dbPath: path.resolve(dbPath),
    ...(type ? { type } : {}),
    json,
  };
}

const args = parseArgs(process.argv.slice(2));
if (!fs.statSync(args.repoRoot).isDirectory()) {
  throw new Error(`repo root is not a directory: ${args.repoRoot}`);
}
if (!fs.statSync(args.dbPath).isFile()) {
  throw new Error(`database is not a file: ${args.dbPath}`);
}

const sqlite = new Database(args.dbPath, { readonly: true, strict: true });
try {
  const result = verifyKnowledgeBase({
    sqlite,
    repoRoot: args.repoRoot,
    type: args.type,
    check: true,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result.counts));
    console.log(result.recommendation);
  }
  if (result.counts.actionable > 0) process.exitCode = 2;
} finally {
  sqlite.close();
}
