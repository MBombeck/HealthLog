/**
 * v1.10.0 — passthrough read of the persisted nightly wellness scores
 * (`RECOVERY_SCORE` / `STRESS_SCORE` / `STRAIN_SCORE`).
 *
 * These three 0–100 composites are NOT recomputed here. A nightly job
 * (`src/lib/jobs/{recovery,stress,strain}-score.ts`) writes them as
 * `COMPUTED`-source Measurement rows; this engine simply reads the most
 * recent persisted value plus a short trend so the SAME `Derived<T>`
 * contract every other derived metric speaks also carries the scores. No
 * surface ever recomputes — the dashboard, Coach, and doctor report all
 * pattern-match the `Derived<WellnessScoreValue>` this returns.
 *
 * Server-only — reads `@/lib/db`.
 */
import { prisma } from "@/lib/db";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { buildInsufficient, buildOk, nowProvenanceTimestamp } from "./coverage";
import type { BaselineProfile } from "./baseline";
import type { StrainAnchor } from "@/lib/insights/strain-score";
import { computeReadiness, type ReadinessComponent } from "./readiness";
import { resolveCanonicalRecovery } from "./recovery-resolve";
import { SPARKLINE_MAX_POINTS, type Derived } from "./types";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";

/** A 0–100 wellness score band. Higher is better for recovery; for stress a
 *  higher score is worse, so the band direction flips (see `WELLNESS_DIR`). */
export type WellnessScoreBand = "green" | "yellow" | "red";

export interface WellnessScoreValue {
  /** The latest persisted 0–100 score. */
  score: number;
  band: WellnessScoreBand;
  /** Score minus the trailing-window mean (excluding today), or null. */
  trendDelta: number | null;
  /** Distinct days with a score in the window — drives the trend confidence. */
  daysInWindow: number;
  /** ISO timestamp of the latest score's `measuredAt`. */
  asOf: string;
  /**
   * Trailing score series (oldest → newest), capped to the last
   * `SPARKLINE_MAX_POINTS`. Reuses the window rows already read — no extra
   * query.
   */
  series: number[];
  /**
   * STRAIN only — which anchor produced THIS score: `personal` once the user
   * has enough training history to be judged against their own typical effort,
   * `population` during cold start. Read from the latest `strain_trimp_cache`
   * row for the scored day so the UI can show the framing line that actually
   * applies, not a generic both-regimes blurb. `null` for RECOVERY / STRESS
   * (no anchor concept) or when no cache row exists yet (additive — iOS
   * non-breaking).
   */
  anchor?: StrainAnchor | null;
  /**
   * v1.27.5 — RECOVERY only: the factor decomposition behind the score, so
   * the detail page renders the same ranked contributor bars the READINESS /
   * SLEEP_SCORE composites carry. The persisted row stores only the number;
   * the components come from a server-side run of the SAME readiness blend
   * that mints the nightly score (`computeRecoveryScore` delegates to
   * `computeReadiness` verbatim), so weights and per-factor values can never
   * drift from the engine. Only attached when the canonical latest row is
   * the COMPUTED proxy — a WHOOP-native percentage is not our blend, so it
   * carries no decomposition. `null` / absent otherwise (additive — iOS
   * non-breaking).
   */
  components?: ReadinessComponent[] | null;
  /**
   * STRAIN only — set when the score is the device's own day strain rather
   * than the server's computed proxy: no proxy row exists in the window, but
   * the band delivered `DAY_STRAIN` (WHOOP's 0–21 scale). `value` is the
   * device's latest reading on its own scale; `score` is that reading as a
   * share of `scaleMax`, so the ring and the band keep their 0–100 contract.
   * Absent whenever the computed proxy is the source.
   */
  device?: { value: number; scaleMax: number } | null;
}

/**
 * The device-native day-strain scale. WHOOP reports cycle strain on 0–21;
 * the ingest validation (`DAY_STRAIN: { min: 0, max: 21 }`) pins the same
 * bound, so a stored reading can never exceed it.
 */
export const DEVICE_STRAIN_SCALE_MAX = 21;

/** The three persisted score types this engine serves. */
export const WELLNESS_SCORE_TYPES = {
  RECOVERY_SCORE: "RECOVERY_SCORE",
  STRESS_SCORE: "STRESS_SCORE",
  STRAIN_SCORE: "STRAIN_SCORE",
} as const;

export type WellnessScoreType = keyof typeof WELLNESS_SCORE_TYPES;

/** `true` when a higher score is the healthier direction. Stress + strain
 *  invert (more = worse / harder), so the band flips for them. */
const HIGHER_IS_BETTER: Record<WellnessScoreType, boolean> = {
  RECOVERY_SCORE: true,
  STRESS_SCORE: false,
  STRAIN_SCORE: false,
};

/** Band a 0–100 score honouring the metric's direction. */
export function bandWellnessScore(
  type: WellnessScoreType,
  score: number,
): WellnessScoreBand {
  const good = HIGHER_IS_BETTER[type]
    ? score
    : // Invert for stress/strain so 80 stress reads red, not green.
      100 - score;
  if (good >= 70) return "green";
  if (good >= 40) return "yellow";
  return "red";
}

export interface WellnessScoreOpts {
  /** Trailing window for the trend mean (days). Defaults to 14. */
  windowDays?: number;
  now?: Date;
  /**
   * The user's IANA timezone, used only by the RECOVERY canonical-night
   * resolver to bucket WHOOP + COMPUTED rows by the local wake-day. When
   * omitted, the reader loads it from the user row (falling back to
   * `Europe/Berlin`). STRESS / STRAIN ignore it.
   */
  timezone?: string | null;
}

/**
 * Read the latest persisted wellness score + a trailing trend. Returns
 * `insufficient` with `reason: "no_score_in_window"` when the nightly job
 * has not yet written one (e.g. a brand-new account, or no underlying
 * signals) — never a fabricated value.
 */
export async function computeWellnessScore(
  type: WellnessScoreType,
  userId: string,
  profile: BaselineProfile,
  opts: WellnessScoreOpts = {},
): Promise<Derived<WellnessScoreValue>> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 14;
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const computedAt = nowProvenanceTimestamp(now);
  const measurementType = WELLNESS_SCORE_TYPES[type] as MeasurementType;

  // RECOVERY_SCORE is written by TWO sources for the same day — the WHOOP
  // native percentage and the COMPUTED proxy. The native row is canonical when
  // present, so the read must NOT hard-filter to COMPUTED (that silently drops
  // every ingested native row); read both sources and resolve per day below.
  // STRESS / STRAIN are COMPUTED-only, so they keep the source filter.
  const isRecovery = type === "RECOVERY_SCORE";
  const rawRows = await prisma.measurement.findMany({
    where: {
      userId,
      type: measurementType,
      ...(isRecovery ? {} : { source: "COMPUTED" as MeasurementSource }),
      deletedAt: null,
      measuredAt: { gte: cutoff, lte: now },
    },
    select: { value: true, measuredAt: true, source: true },
    orderBy: { measuredAt: "desc" },
  });

  // Collapse a mixed-source recovery set to ONE canonical row per day (WHOOP
  // wins over COMPUTED). Non-recovery sets are already single-source, so the
  // resolver is recovery-only — the tile, doctor PDF, and iOS feed all read the
  // SAME canonical value.
  let timezone = opts.timezone ?? null;
  if (isRecovery && timezone === null) {
    // The canonical-night resolver buckets by the user's local wake-day, so the
    // off-by-one between WHOOP's wake-morning stamp and the COMPUTED proxy's
    // day-that-ended stamp collapses onto one night. Load the zone once.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    timezone = user?.timezone ?? null;
  }
  const rows = isRecovery
    ? resolveCanonicalRecovery(
        rawRows.map((r) => ({
          value: r.value,
          measuredAt: r.measuredAt,
          source: r.source,
        })),
        timezone,
      )
    : rawRows;

  // STRAIN has a second, device-native source: the band's own DAY_STRAIN,
  // which `/insights/recovery` charts. Without a computed proxy in the window
  // the strain page reads that same series instead of reporting "not enough
  // data" for an account the recovery page shows weeks of strain for.
  if (rows.length === 0 && type === "STRAIN_SCORE") {
    const deviceRows = await prisma.measurement.findMany({
      where: {
        userId,
        type: "DAY_STRAIN",
        deletedAt: null,
        measuredAt: { gte: cutoff, lte: now },
      },
      select: { value: true, measuredAt: true, source: true },
      orderBy: { measuredAt: "desc" },
    });
    if (deviceRows.length > 0) {
      if (timezone === null) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { timezone: true },
        });
        timezone = user?.timezone ?? null;
      }
      return buildDeviceStrain(
        deviceStrainDays(deviceRows, timezone),
        windowDays,
        computedAt,
      );
    }
  }

  if (rows.length === 0) {
    return buildInsufficient<WellnessScoreValue>({
      coverage: {
        requiredInputs: 1,
        presentInputs: 0,
        historyDays: 0,
        missing: [type],
      },
      provenance: { inputs: [type], source: "none", windowDays, computedAt },
      reason: "no_score_in_window",
    });
  }

  const latest = rows[0];
  const score = Math.round(latest.value);
  // Trend = latest vs the mean of the prior rows in the window.
  const prior = rows.slice(1);
  const trendDelta =
    prior.length > 0
      ? Math.round(
          score - prior.reduce((s, r) => s + r.value, 0) / prior.length,
        )
      : null;

  // STRAIN carries the active anchor for the scored day so the UI shows the
  // framing line that actually produced THIS score (personal-relative vs the
  // cold-start population reference). The `strain_trimp_cache` row is keyed by
  // the same day stamp the score row carries (`scoreDayKey` → noon-UTC
  // `measuredAt`), so the latest score's day key is the cache key. Source of
  // truth is the cache row, not a re-derivation here.
  let anchor: StrainAnchor | null = null;
  if (type === "STRAIN_SCORE") {
    const day = dateOnlyKey(latest.measuredAt);
    const cache = await prisma.strainTrimpCache.findUnique({
      where: { userId_day: { userId, day } },
      select: { anchor: true },
    });
    if (cache?.anchor === "personal" || cache?.anchor === "population") {
      anchor = cache.anchor;
    }
  }

  // v1.27.5 — RECOVERY factor decomposition. The persisted row stores only
  // the number, but the COMPUTED proxy IS the readiness blend
  // (`computeRecoveryScore` delegates to `computeReadiness` verbatim), so the
  // blend's per-factor sub-scores are the honest breakdown to show under the
  // ring — same engine, same weights, resolved server-side on the same read.
  // A WHOOP-native canonical row is not our blend and carries none. Never
  // fails the read: a gated blend (below the min-component floor) simply
  // leaves the breakdown off.
  let components: ReadinessComponent[] | null = null;
  if (isRecovery && latest.source === "COMPUTED") {
    const readiness = await computeReadiness(userId, profile, {
      now,
      tz: timezone ?? undefined,
    });
    if (readiness.status === "ok" && readiness.value) {
      components = readiness.value.components;
    }
  }

  return buildOk<WellnessScoreValue>({
    value: {
      score,
      band: bandWellnessScore(type, score),
      trendDelta,
      daysInWindow: rows.length,
      asOf: latest.measuredAt.toISOString(),
      // rows are newest-first; the sparkline wants oldest → newest, capped.
      series: rows
        .slice(0, SPARKLINE_MAX_POINTS)
        .map((r) => r.value)
        .reverse(),
      anchor,
      components,
      device: null,
    },
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: rows.length,
      missing: [],
    },
    // The score is a persisted, already-computed composite — high
    // confidence by construction; the trailing-day count carries the
    // trend's strength via the coverage meter rather than the band.
    confidence: { score: 90, band: "high" },
    provenance: {
      inputs: [type],
      source: "DAY",
      windowDays,
      computedAt,
    },
  });
}

/** A device day-strain reading as a 0–100 share of the device scale. */
function deviceStrainShare(value: number): number {
  const clamped = Math.min(Math.max(value, 0), DEVICE_STRAIN_SCALE_MAX);
  return Math.round((clamped / DEVICE_STRAIN_SCALE_MAX) * 100);
}

/**
 * One row per local calendar day from the band's DAY_STRAIN rows. The band
 * writes one row per physiological cycle, stamped at the cycle's start, and
 * a bedtime either side of midnight puts two cycle starts on one calendar
 * day. Counted as rows, those days were counted twice and the sparkline
 * carried an extra point the recovery page's daily chart does not have. The
 * day's value is the mean of its rows, which is the chart's own daily value;
 * the day stands at its latest row. Newest day first.
 */
export function deviceStrainDays(
  rows: readonly { value: number; measuredAt: Date }[],
  timezone: string | null,
): { value: number; measuredAt: Date }[] {
  const tz = resolveUserTimezone(timezone);
  const byDay = new Map<
    string,
    { sum: number; count: number; measuredAt: Date }
  >();
  for (const row of rows) {
    const key = dayKeyForUserTz(row.measuredAt, tz);
    const day = byDay.get(key);
    if (!day) {
      byDay.set(key, { sum: row.value, count: 1, measuredAt: row.measuredAt });
      continue;
    }
    day.sum += row.value;
    day.count += 1;
    if (row.measuredAt.getTime() > day.measuredAt.getTime()) {
      day.measuredAt = row.measuredAt;
    }
  }
  return [...byDay.values()]
    .map((day) => ({ value: day.sum / day.count, measuredAt: day.measuredAt }))
    .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
}

function buildDeviceStrain(
  rows: { value: number; measuredAt: Date }[],
  windowDays: number,
  computedAt: string,
): Derived<WellnessScoreValue> {
  const latest = rows[0];
  const score = deviceStrainShare(latest.value);
  const prior = rows.slice(1).map((r) => deviceStrainShare(r.value));
  const trendDelta =
    prior.length > 0
      ? Math.round(score - prior.reduce((s, v) => s + v, 0) / prior.length)
      : null;
  return buildOk<WellnessScoreValue>({
    value: {
      score,
      band: bandWellnessScore("STRAIN_SCORE", score),
      trendDelta,
      daysInWindow: rows.length,
      asOf: latest.measuredAt.toISOString(),
      series: rows
        .slice(0, SPARKLINE_MAX_POINTS)
        .map((r) => deviceStrainShare(r.value))
        .reverse(),
      anchor: null,
      components: null,
      device: {
        value: Math.round(latest.value * 10) / 10,
        scaleMax: DEVICE_STRAIN_SCALE_MAX,
      },
    },
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: rows.length,
      missing: [],
    },
    confidence: { score: 90, band: "high" },
    provenance: {
      inputs: ["DAY_STRAIN"],
      source: "DAY",
      windowDays,
      computedAt,
    },
  });
}
