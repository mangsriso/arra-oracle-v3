# Oracle v2 Quick Reference: Migration from 0.2.3 → 0.4.0

> Explored: 2026-03-08 | For: Wednesday Oracle (sda-script)

## What's New (Summary)

Oracle v2 went from proof-of-concept (0.2.3) to production-ready (0.4.0):
- **8 new MCP tools** (trace chain, handoff, inbox, verify, schedule)
- **Vault system** for GitHub-backed ψ/ sync
- **Process manager** for reliable server lifecycle
- **Drizzle ORM** replacing raw SQL
- **CLI with 11 subcommands** (later extracted to oracle-cli)
- **Authentication** with local network bypass
- **Content-hash dedup** in indexer

## Breaking Changes (3 items)

| Feature | Status | Replacement |
|---------|--------|-------------|
| `oracle_consult` | REMOVED | Use `oracle_search` + `oracle_reflect` |
| `oracle_decisions_*` (4 tools) | REMOVED | Use `oracle_trace` + `oracle_learn` |
| `consultLog` table | REMOVED | N/A (logs only) |

## Migration Checklist

```bash
# 1. Backup
cp -r ~/.oracle-v2 ~/.oracle-v2.backup

# 2. Data dir rename
mkdir -p ~/.oracle
cp ~/.oracle-v2/oracle.db ~/.oracle/oracle.db

# 3. Install new version (from source)
cd /home/aitma/ghq/github.com/Soul-Brews-Studio/oracle-v2
bun install

# 4. Run migrations
bun run db:migrate  # or bunx drizzle-kit migrate

# 5. Re-index
bun src/indexer.ts

# 6. Verify
bun src/server.ts &
curl http://localhost:47778/api/health
curl "http://localhost:47778/api/search?q=test"
```

## New Tools Available After Upgrade

| Tool | Purpose |
|------|---------|
| `oracle_trace_link` | Connect related traces (bidirectional) |
| `oracle_trace_unlink` | Remove trace link |
| `oracle_trace_chain` | Navigate full linked chain |
| `oracle_handoff` | Write session context for next session |
| `oracle_inbox` | Browse pending handoffs |
| `oracle_verify` | Health check: ψ/ files vs DB index |
| `oracle_schedule_add` | Add events (Thai month support!) |
| `oracle_schedule_list` | Query upcoming events |

## Updated Tool Parameters

| Tool | New Param | Purpose |
|------|-----------|---------|
| `oracle_search` | `project`, `cwd` | Project-scoped searches |
| `oracle_learn` | `project` | Tag with project context |
| `oracle_trace` | `scope` | project/cross-project/human |

## Key Config Changes

| Setting | Old | New |
|---------|-----|-----|
| Data dir | `~/.oracle-v2/` | `~/.oracle/` |
| Package | `@laris-co/oracle-v2` | `oracle-v2` |
| MCP SDK | ^0.5.0 | ^1.27.1 |
| ChromaDB | Direct npm | Via MCP protocol |

## Environment Variables

```bash
ORACLE_PORT=47778          # Server port
ORACLE_DATA_DIR=~/.oracle  # Data directory
ORACLE_DB_PATH=~/.oracle/oracle.db
ORACLE_REPO_ROOT=/path/to/repo  # Auto-detected via ψ/ presence
```

## CLI Commands (if oracle-cli installed)

```bash
oracle search "pattern matching" -t learning -l 20
oracle learn -p "Always check Oracle" -c git,safety
oracle stats --json
oracle traces -s raw -l 10
oracle schedule list
oracle vault sync
oracle health
```

## We Already Have (via vault setup)

- ψ/ symlink to oracle-vault (done Mar 4)
- Vault backup workflow working
- Content dedup would help our 1,334 indexed docs
- Schedule table would integrate with /standup skill

## What We're Missing

1. **8 new MCP tools** — handoff, inbox, verify, schedule, trace chain
2. **Project-scoped search** — `project` param in oracle_search
3. **Content dedup** in indexer (prevents duplicate vectors)
4. **Process manager** — reliable server lifecycle
5. **Drizzle ORM** — type-safe queries
6. **Authentication** — dashboard security
7. **Smart deletion** — clean up stale indexed docs
