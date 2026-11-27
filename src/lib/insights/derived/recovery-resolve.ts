/**
 * v1.16.16 — canonical recovery resolution (one number, one engine).
 *
 * `RECOVERY_SCORE` is written by TWO sources that mean different things for the
 * same day:
 *   - `WHOOP`    — the device's own native recovery percentage (ground truth
 *                  when the user wears a WHOOP strap), ingested by the sync.
 *   - `COMPUTED` — the server-derived proxy (the READINESS blend persisted by
 *                  the nightly `recovery-score` job) — the fallback for a user
 *                  with no native recovery signal.
 *
 * The DECISION (locked): the WHOOP-native row is canonical WHEN PRESENT; the
 * COMPUTED proxy is the fallback. Every read surface — the wellness tile, the
 * doctor PDF, the iOS feed — must resolve to the SAME canonical row per day so
 * none of them shows the proxy and the native value as two competing series.
 *
 * Pure resolution: group rows by the physiological NIGHT they describe and,
 * per night, keep the WHOOP row when one exists, else the COMPUTED one. No DB
 * access here — the caller does the bounded read and passes rows in.
 *
 * THE DAY-ANCHOR PROBLEM (v1.16.16). The two sources stamp the SAME night on
 * opposite clocks:
 *   - WHOOP    stamps `measuredAt = updated_at` — the MORNING instant WHOOP
 *              finished scoring the night → the WAKE day D.
 *   - COMPUTED stamps `measuredAt = noon-UTC of scoreDayKey` where
 *              `scoreDayKey = (run morning) − 1 day` → the day-that-ENDED, D−1
 *              (`src/lib/insights/score-row.ts`). The 04:45 Europe/Berlin cron
 *              scores last night's signals but files them under the prior day.
 * So for ONE night the WHOOP row lands on day D and the COMPUTED proxy on day
 * D−1 — a systematic off-by-one. Bucketing raw `measuredAt` by calendar day
 * therefore leaves BOTH alive as two competing recovery days.
 *
 * The fix is a SOURCE-AWARE wake-day key: the COMPUTED proxy's day stamp is
 * shifted forward one day (the readiness of the day that ended IS the readiness
 * you wake with the next morning), and both keys are read in the user's LOCAL
 * timezone so a near-midnight / late re-score can't split a single night. The
 * COMPUTED proxy's own stored stamp (shared with stress / strain) is NOT
 * touched — the shift is a pure read-time alignment, so no ingest change and no
 * backfill are needed and two genuinely different nights stay separate.
 */
import type {
  MeasurementSource,
  PrismaClient,
} from "@/generated/prisma/client";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";
import { userDayKey } from "@/lib/tz/format";
import { isProxyRecovery } from "@/lib/scores/registry";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A `RECOVERY_SCORE` row as read for resolution. */
export interface RecoveryRow {
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
}

/**
 * The person's recovery ladder, best first: the `recovery` order of their
 * stored `sourcePriorityJson` (the settings' order), the default ladder
 * (`WHOOP > OURA > POLAR > COMPUTED`) when they set none. Every recovery
 * read resolves by it, as the SQL rank of the charts does
 * (`buildSourceRankCase`), so the ring and the chart never pick two sources
 * for one night.
 */
export type RecoveryLadder = readonly MeasurementSource[];

export function recoveryLadder(priorityJson: unknown): RecoveryLadder {
  return getSourceLadder(parseSourcePriority(priorityJson), "recovery");
}

/** A source's place on `ladder`; one off it falls below all of them. */
export function recoveryRank(
  ladder: RecoveryLadder,
  source: MeasurementSource | string,
): number {
  const idx = ladder.indexOf(source as MeasurementSource);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/**
 * The local WAKE-day key a recovery row describes. WHOOP's stamp already IS the
 * wake morning, so its local day is the night's wake day directly. The COMPUTED
 * proxy stamps the day-that-ended (`scoreDayKey = run − 1 day`), so its day is
 * shifted forward by one before the local-day read — aligning it onto the same
 * wake day the WHOOP row for that night carries. Reading the key in the user's
 * timezone keeps a near-midnight or late re-score on the same night.
 *
 * KNOWN LIMITATION (05-M2, deferred to v1.17.2). OURA and POLAR are bucketed by
 * the local day of their raw `measuredAt` on the assumption that both stamp the
 * wake morning. Polar always anchors `measuredAt = ${date}T00:00:00.000Z`
 * (UTC-midnight of the wake date); Oura prefers a real `bedtimeEnd` wake instant
 * but FALLS BACK to the same UTC-midnight anchor. For a user in a far-negative
 * UTC zone, a UTC-midnight anchor reads as the PREVIOUS local evening, so a
 * Polar (or Oura-fallback) night can land one day earlier than the WHOOP/Oura
 * night it should align with — splitting one physiological night across two
 * recovery days near the date line. A correct fix needs an "anchor kind"
 * (date-midnight vs real-instant) threaded through the recovery read so the
 * date-anchored sources read their wake-day in UTC while WHOOP / Oura-bedtimeEnd
 * stay local; that DTO change is out of scope for v1.17.1. Europe / positive-UTC
 * users (the common case) are unaffected.
 */
export function wakeDayKeyOf(
  d: Date,
  source: MeasurementSource,
  tz: string,
): string {
  const anchor = isProxyRecovery({ source })
    ? new Date(d.getTime() + MS_PER_DAY)
    : d;
  return userDayKey(anchor, tz);
}

/**
 * Collapse a mixed-source `RECOVERY_SCORE` set to ONE canonical row per
 * physiological NIGHT: the source highest on the person's `ladder`
 * ({@link recoveryLadder}) wins. Within a source the latest `measuredAt` wins (a same-night
 * re-score). Rows are bucketed by their local WAKE-day (the COMPUTED proxy's
 * day-that-ended stamp is shifted forward one day to meet WHOOP's wake-morning
 * stamp) so a single night never splits into two competing days. Returns the
 * canonical rows in the same shape, sorted by `measuredAt` DESCENDING so the
 * first element is the most recent canonical night — matching the order the
 * wellness reader already expects.
 *
 * `timezone` is the user's IANA zone (falls back to `Europe/Berlin` when
 * null/empty); the wake-day key is read in it so the bucket boundary tracks the
 * user's midnight, not UTC's.
 */
export function resolveCanonicalRecovery(
  rows: RecoveryRow[],
  timezone: string | null | undefined,
  ladder: RecoveryLadder,
): RecoveryRow[] {
  const rankOf = (source: MeasurementSource) => recoveryRank(ladder, source);
  const tz = resolveUserTimezone(timezone ?? null);
  const byDay = new Map<string, RecoveryRow>();
  for (const row of rows) {
    const key = wakeDayKeyOf(row.measuredAt, row.source, tz);
    const incumbent = byDay.get(key);
    if (incumbent === undefined) {
      byDay.set(key, row);
      continue;
    }
    const rowRank = rankOf(row.source);
    const incumbentRank = rankOf(incumbent.source);
    const better =
      rowRank < incumbentRank ||
      (rowRank === incumbentRank &&
        row.measuredAt.getTime() > incumbent.measuredAt.getTime());
    if (better) byDay.set(key, row);
  }
  return [...byDay.values()].sort(
    (a, b) => b.measuredAt.getTime() - a.measuredAt.getTime(),
  );
}

/**
 * 1.50 — the one proxy rule, `isProxyRecovery`: a `COMPUTED` recovery row is
 * HealthLog's own readiness blend, every other source a device's own score.
 * It lives in the score register (`@/lib/scores/registry`, importable from
 * client code) and is re-exported here beside the resolver it qualifies.
 * Every reader that decides between proxy and device asks it: the Coach
 * snapshot, the daily briefing, the dashboard score rings and the doctor
 * report.
 */
export { isProxyRecovery };

/**
 * The trailing window a "which recovery is current" read covers: the
 * wellness reader's own default, so the answer is about the same row the
 * `RECOVERY_SCORE` value was read from.
 */
export const RECOVERY_CURRENT_WINDOW_DAYS = 14;

/**
 * The canonical recovery row the `RECOVERY_SCORE` value currently rests on:
 * the same bounded read and the same per-night resolution as the wellness
 * reader, newest night first. Null when no recovery row sits in the window.
 * The caller passes its client; this module keeps no `@/lib/db` import so the
 * pure resolvers above stay importable anywhere. The person's recovery
 * ladder is read from the user row, and the zone too when the caller does
 * not pass one.
 */
export async function readCurrentCanonicalRecovery(
  db: Pick<PrismaClient, "measurement" | "user">,
  userId: string,
  now: Date,
  timezone?: string | null,
): Promise<RecoveryRow | null> {
  const cutoff = new Date(
    now.getTime() - RECOVERY_CURRENT_WINDOW_DAYS * MS_PER_DAY,
  );
  const rows = await db.measurement.findMany({
    where: {
      userId,
      type: "RECOVERY_SCORE",
      deletedAt: null,
      measuredAt: { gte: cutoff, lte: now },
    },
    select: { value: true, measuredAt: true, source: true },
    orderBy: { measuredAt: "desc" },
  });
  if (rows.length === 0) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { timezone: true, sourcePriorityJson: true },
  });
  return (
    resolveCanonicalRecovery(
      rows,
      timezone ?? user?.timezone ?? null,
      recoveryLadder(user?.sourcePriorityJson ?? null),
    )[0] ?? null
  );
}

/**
 * v1.22 — which-signal-to-trust narration support.
 *
 * When two sources of recovery diverge for the SAME physiological night (e.g.
 * the WHOOP-native band vs the COMPUTED proxy), the Coach should narrate WHICH
 * it reads and the honest reason — never silently average them into mush. This
 * is the thin wrapper over the resolver: for the MOST RECENT night that carries
 * two or more sources, it returns the canonical pick, the strongest alternative,
 * and the gap — but only when the gap is MATERIAL (below the threshold it
 * returns null so the Coach never narrates trivial noise).
 *
 * Pure, like the resolver: the caller does the bounded read and passes rows in.
 */
export interface RecoveryDivergence {
  /** The canonical source the resolver picks for that night. */
  chosenSource: MeasurementSource;
  chosenValue: number;
  /** The strongest non-chosen source present for the same night. */
  alternativeSource: MeasurementSource;
  alternativeValue: number;
  /** |chosenValue − alternativeValue|, rounded to a whole point. */
  divergence: number;
  /** True when the chosen source is a device-native reading (not COMPUTED). */
  chosenIsDirect: boolean;
}

/** Points below which two sources are "in agreement" — divergence omitted. */
const MATERIAL_RECOVERY_DIVERGENCE = 7;

export function describeRecoveryDivergence(
  rows: RecoveryRow[],
  timezone: string | null | undefined,
  ladder: RecoveryLadder,
  opts?: { materialThreshold?: number },
): RecoveryDivergence | null {
  const rankOf = (source: MeasurementSource) => recoveryRank(ladder, source);
  const tz = resolveUserTimezone(timezone ?? null);
  const threshold = opts?.materialThreshold ?? MATERIAL_RECOVERY_DIVERGENCE;

  // Group rows by wake-day, keeping the best (latest) row PER SOURCE so a
  // same-night re-score does not register as a second source.
  const byNight = new Map<string, Map<MeasurementSource, RecoveryRow>>();
  for (const row of rows) {
    const key = wakeDayKeyOf(row.measuredAt, row.source, tz);
    let bySource = byNight.get(key);
    if (!bySource) {
      bySource = new Map();
      byNight.set(key, bySource);
    }
    const incumbent = bySource.get(row.source);
    if (
      !incumbent ||
      row.measuredAt.getTime() > incumbent.measuredAt.getTime()
    ) {
      bySource.set(row.source, row);
    }
  }

  // Pick the most recent night (by its chosen row's measuredAt) that carries
  // two or more distinct sources.
  let best: { chosen: RecoveryRow; alternative: RecoveryRow } | null = null;
  let bestAt = -1;
  for (const bySource of byNight.values()) {
    if (bySource.size < 2) continue;
    const ranked = [...bySource.values()].sort(
      (a, b) =>
        rankOf(a.source) - rankOf(b.source) ||
        b.measuredAt.getTime() - a.measuredAt.getTime(),
    );
    const chosen = ranked[0];
    const alternative = ranked[1];
    if (chosen.measuredAt.getTime() > bestAt) {
      bestAt = chosen.measuredAt.getTime();
      best = { chosen, alternative };
    }
  }
  if (!best) return null;

  const divergence = Math.round(
    Math.abs(best.chosen.value - best.alternative.value),
  );
  if (divergence < threshold) return null;

  return {
    chosenSource: best.chosen.source,
    chosenValue: Math.round(best.chosen.value),
    alternativeSource: best.alternative.source,
    alternativeValue: Math.round(best.alternative.value),
    divergence,
    chosenIsDirect: !isProxyRecovery(best.chosen),
  };
}
