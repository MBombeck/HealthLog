/**
 * How long a deleted account, a wiped record and a deleted managed profile
 * stay recoverable before anything is erased.
 *
 * Personal health data deleted by a mis-tap was, until v1.46, gone the moment
 * the confirmation was pressed: the account row cascaded into every table,
 * every stored copy went with it, and the off-host objects were purged in the
 * same breath. Nothing short of rolling the whole instance back could bring
 * one account back. So the three erasures now wait out a grace window:
 *
 *   - Account deletion (self or a Guardian deleting a managed profile) locks
 *     the account at once — every credential is revoked and sign-in is
 *     refused — and the purge job erases it when the window ends. An admin
 *     can undo it until then.
 *   - A data wipe takes an account copy first (`PRE_WIPE_<ms>`), keeps it for
 *     the window, and holds the off-host purge back until the window ends.
 *
 * `ACCOUNT_DELETION_GRACE_DAYS` sets the window. `0` keeps the immediate
 * erasure every release before v1.46 performed. The ceiling is 30 days: the
 * window exists to recover a mistake, and an erasure the person asked for
 * should complete without undue delay, so a larger value is clamped rather
 * than obeyed. Anything that is not a whole number falls back to the default.
 *
 * The privacy summary publishes the resolved value
 * (`GET /api/settings/privacy-summary`), so every sentence that names the
 * window states the number the purge job acts on.
 */

const DEFAULT_ACCOUNT_DELETION_GRACE_DAYS = 14;
const MAX_ACCOUNT_DELETION_GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The configured window in whole days; `0` means erase immediately. */
export function accountDeletionGraceDays(): number {
  const raw = process.env.ACCOUNT_DELETION_GRACE_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_ACCOUNT_DELETION_GRACE_DAYS;
  return Math.min(Number.parseInt(raw, 10), MAX_ACCOUNT_DELETION_GRACE_DAYS);
}

/** When something asked for at `requestedAt` is erased, or null for now. */
export function accountDeletionPurgeAt(
  requestedAt: Date,
  graceDays: number = accountDeletionGraceDays(),
): Date | null {
  if (graceDays <= 0) return null;
  return new Date(requestedAt.getTime() + graceDays * DAY_MS);
}

/** The oldest creation time a `PRE_WIPE_<ms>` copy may have and still be kept. */
export function preWipeCopyCutoff(
  now: Date,
  graceDays: number = accountDeletionGraceDays(),
): Date {
  return new Date(now.getTime() - Math.max(graceDays, 0) * DAY_MS);
}
