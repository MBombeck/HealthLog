/**
 * In-process dedup helper for fire-and-forget audit-log rows.
 *
 * A misbehaving iOS client looping on a 422 can otherwise write
 * thousands of identical audit rows per minute. Routes that emit a
 * `<route>.validation-failed` audit row alongside a multi-issue Zod
 * 422 envelope wrap the write through `shouldEmitAuditRow` to gate
 * on a 60 s `(userId, action)` window — only the first 422 inside
 * the window writes; subsequent 422s still return the full envelope
 * but skip the breadcrumb.
 *
 * In-memory only — a process restart resets the map, which is the
 * safe failure mode (worst case: one extra audit row per restart).
 * Cluster deployments still get one row per process per minute,
 * which is fine for the operator-grep use case the audit row
 * exists for.
 */

const AUDIT_DEDUP_WINDOW_MS = 60_000;
const auditDedupMemo = new Map<string, number>();

export function shouldEmitAuditRow(
  userId: string,
  action: string,
  now: number = Date.now(),
): boolean {
  const key = `${userId}:${action}`;
  const last = auditDedupMemo.get(key);
  if (last !== undefined && now - last < AUDIT_DEDUP_WINDOW_MS) {
    return false;
  }
  auditDedupMemo.set(key, now);
  if (auditDedupMemo.size > 512) {
    for (const [k, t] of auditDedupMemo) {
      if (now - t >= AUDIT_DEDUP_WINDOW_MS) auditDedupMemo.delete(k);
    }
  }
  return true;
}

/** @internal — exported for unit tests only. */
export function __resetAuditDedupMemoForTests(): void {
  auditDedupMemo.clear();
}
