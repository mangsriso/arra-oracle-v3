# Oracle v2 Migration Checklist: 0.2.3 → 0.4.0

> Created: 2026-03-08 | For: Wednesday Oracle (sda-script)

## Pre-Migration

- [ ] Backup `~/.oracle-v2/` directory
- [ ] Backup `oracle.db`: `sqlite3 ~/.oracle-v2/oracle.db ".backup ~/.oracle-v2/oracle.db.backup"`
- [ ] Export decisions (if any): `SELECT * FROM decisions;`
- [ ] Export consult logs (if needed): `SELECT * FROM consult_log;`

## Phase 1: Data Directory

- [ ] Create new dir: `mkdir -p ~/.oracle`
- [ ] Copy DB: `cp ~/.oracle-v2/oracle.db ~/.oracle/oracle.db`
- [ ] Verify vault symlink: `ls -la ~/.oracle/ψ` (should point to vault)

## Phase 2: Install New Version

- [ ] Install from repo: `cd /home/aitma/ghq/github.com/Soul-Brews-Studio/oracle-v2 && bun install`
- [ ] Verify version: `grep version package.json` → should show 0.4.0-nightly
- [ ] Check MCP SDK: `bun pm ls | grep modelcontextprotocol` → should be ^1.27.1

## Phase 3: Database Migrations

- [ ] Run Drizzle migrations (creates schedule table, adds columns, drops decisions/consultLog)
- [ ] Normalize project casing: `UPDATE oracle_documents SET project = LOWER(project) WHERE project IS NOT NULL;`
- [ ] Verify schema: `sqlite3 ~/.oracle/oracle.db ".tables"` → should NOT have decisions/consult_log

## Phase 4: Re-index

- [ ] Run indexer: `bun src/indexer.ts` (from repo root)
- [ ] Verify content dedup: check log for "skipped X duplicate files"
- [ ] Verify vault scanning: should discover all project-first dirs

## Phase 5: Start Server

- [ ] Start: `bun src/server.ts`
- [ ] Health check: `curl http://localhost:47778/api/health`
- [ ] Search test: `curl "http://localhost:47778/api/search?q=migration"`
- [ ] Verify 27 MCP tools available

## Phase 6: Update Local Config

- [ ] Update MCP server path in Claude Code config (if using from source)
- [ ] Remove any `oracle_consult` references from skills/scripts
- [ ] Remove any `oracle_decisions_*` references from skills/scripts
- [ ] Test `/recap`, `/forward`, `/standup` still work

## Phase 7: Verify New Features

- [ ] `oracle_handoff` works
- [ ] `oracle_inbox` lists handoffs
- [ ] `oracle_verify` runs health check
- [ ] `oracle_schedule_add` creates event
- [ ] `oracle_search` with `project` param scopes correctly

## Breaking Changes Summary

| Removed | Replacement |
|---------|-------------|
| `oracle_consult()` | `oracle_search()` + `oracle_reflect()` |
| `oracle_decisions_create()` | `oracle_trace()` + `oracle_learn()` |
| `oracle_decisions_get()` | `oracle_trace_get()` |
| `oracle_decisions_list()` | `oracle_trace_list()` |
| `oracle_decisions_update()` | `oracle_learn()` with supersede |
| `~/.oracle-v2/` | `~/.oracle/` |
| `@laris-co/oracle-v2` | `oracle-v2` |
| `chromadb` npm | ChromaMcpClient (MCP protocol) |
