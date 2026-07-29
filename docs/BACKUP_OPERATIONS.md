# Backup Operations

Oracle's backup command creates a consistent SQLite snapshot, verifies that it
is restorable, exports the verified snapshot to JSON and CSV, then applies
retention. It does not require the embedding environment.

## Scheduled command

Run from the repository so Bun resolves the checked-out source:

```bash
cd /home/aitma/ghq/github.com/Soul-Brews-Studio/oracle-v2 &&
ORACLE_DATA_DIR="$HOME/.oracle-v2" \
ORACLE_DB_PATH="$HOME/.oracle-v2/oracle.db" \
ORACLE_BACKUP_KEEP=10 \
ORACLE_BACKUP_MAX_AGE_HOURS=30 \
bun run backup:create
```

Keep both paths explicit in cron because its environment may differ from the
running service. Change them together if the deployment uses another location.

Exit status:

- `0`: snapshot, verification, exports, and retention all succeeded.
- `1`: snapshot or restore verification failed.
- `75`: another live process owns the backup lock; no backup was created.
- `2`: invalid CLI usage.

## Restore verification

Verify a specific recovery point without modifying it:

```bash
cd /home/aitma/ghq/github.com/Soul-Brews-Studio/oracle-v2 &&
bun run backup:verify -- /path/to/oracle.db.backup-TIMESTAMP
```

The command fails unless all of these gates pass:

1. `PRAGMA integrity_check` returns exactly `ok`.
2. `PRAGMA foreign_key_check` returns no violations.
3. `oracle_documents` and `oracle_fts` have one-to-one ID parity, including no
   duplicate, missing, or orphaned FTS rows.
4. The Drizzle migration sequence matches the source migration journal.
5. The immutable recovery timestamp encoded in the canonical
   `.backup-TIMESTAMP` filename is within `ORACLE_BACKUP_MAX_AGE_HOURS`
   (default 30). Copying or touching a stale file cannot make it appear fresh.

The report also prints the newest `oracle_documents.updated_at` timestamp for
recovery-point inspection.

## Retention

`ORACLE_BACKUP_KEEP` defaults to 10. Retention is applied independently to
every detected top-level family:

- `*.backup-*`
- `*.export-*.json` and `*.export-*.csv`
- `*.bak-*`
- `*.before-*`
- `*.checkpoint-*`
- `lancedb.backup-*`
- `pre-fix-*`

Expired files and directories move into a unique batch directory under
`~/.trash`; existing history is never overwritten. Cross-filesystem moves use
a verified copy followed by source removal only after the copy is complete.
