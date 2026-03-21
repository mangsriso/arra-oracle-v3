# oracle-v2 Learning Index

## Latest Exploration
**Date**: 2026-03-08
**Mode**: Deep Dive (5 agents)
**Focus**: What changed from our installed 0.2.3 to repo 0.4.0

**Files**:
- [2026-03-08_ARCHITECTURE](./2026-03-08_ARCHITECTURE.md) — Structure & module map
- [2026-03-08_CODE-SNIPPETS](./2026-03-08_CODE-SNIPPETS.md) — Key code patterns
- [2026-03-08_QUICK-REFERENCE](./2026-03-08_QUICK-REFERENCE.md) — Migration summary & new features
- [2026-03-08_MIGRATION-CHECKLIST](./2026-03-08_MIGRATION-CHECKLIST.md) — Step-by-step upgrade guide
- [2026-03-08_DEEP-DIVE-AGENTS](./2026-03-08_DEEP-DIVE-AGENTS.md) — Agent analysis summary

## Timeline
### 2026-03-08 (First exploration — deep dive)
- Version gap: 0.2.3 → 0.4.0 (78 commits, 2 minor versions)
- 8 new MCP tools (trace chain, handoff, inbox, verify, schedule)
- 3 breaking changes (consult removed, decisions removed, data dir renamed)
- Vault + content dedup + process manager are the big wins
- Recommendation: upgrade is worth it, risk manageable
