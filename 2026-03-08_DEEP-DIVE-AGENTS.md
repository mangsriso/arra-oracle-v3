# Oracle v2 Deep Dive: 5-Agent Analysis

> Explored: 2026-03-08 | Mode: deepdive 5 agents

## Agent Assignments

| Agent | Scope | Key Findings |
|-------|-------|-------------|
| 1. MCP Tools | Tool diff (local vs repo) | 8 new tools, 3 updated params |
| 2. Vault & Indexer | Storage + indexing changes | Project-first layout, content-hash dedup, smart deletion |
| 3. Architecture & Infra | Server + process manager | Modular server, process manager, auth, config extraction |
| 4. CLI & Frontend | User interfaces | 11 CLI commands, frontend extracted to oracle-studio |
| 5. Breaking Changes | Migration path | 3 breaking removals, MCP SDK major bump, data dir rename |

## Top Insights

### 1. We're 2 Minor Versions Behind
Our installed 0.2.3 is missing significant infrastructure. The 0.4.0 version is production-ready with proper process management, auth, and vault integration.

### 2. Decisions Feature Was Wrong Abstraction
The team removed `oracle_decisions_*` (4 tools) because decisions emerge naturally from traces + learnings. Explicit decision tracking was redundant. This aligns with our experience — we rarely used decisions tools.

### 3. Vault Is Already Working For Us
We set up the vault symlink on Mar 4. The new indexer would enhance this with:
- Content-hash dedup (prevents duplicate vectors)
- Project-first scanning (discovers all vault projects)
- Smart deletion (cleans stale docs)

### 4. Schedule Tools Would Integrate Well
`oracle_schedule_add` + `oracle_schedule_list` with Thai month support would pair perfectly with our `/standup` and `/schedule` skills.

### 5. MCP SDK Jump Is The Riskiest Part
Going from ^0.5.0 to ^1.27.1 is a major version jump. Need to verify all tool definitions still work with the new SDK.

## What We Actually Use vs What Changed

| Feature We Use | Still Works? | Notes |
|---------------|-------------|-------|
| `oracle_search` | YES + enhanced | New project/cwd params |
| `oracle_learn` | YES + enhanced | New project param |
| `oracle_reflect` | YES | No changes |
| `oracle_list` | YES | No changes |
| `oracle_stats` | YES | No changes |
| `oracle_supersede` | YES | No changes |
| `oracle_trace` | YES + enhanced | New scope param |
| `oracle_trace_list/get` | YES | No changes |
| `oracle_thread*` | YES | No changes |
| `oracle_concepts` | YES | No changes |
| `oracle_consult` | NO — REMOVED | Use search + reflect |
| `oracle_decisions_*` | NO — REMOVED | Use trace + learn |

## Recommendation

**Upgrade is worth it** for:
1. 8 new tools (especially handoff, verify, schedule)
2. Content dedup in indexer
3. Project-scoped search
4. Process manager reliability

**Risk is manageable**:
- Only 2 tools removed (consult + decisions) — we rarely used them
- Data dir rename is straightforward
- MCP SDK bump needs testing but the tool definitions are compatible
