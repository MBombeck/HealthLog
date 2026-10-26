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
 * this module (source = OURA) is left alone on re-sync too — the marker is
 * a fixed single-value hint (`flow: LIGHT`), not a corrigible reading, so
 * there is nothing to refresh. The whole path degenerates to a cheap
 * "create if absent, otherwise no-op".
 *
 * Gated behind the SAME two-layer cycle-module gate every other cycle
 * writer respects (`isCycleAvailableForUser`) so an operator-disabled
 * instance, or a user who turned cycle tracking off, never accumulates rows
 * from a background Oura poll. No `MenstrualCycle` span is ever created or
 * mutated here — mirrors the Apple Health importer precedent
 * (`src/lib/cycle/import-accumulator.ts`), which attributes day-logs to an
 * EXISTING cycle but never synthesises a new one from flow data either;
 * cycle-span creation stays an explicit user action
 * (`POST /api/cycle/period`).
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { fetchDailyCyclePhases } from "./client";
import { derivePeriodDaysFromCyclePhases } from "./map";

/** The conservative "logged but unspecified intensity" flow level — mirrors
 * the HealthKit `unspecified` → `LIGHT` boundary documented in
 * `healthkit-mapping.ts`: a detected-but-unmeasured bleeding day is at least
 * light flow, never invented as MEDIUM/HEAVY. */
const OURA_PERIOD_FLOW = "LIGHT" as const;

/** Prisma P2002 (unique constraint) detector, mirrored locally from
 * `day-log-write.ts` rather than imported — a two-line duplicate is cheaper
 * than coupling this module to that helper's internals. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

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

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = user?.timezone ?? null;

  let created = 0;
  for (const day of periodDays) {
    try {
      await prisma.cycleDayLog.create({
        data: {
          userId,
          date: day,
          tz,
          source: "OURA",
          flow: OURA_PERIOD_FLOW,
        },
      });
      created += 1;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A row already exists for this date — the user's own entry, an
        // Apple Health import, or this module's own prior write. Never
        // overwrite: Oura is a subordinate signal here.
        continue;
      }
      getEvent()?.addWarning(
        `oura: cycle day-log create failed for ${userId} ${day}: ${err}`,
      );
    }
  }
  return created;
}
