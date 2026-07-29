# Knowledge Index Verification

The verifier compares the exact OracleIndexer parser inventory with the SQLite
metadata and FTS rows. It opens SQLite in read-only mode and never checks or
changes vector collections.

```bash
cd /home/aitma/ghq/github.com/Soul-Brews-Studio/oracle-v2
bun run verify:index -- \
  --repo-root /home/aitma/ghq/github.com/mangsriso/oracle-vault \
  --db /home/aitma/.oracle-v2/oracle.db
```

Add `--json` for paths and per-file reasons. Exit `0` means no actionable
file-to-SQLite drift; exit `2` means review and reconciliation are required.
Both paths are mandatory so the command cannot silently select a user's live
database or the wrong vault.

Count meanings:

- `healthy`: current parser output has matching metadata and exactly one
  matching FTS row per document ID.
- `missing`: an indexable file has no indexer-owned SQLite row.
- `drifted`: current parser IDs/content/concepts differ from SQLite/FTS.
- `orphaned`: an indexer source is absent, or a missing durable source has not
  been superseded.
- `excluded`: non-indexer inputs such as `_universal` mirrors, exact duplicate
  project content, and durable sources outside indexer scope.
- `preserved`: superseded durable history whose source file is intentionally
  absent.
- `untracked`: inbox handoffs; the indexer handles only resonance, learnings,
  and retrospectives.
- `collisions`: source pairs whose basename-derived legacy IDs collide and
  require deterministic source-qualified IDs.
- `actionable`: `missing + drifted + orphaned`.

Filesystem mtime differences are diagnostic only. A checkout or copy can
change mtime without changing knowledge, so content and parser output are the
correct drift invariant.

`documents == vectors` is a separate invariant. After an approved SQLite/FTS
reconciliation, run the configured model backfill and verify vector parity
separately.
