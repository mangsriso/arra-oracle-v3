/**
 * True for SQLite lock contention (SQLITE_BUSY / SQLITE_LOCKED and their extended codes,
 * e.g. SQLITE_BUSY_RECOVERY = 261). These are transient: another connection holds the
 * write lock for longer than busy_timeout. Nothing was written by the failing statement.
 */
export function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  if (typeof errno === 'number') {
    const primary = errno & 0xff;
    return primary === 5 || primary === 6;
  }
  return typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)/.test(code);
}
