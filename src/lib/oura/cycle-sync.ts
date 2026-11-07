/**
 * v1.29.x — Oura Cycle Insights (`daily_cycle_phases`) → HealthLog's cycle
 * tracker, as an ADDITIONAL, SUBORDINATE source.
 *
 * Every other Oura collection (see `./sync`) writes `Measurement` rows,
 * which support multiple source rows per `(type, day)` and resolve a
 * canonical reading at READ time (`src/lib/analytics/source-priority.ts`).
 * `CycleDayLog` has no such ladder — it is ONE canonical row per
 * `(userId, date)` (`prisma/schema.prisma` — "the HealthKit sync unit + the
 * manual log-day surface"), and the shared write helper
 * (`src/lib/cycle/day-log-write.ts`) partial-merges a re-post's fields over
 * whatever is already stored REGARDLESS of source. Calling it here would let
 * an hourly Oura poll silently demote a user's own logged flow (e.g. a
 * manual HEAVY re-tagged LIGHT on the next tick) — the exact opposite of
 * "manual wins".
 *
 * So this module never touches the shared upsert helper. It only ever
 * CREATEs a day that has NO existing `CycleDayLog` row at all (any source),
 * and never updates a row it did not itself create. A day already owned by
 * this module (source = OURA) is left alone on re-sync too: the marker is a
 * fixed single-value hint (`flow: LIGHT`), not a corrigible reading, so there
 * is nothing to refresh.
 *
 * The create goes through `createSubordinatePeriodDays`, which does what the
 * shared upsert does around the row: the day is attributed to the cycle it
 * falls in, and a first bleeding day opens its cycle, the same inference the
 * single capture, the bulk drain, the Apple Health fold and the Health Connect
 * import run. Oura reports no period length, so no period end is stamped.
 *
 * Gated behind the SAME two-layer cycle-module gate every other cycle
 * writer respects (`isCycleAvailableForUser`) so an operator-disabled
 * instance, or a user who turned cycle tracking off, never accumulates rows
 * from a background Oura poll.
 */
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { createSubordinatePeriodDays } from "@/lib/cycle/subordinate-period-days";
import { fetchDailyCyclePhases } from "./client";
import { derivePeriodDaysFromCyclePhases } from "./map";

/**
 * Sync one user's Oura `daily_cycle_phases` window into `CycleDayLog`.
 * Returns the count of days newly created.
 *
 * Every error the Oura fetch throws propagates to the caller — this
 * endpoint sits outside the scope most self-registered Oura apps are
 * granted (see the `OuraCyclePhase` docstring in `./client`), so a 403/404
 * here is the COMMON case, not an anomaly. `./sync` swallows it without
 * touching the rest of the Oura connection's health status.
 *
 * The Oura fetch runs BEFORE the cycle-module gate / any database access on
 * purpose: the overwhelmingly common outcome (no access to this endpoint, or
 * no transition in the window) resolves without a single query.
 */
export async function syncUserOuraCyclePhases(
  userId: string,
  accessToken: string,
  window: { startDate: string; endDate: string },
): Promise<number> {
  // The window is the measurement sync's own, cut on the user's calendar days.
  // Deriving it here from UTC dates made the two legs ask Oura for different
  // days whenever the user's date and the UTC date differ (every evening west
  // of UTC, every early morning east of it).
  const records = await fetchDailyCyclePhases(accessToken, window);
  if (records.length === 0) return 0;

  const periodDays = derivePeriodDaysFromCyclePhases(records);
  if (periodDays.length === 0) return 0;

  const available = await isCycleAvailableForUser(userId);
  if (!available) return 0;

  return createSubordinatePeriodDays(userId, "OURA", periodDays);
}
