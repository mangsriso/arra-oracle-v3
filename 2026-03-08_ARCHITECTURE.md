# Oracle v2 Architecture: 0.2.3 → 0.4.0

> Explored: 2026-03-08 | Source: github.com/Soul-Brews-Studio/oracle-v2 | 78 commits since Feb 1

## Version Jump Summary

| Aspect | 0.2.3 (Local) | 0.4.0 (Repo) |
|--------|---------------|---------------|
| Package name | `@laris-co/oracle-v2` | `oracle-v2` |
| Data dir | `~/.oracle-v2/` | `~/.oracle/` |
| MCP SDK | ^0.5.0 | ^1.27.1 |
| TS files | ~33 | ~69 (+110%) |
| MCP tools | 19 | 27 (+42%) |
| HTTP routes | ~16 | 54+ |

## Directory Structure (0.4.0)

```
src/
├── index.ts                  # MCP server entry + CLI dispatcher
├── config.ts                 # Pure config (NEW — zero deps)
├── server.ts                 # Hono HTTP server (34 KB)
├── ensure-server.ts          # Auto-start with stale lock detection
├── indexer.ts                # Vault-aware multi-project indexer
├── types.ts                  # Shared types
├── chroma-mcp.ts             # ChromaDB via MCP protocol (not npm)
│
├── db/
│   ├── index.ts              # Drizzle initialization + createDatabase()
│   ├── schema.ts             # Drizzle ORM schema (replaces raw SQL)
│   └── migrations/           # 7 versioned migrations (0000-0006)
│
├── server/
│   ├── context.ts            # Project detection
│   ├── handlers.ts           # Request handlers (Drizzle ORM)
│   ├── logging.ts            # Activity logging
│   ├── dashboard.ts          # Dashboard aggregation
│   └── project-detect.ts     # ghq project detection
│
├── tools/                    # MCP tool handlers (extracted from monolith)
│   ├── index.ts              # Central exports
│   ├── types.ts              # Tool types
│   ├── search.ts, learn.ts, reflect.ts, list.ts, stats.ts
│   ├── concepts.ts, supersede.ts, verify.ts
│   ├── trace.ts, forum.ts, handoff.ts, inbox.ts, schedule.ts
│   └── __tests__/
│
├── process-manager/          # NEW — battle-tested infrastructure
│   ├── ProcessManager.ts     # PID files, zombie cleanup
│   ├── GracefulShutdown.ts   # Ordered shutdown sequence
│   ├── HealthMonitor.ts      # Port checks, HTTP probes
│   └── logger.ts             # Structured logging
│
├── vault/                    # NEW — GitHub-backed ψ/ sync
│   ├── handler.ts            # init, sync, pull, status
│   ├── cli.ts                # CLI commands for vault
│   └── migrate.ts            # Batch migration from ghq repos
│
├── trace/                    # NEW — discovery logging
│   ├── handler.ts            # CRUD + horizontal linking
│   └── types.ts
│
├── forum/                    # Refactored — threaded discussions
│   ├── handler.ts
│   └── types.ts
│
├── verify/                   # NEW — knowledge base health checks
│   └── handler.ts
│
├── cli/                      # NEW — full CLI (later extracted to oracle-cli)
│   ├── index.ts              # Commander.js entry
│   ├── http.ts               # Shared HTTP client
│   ├── format.ts             # Output formatters
│   └── commands/             # 11 subcommands
│       ├── health.ts, inbox.ts, learn.ts, list.ts
│       ├── schedule.ts, search.ts, server.ts, stats.ts
│       └── threads.ts, traces.ts, vault.ts
│
└── integration/              # Integration tests
    ├── database.test.ts
    ├── http.test.ts
    └── mcp.test.ts
```

## Key Architectural Changes

### 1. Modular Tool System
- **Before**: 19 tools defined inline in `src/index.ts`
- **After**: Each tool = `{name}ToolDef` + `handle{Name}` in `src/tools/`
- Central `src/tools/index.ts` re-exports all definitions

### 2. Drizzle ORM + Migrations
- **Before**: Raw SQL, no schema validation
- **After**: Drizzle ORM schema as source of truth
- FTS5 remains raw SQL (Drizzle doesn't support virtual tables)
- WAL mode + busy_timeout pragmas

### 3. Vault: Project-First Layout
```
vault-repo/
├── github.com/
│   ├── mangsriso/sda-script/ψ/          # Project-nested
│   └── Soul-Brews-Studio/oracle-v2/ψ/
└── ψ/memory/resonance/                   # Universal (shared)
```
- `PROJECT_CATEGORIES` (learnings, retros, handoffs) → nested under project
- `UNIVERSAL_CATEGORIES` (resonance, schedule, active) → shared root
- Auto-adds `project:` frontmatter to markdown files

### 4. Content-Hash Dedup in Indexer
```typescript
const contentHash = Bun.hash(content).toString(36);
if (this.seenContentHashes.has(contentHash)) continue;
```
- Prevents duplicate vectors when vault has copies across projects

### 5. Process Manager (from claude-mem)
- PID file management, zombie port cleanup
- Platform-aware timeouts (Windows 2x multiplier)
- Graceful shutdown: PID → HTTP → services → resources → children

### 6. Authentication
- Session-based with HMAC-SHA256 tokens (7-day expiry)
- Local network bypass (127.0.0.1, 192.168.x.x, 10.x.x.x)
- Settings-driven (`auth_enabled`, `auth_local_bypass`)

### 7. ChromaDB via MCP Protocol
- **Before**: Direct `chromadb` npm import
- **After**: `ChromaMcpClient` via stdio (MCP protocol)
- More portable, no direct dependency needed

## Database Schema (0.4.0)

### Active Tables
| Table | Purpose |
|-------|---------|
| `oracle_documents` | KB documents (+ project, createdBy, origin, supersede fields) |
| `oracle_fts` | FTS5 virtual table |
| `searchLog` | Search history (query, results, timing) |
| `learnLog` | Learning additions |
| `supersedeLog` | Document lineage audit trail |
| `settings` | Key-value config |
| `schedule` | Shared appointments (date, event, recurring) |
| `indexingStatus` | Current indexing state (+ repoRoot) |
| `traceLog` | Discovery traces (+ prevTraceId, nextTraceId, scope) |
| `forum_threads` / `forum_messages` | Threaded discussions |

### Removed Tables
- `consult_log` — replaced by search + reflect workflow
- `decisions` — replaced by traces + learnings

## Extraction Timeline

| System | Status | Location |
|--------|--------|----------|
| CLI | Extracted | `Soul-Brews-Studio/oracle-cli` |
| Frontend | Extracted | `Soul-Brews-Studio/oracle-studio` |
| Server (HTTP) | Resident | `src/server.ts` |
| MCP (stdio) | Resident | `src/index.ts` |
| Core DB | Resident | `src/db/` |
| Vector Search | External | ChromaDB via MCP |
