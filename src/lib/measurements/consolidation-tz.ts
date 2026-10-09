/**
 * Leaf timezone day-math + per-sample-row shape shared by the
 * consolidation drains.
 *
 * This module owns the primitives that both `consolidation-base.ts` (the
 * shared `runConsolidation` driver) and `drain-per-sample-cumulative.ts`
 * (the cumulative drain) need. It deliberately imports nothing from
 * either of those — it is a dependency-free leaf so the two can both
 * reach the helpers without forming an import cycle.
 *
 * Local day bounds (`localDayWindow`, `startOfLocalDayKey`) live in
 * `@/lib/tz/local-day`, the one start-of-day implementation.
 *
 * History: `dayKeyForUserTz`, `canonicalDailyTimestamp`, the grace
 * constant, and the `PerSampleRow` shape used
 * to live in `drain-per-sample-cumulative.ts`. `consolidation-base.ts`
 * imported them from there while `drain` imported the runner back — a
 * value-level cycle. Bundled for production (Turbopack merges tightly
 * cyclic modules into one body), the eager re-export
 * `const DRAIN_CUMULATIVE_CUTOFF_HOURS = CONSOLIDATION_GRACE_CUTOFF_HOURS`
 * was hoisted ahead of the constant it read, throwing a
 * `ReferenceError: Cannot access '…' before initialization` at worker
 * boot. Hoisting the shared leaf into this module removes the cycle at
 * its root; `drain-per-sample-cumulative.ts` re-exports these names so
 * every existing import site keeps working unchanged.
 */
import type { MeasurementType } from "@/generated/prisma/client";
// `userDayKey` lives in the pure `@/lib/tz/format` leaf (no Prisma /
// node:module pull) so importing it keeps this dependency-free module clean.
import { userDayKey } from "@/lib/tz/format";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";

/**
 * Canonical grace window shared by the cumulative + mean drains. Rows
 * whose `measuredAt` is newer than `now() - CONSOLIDATION_GRACE_CUTOFF_HOURS`
 * stay raw so today's still-in-flight watch syncs surface in the live
 * "today" view. 36 hours covers the previous calendar day plus a
 * trailing sync window for watches that weren't worn at midnight.
 */
export const CONSOLIDATION_GRACE_CUTOFF_HOURS = 36;

/**
 * The instant a fold stops at: the first instant of the local day that
 * `now - cutoffMs` falls on, in the account's zone. Rows before it belong
 * to local days that are over in full, so a fold never cuts a day (or any
 * hour of it) in two.
 *
 * Cutting at `now - cutoffMs` itself used to fold the first part of a day on
 * one run and the rest on the next, and the second run overwrote the stored
 * mean with the mean of the later part alone. The day is the grain for the
 * hourly fold too: its pre-fold DAY rollup and the derived resting figure are
 * computed from the whole day's raw rows, which only a complete day has.
 *
 * The `folded_window` ingest guard and the compaction-tombstone classifier
 * read the same boundary (`folded-window.ts`), so "folded" means the same
 * thing on all three paths.
 */
export function foldBoundary(now: Date, cutoffMs: number, tz: string): Date {
  return startOfLocalDayInTz(new Date(now.getTime() - cutoffMs), tz);
}

/**
 * Per-sample row shape the drains scan and bucket. Exposed for unit
 * testing the bucketing semantics without booting Prisma.
 */
export interface PerSampleRow {
  id: string;
  type: MeasurementType;
  value: number;
  measuredAt: Date;
  externalId: string | null;
  /**
   * Optional — only the mean-consolidation pass selects `unit` so it can
   * read the canonical unit straight off the day's rows rather than
   * issuing a separate query. The cumulative drain leaves it unselected.
   */
  unit?: string;
}

/**
 * Resolve the user's calendar-day key (`YYYY-MM-DD`) for a given
 * timestamp + timezone. Delegates to the canonical `userDayKey` so the
 * server-side and iOS-side day-keys round-trip byte-identically against
 * every other day-bucketed surface.
 */
export function dayKeyForUserTz(date: Date, tz: string): string {
  return userDayKey(date, tz);
}

/**
 * Compute the canonical timestamp for a calendar-day key. With a `tz`,
 * returns the JS-Date instant at the user's local 12:00 noon; without
 * one, returns 12:00 UTC of the day. The local-noon anchor sits a full
 * 12 h inside its calendar day, so it round-trips back to the same day
 * through `userDayKey()` in that zone — which is the
 * whole point of anchoring date-only daily records at noon rather than
 * midnight (a UTC-midnight anchor double-shifts the day for west-of-UTC
 * users on read). Matches the Withings activity sync convention (one
 * daily row per type, anchored to midday so the row sorts cleanly
 * between same-day spot samples). The string returned by
 * `toISOString()` is UTC.
 *
 * Every daily row a sync writes (Withings, Fitbit, Google Health, Polar,
 * Oura) passes the user's zone. The noon-UTC fallback is NOT day-stable
 * everywhere: from UTC+12 on (New Zealand all year, Fiji, Tonga, Samoa) noon
 * UTC is already the next local day, which is how those users saw every
 * synced daily total a day late up to v1.39.2.
 */
export function canonicalDailyTimestamp(dateKey: string, tz?: string): Date {
  // No timezone in scope: 12:00 UTC is a safe day-stable anchor for
  // every zone within ±12 h.
  if (!tz) return new Date(`${dateKey}T12:00:00.000Z`);
  const [year, month, day] = dateKey.split("-").map(Number);
  return zonedWallClockToUtc({ year, month, day, hour: 12, minute: 0 }, tz);
}

/**
 * Per-timezone cache for the hour-of-day formatter. The dense-tier hourly
 * fold calls `hourOfDayForUserTz` once per scanned sample (thousands of
 * rows per heavy user-day); constructing an `Intl.DateTimeFormat` per call
 * dominates the bucketing cost, so the formatter is built once per zone.
 */
const hourFormatterByTz = new Map<string, Intl.DateTimeFormat>();

function hourFormatterFor(tz: string): Intl.DateTimeFormat {
  const cached = hourFormatterByTz.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  hourFormatterByTz.set(tz, fmt);
  return fmt;
}

/**
 * Resolve the user's local hour-of-day (0–23) for a given instant +
 * timezone. On a fall-back DST day the repeated wall-clock hour maps both
 * of its instants to the same hour value — deliberate: the hourly fold
 * buckets by LOCAL hour, so the 25-hour day folds its duplicated hour into
 * one bucket rather than minting two rows for the same wall-clock hour.
 */
export function hourOfDayForUserTz(date: Date, tz: string): number {
  const part = hourFormatterFor(tz)
    .formatToParts(date)
    .find((p) => p.type === "hour")?.value;
  const hour = part ? Number.parseInt(part, 10) : 0;
  // Some ICU builds render midnight as "24" under hourCycle h24.
  return hour === 24 ? 0 : hour;
}

/**
 * Compute the canonical anchor instant for a (calendar-day, local-hour)
 * slot: the user's local HH:30 — the middle of the local hour, mirroring
 * the local-noon convention of `canonicalDailyTimestamp` one grain down.
 * Anchoring mid-hour keeps the instant a full 30 minutes inside its hour,
 * so it round-trips back to the same (day, hour) through
 * `dayKeyForUserTz` + `hourOfDayForUserTz` for every zone.
 *
 * DST: the offset is read at the first-guess instant and re-read once at
 * the candidate — a transition between the two shifts the offset by at
 * most one step, so the second read converges for every wall-clock time
 * that exists. On a fall-back day the ambiguous repeated HH:30 resolves
 * deterministically to one of its two instants (whichever the re-read
 * lands on), which is all the fold needs — the hourly externalId, not the
 * instant, is the row's identity.
 */
export function canonicalHourlyTimestamp(
  dateKey: string,
  hour: number,
  tz: string,
): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return zonedWallClockToUtc({ year, month, day, hour, minute: 30 }, tz);
}
