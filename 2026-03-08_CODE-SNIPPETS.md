# Oracle v2 Code Snippets: Key Patterns (0.4.0)

> Explored: 2026-03-08 | Focus: New features vs our 0.2.3

## 1. New MCP Tools (8 new tools)

### Trace Chain Management
```typescript
// oracle_trace_link — connect related traces
oracle_trace_link({ prevId: "trace-123", nextId: "trace-456" })
// Creates bidirectional navigation: prev ↔ next

// oracle_trace_chain — navigate full chain
oracle_trace_chain({ traceId: "trace-123" })
// Returns all linked traces + position in chain
```

### Session Handoff & Inbox
```typescript
// oracle_handoff — write context for next session (vault-aware)
oracle_handoff({ content: "## Session Context\n...", slug: "push-ports" })
// Writes to: vault/{project}/ψ/inbox/handoff/YYYY-MM-DD-{slug}.md

// oracle_inbox — browse pending handoffs
oracle_inbox({ type: "handoff", limit: 10 })
```

### Knowledge Base Health
```typescript
// oracle_verify — compare ψ/ files vs DB index
oracle_verify({ check: "full" })
// Returns: missing (on disk, not in DB), orphaned (in DB, not on disk), drifted (content mismatch)
```

### Shared Schedule
```typescript
// oracle_schedule_add — supports Thai months!
oracle_schedule_add({ date: "28 ก.พ.", event: "Sprint review", time: "14:00", recurring: "weekly" })

// oracle_schedule_list — defaults to today + 14 days
oracle_schedule_list({ range: { from: "2026-03-01", to: "2026-03-31" } })
```

## 2. Updated Tool Parameters

```typescript
// oracle_search — NEW: project + cwd params
oracle_search({ query: "migration", project: "sda-script" })
// Returns: project-scoped + universal results

// oracle_learn — NEW: project param
oracle_learn({ pattern: "...", concepts: ["..."], project: "sda-script" })

// oracle_trace — NEW: scope param
oracle_trace({ title: "...", scope: "project" })  // project | cross-project | human
```

## 3. Content-Hash Dedup (Indexer)

```typescript
// src/indexer.ts — prevents duplicate vectors across vault projects
private seenContentHashes: Set<string> = new Set();

const contentHash = Bun.hash(content).toString(36);  // Bun's fast hash
if (this.seenContentHashes.has(contentHash)) {
  skippedDupes++;
  continue;  // Skip exact duplicate
}
this.seenContentHashes.add(contentHash);
```

## 4. Vault Path Mapping

```typescript
// src/vault/handler.ts — project-first layout
const PROJECT_CATEGORIES = [
  'ψ/memory/learnings/',
  'ψ/memory/retrospectives/',
  'ψ/inbox/handoff/',
];

const UNIVERSAL_CATEGORIES = [
  'ψ/memory/resonance/',
  'ψ/inbox/schedule.md',
  'ψ/inbox/focus-agent-main.md',
  'ψ/active/',
];

// mapToVaultPath: ψ/memory/learnings/foo.md + project "sda-script"
//   → sda-script/ψ/memory/learnings/foo.md (project-nested)
// mapFromVaultPath: reverses for pull operations
```

## 5. Smart Deletion (Indexer)

```typescript
// Only deletes indexer-generated docs with missing source files
// Preserves oracle_learn docs and manual docs
const allIndexerDocs = db.select({ id, sourceFile })
  .where(or(eq(createdBy, 'indexer'), isNull(createdBy)))
  .all();

const idsToDelete = allIndexerDocs
  .filter(d => !fs.existsSync(path.join(repoRoot, d.sourceFile)))
  .map(d => d.id);
```

## 6. Project Casing Normalization

```typescript
// All project fields normalized to lowercase at write gates
// Auto-migration on DB startup (one-time)
UPDATE oracle_documents SET project = LOWER(project) WHERE project IS NOT NULL;
```

## 7. Config Module (Pure, Zero Deps)

```typescript
// src/config.ts — NEW in 0.4.0
export const PORT = parseInt(process.env.ORACLE_PORT || '47778', 10);
export const ORACLE_DATA_DIR = process.env.ORACLE_DATA_DIR || path.join(HOME_DIR, '.oracle');
export const DB_PATH = process.env.ORACLE_DB_PATH || path.join(ORACLE_DATA_DIR, 'oracle.db');
export const REPO_ROOT = process.env.ORACLE_REPO_ROOT || /* auto-detect via ψ/ */;
```

## 8. Process Manager Patterns

```typescript
// GracefulShutdown — ordered sequence
async function performGracefulShutdown() {
  // 1. Remove PID file (prevent stale locks)
  // 2. Close HTTP server
  // 3. Shutdown services (ChromaDB, etc.)
  // 4. Release resources (DB connections)
  // 5. Kill child processes
  // Windows: 500ms delays for socket cleanup
}

// HealthMonitor — port checks
async function isPortInUse(port: number): Promise<boolean>
async function waitForHealth(url: string, timeout: number): Promise<boolean>
async function httpShutdown(port: number): Promise<void>  // POST /shutdown
```

## 9. Drizzle Schema (Key Tables)

```typescript
// src/db/schema.ts
export const oracleDocuments = sqliteTable('oracle_documents', {
  id: text('id').primaryKey(),
  type: text('type'),
  content: text('content'),
  sourceFile: text('source_file'),
  concepts: text('concepts'),  // JSON array
  project: text('project'),           // NEW
  createdBy: text('created_by'),      // NEW: 'indexer' | 'oracle_learn' | 'manual'
  origin: text('origin'),             // NEW: 'mother' | 'arthur' | 'human'
  supersededBy: text('superseded_by'),     // NEW
  supersededAt: integer('superseded_at'),   // NEW
  supersededReason: text('superseded_reason'), // NEW
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
  indexedAt: integer('indexed_at'),
});

export const schedule = sqliteTable('schedule', {  // NEW TABLE
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),      // YYYY-MM-DD canonical
  dateRaw: text('date_raw'),         // Original input ("5 Mar", "28 ก.พ.")
  time: text('time'),
  event: text('event').notNull(),
  notes: text('notes'),
  recurring: text('recurring'),       // null | "daily" | "weekly" | "monthly"
  status: text('status').default('pending'),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});
```

## 10. FTS5 Query Sanitization

```typescript
// Characters stripped from search queries (FTS5 special chars)
// OLD: ?*+-()^~"':
// NEW: ?*+-()^~"':,  (comma added — FTS5 treats it as AND)
const sanitized = query.replace(/[?*+\-()^~"':,]/g, ' ').trim();
```
