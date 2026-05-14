/**
 * v1.4.25 W19c-Safety — Research-mode acknowledgment staleness helper.
 *
 * W19c-Frontend ships a version-mismatch re-prompt that fires whenever
 * `acknowledgedVersion !== currentDisclaimerVersion`. The version
 * constant only ratchets when Marc bumps `RESEARCH_MODE_DISCLAIMER_VERSION`
 * in `glp1-pk.ts` (copy change, new drug, new EMA EPAR version) — so
 * a user who acknowledged the current disclaimer 89 days ago and 360
 * days ago looks identical to that gate.
 *
 * This helper layers a second gate: an acknowledgment older than 90
 * days is "stale" regardless of whether the version still matches.
 * The chart can then re-prompt the user on a calendar boundary
 * (annual-ish if the version never ratchets, sooner otherwise) so
 * consent stays freshly given.
 *
 * Why a sibling module rather than an addition to `glp1-pk.ts`:
 * `glp1-pk.ts` is the W19c-Backend pure-math surface; it owns the PK
 * compute and the disclaimer-version constant, but adding a date-math
 * helper to it would dilute its responsibility. This file is the
 * thin staleness gate; importers compose it with `glp1-pk.ts` as
 * needed.
 *
 * The helper is pure: it accepts the acknowledgment timestamp + the
 * `asOf` date (caller-supplied, never `Date.now()` inside the
 * function) and returns a boolean. No I/O, no Prisma, no fetch.
 *
 * Note: W19c-Frontend has shipped without this gate wired into the
 * `DrugLevelChart` placeholder. Wiring it into the chart's gating
 * decision tree is a v1.4.26 cleanup item — see the W19c-Safety
 * phase report for the deferral rationale.
 */

/** Default staleness threshold — 90 days from acknowledgment. */
export const RESEARCH_MODE_ACK_MAX_AGE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns true when the supplied acknowledgment is older than
 * `maxAgeDays` (default 90) relative to `asOf`.
 *
 * Behaviour:
 *   - `acknowledgedAt === null` => `true` (no acknowledgment is, by
 *     definition, stale).
 *   - `acknowledgedAt` is a `Date` that's exactly `maxAgeDays` old =>
 *     `false` (the threshold is exclusive; day 90 is still inside the
 *     window, day 91 falls out).
 *   - `acknowledgedAt` in the FUTURE relative to `asOf` => `false`
 *     (treat as freshly given; defensive against clock skew or a
 *     stale `asOf` from caller).
 *   - Non-positive `maxAgeDays` => `true` whenever `acknowledgedAt`
 *     is non-null (callers should not pass zero or negative, but the
 *     helper degrades safely toward "force re-acknowledge").
 *
 * @param acknowledgedAt — the `User.researchModeAcknowledgedAt`
 *   timestamp persisted by W19c-Backend. `null` when the user has
 *   never acknowledged the current disclaimer.
 * @param asOf — the caller-supplied "now". Pass `new Date()` from
 *   call-sites; tests pin this for determinism.
 * @param maxAgeDays — staleness threshold in days. Defaults to
 *   {@link RESEARCH_MODE_ACK_MAX_AGE_DAYS}.
 */
export function isAcknowledgmentStale(
  acknowledgedAt: Date | null,
  asOf: Date,
  maxAgeDays: number = RESEARCH_MODE_ACK_MAX_AGE_DAYS,
): boolean {
  if (acknowledgedAt === null) return true;
  if (!Number.isFinite(acknowledgedAt.getTime())) return true;
  if (!Number.isFinite(asOf.getTime())) return true;
  // Future acknowledgment (clock skew) — treat as fresh.
  if (acknowledgedAt.getTime() > asOf.getTime()) return false;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return true;
  const ageMs = asOf.getTime() - acknowledgedAt.getTime();
  const thresholdMs = maxAgeDays * MS_PER_DAY;
  return ageMs > thresholdMs;
}
