/**
 * v1.10.0 — computed scores (WX-E). The Strain score ENGINE + persistence.
 *
 * A daily cardio-load proxy (0–100, higher = more training strain) built
 * from the per-workout heart-rate series (`WorkoutSamples`, WX-D) plus
 * active-energy burned (`ACTIVE_ENERGY_BURNED`).
 *
 * CARDIO-LOAD MODEL — Banister's TRIMP (Training Impulse).
 * For each workout's HR series we compute the gender-weighted exponential
 * TRIMP:
 *
 *     TRIMP = Σ (Δt_min · HRr · 0.64 · e^(1.92 · HRr))     (men)
 *     TRIMP = Σ (Δt_min · HRr · 0.86 · e^(1.67 · HRr))     (women)
 *
 *   where HRr = (HR − HRrest) / (HRmax − HRrest) is the fractional
 *   heart-rate reserve per sample, Δt_min the minutes that sample
 *   represents, HRmax the age-predicted maximum (Tanaka 2001:
 *   208 − 0.7·age), and HRrest the user's resting heart rate.
 *
 * Standard: Banister EW, "Modeling Elite Athletic Performance" (1991);
 * the gender-weighted exponential form is from Morton, Fitz-Clarke &
 * Banister 1990, J. Appl. Physiol. 69(3):1171–1177. Tanaka HRmax:
 * Tanaka, Monahan & Seals 2001, J. Am. Coll. Cardiol. 37(1):153–156.
 *
 * The per-workout TRIMP values are summed across the scored day to a
 * day-total TRIMP, then mapped to the 0–100 scale by a saturating curve.
 *
 * v1.10.3 — PERSONAL-RELATIVE ANCHOR. The 0–100 map is anchored to the
 * USER'S OWN recent training-day load, not a fixed population reference: the
 * reference that maps to score ≈ 63 is the EWMA-smoothed 75th percentile of
 * the user's own training-day (TRIMP > 0) day-total TRIMP over a 42-day
 * chronic window (the acute-vs-chronic framing Garmin Training Load uses,
 * the personal-zone idea WHOOP uses). This makes the score meaningful for a
 * deconditioned or chronic-condition user, who would otherwise be pinned near
 * 0 against the population anchor regardless of how hard *they* worked. Below
 * a 7-training-day cold-start floor the engine falls back to the fixed
 * population anchor (`STRAIN_TRIMP_REFERENCE` ≈ a hard hour), recorded as
 * `anchor: "population"`. The anchor is derived from the TRIMP INPUT, never
 * from the 0–100 OUTPUT, so there is no circular feedback.
 *
 * Days with NO usable HR series but WITH active energy fall back to an
 * active-energy-only proxy so a "logged but no series" workout still
 * registers some strain (clearly the weaker signal, and with no personal
 * intensity distribution it stays on the population anchor — the provenance
 * records which path + which anchor produced the score).
 *
 * Honest confidence: the score is only stored when the day carried at least
 * one workout HR series with usable samples OR a non-trivial active-energy
 * total AND the user profile yields an HRmax (needs age) + a resting HR.
 * Below that the engine returns `insufficient` and NO row is written.
 *
 * Row shape (identical posture to the Recovery + Stress scores):
 *   - `type   = STRAIN_SCORE`
 *   - `source = COMPUTED`
 *   - `unit   = "score"`
 *   - `value  = 0..100`
 *   - `externalId = strain:YYYY-MM-DD`
 *
 * The score is descriptive — a daily training-load proxy, NOT a clinical
 * assessment. In the doctor PDF it is segregated into a clearly-labelled,
 * disclaimed Wellness-summary section, kept out of the clinical-vitals body.
 * Server-only — runs from the nightly pg-boss job in
 * `src/lib/jobs/strain-score.ts`.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { loadBaselineProfile } from "@/lib/insights/derived/baseline";
import type { ProfileSex } from "@/lib/profile/sex";
import {
  scoreDayKey,
  scoreExternalId,
  scoreMeasuredAt,
  upsertScoreRow,
} from "@/lib/insights/score-row";
import { shiftDateKey } from "@/lib/tz/format";
import {
  canonicalWorkoutTrimps,
  readWorkoutsAroundRange,
  rowsInRange,
  startsInRange,
} from "@/lib/workouts/canonical-read";
import {
  pickCanonicalSourceRows,
  type SourcePickerRow,
} from "@/lib/analytics/source-priority";

/** The per-day idempotency-key prefix for a stored Strain score row. */
export const STRAIN_SCORE_EXTERNAL_ID_PREFIX = "strain:";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reference day-total TRIMP that maps to a high (but not pinned) strain.
 * ~150 TRIMP is a hard ~hour of threshold work; the saturating map sends a
 * day at this load near the top of the band, with very heavy days pinned at
 * 100.
 */
export const STRAIN_TRIMP_REFERENCE = 150;

/**
 * Reference daily active-energy (kcal) for the HR-series-less fallback. A
 * busy active day (~600 kcal active) maps near the top of the band. The
 * fallback is intentionally the weaker signal — it has no intensity
 * distribution, only a volume total.
 */
export const STRAIN_ACTIVE_ENERGY_REFERENCE = 600;

/**
 * v1.10.3 — personal-relative anchor.
 *
 * The fixed `STRAIN_TRIMP_REFERENCE` is a POPULATION anchor: for a fit user a
 * hard hour ≈ 150 TRIMP → score ≈ 63, but for a deconditioned / chronic user
 * whose hardest realistic effort is, say, 25 TRIMP the score saturates near 15
 * — they gave *their* maximum and the headline reads 15. STRESS + RECOVERY are
 * already personal-relative; this brings STRAIN into line by anchoring the
 * 0–100 map to the USER'S OWN recent training-day load.
 *
 * The anchor is the EWMA-smoothed 75th percentile of the user's own
 * training-day (TRIMP > 0) day-total TRIMP over a 42-day chronic window — the
 * acute-vs-chronic framing Garmin Training Load uses, the personal-zone idea
 * WHOOP uses, gated like Oura's "a few days before it appears". We anchor on
 * the TRIMP INPUT, never on the 0–100 OUTPUT, so there is no circularity.
 */

/** Chronic window (days) the personal training-day distribution is read over. */
export const STRAIN_CHRONIC_WINDOW_DAYS = 42;

/** Percentile of the user's own training-day TRIMP that maps to score ≈ 63. */
export const STRAIN_PERSONAL_REF_PERCENTILE = 75;

/**
 * EWMA effective span (Nₑ) for smoothing the personal reference across nights,
 * α = 2/(Nₑ+1) ≈ 0.13. Mirrors Garmin's chronic moving average — the anchor
 * tracks fitness changes over weeks without day-to-day jitter.
 */
export const STRAIN_EWMA_N = 14;

/** EWMA smoothing factor derived from {@link STRAIN_EWMA_N}. */
export const STRAIN_EWMA_ALPHA = 2 / (STRAIN_EWMA_N + 1);

/**
 * Cold-start floor: distinct training days (TRIMP > 0) the user must have in
 * the chronic window before the personal anchor activates. Below it the engine
 * falls back to the population anchor, labelled lower-confidence. Counting
 * TRAINING days (not calendar days) is deliberate — the anchor describes how
 * hard the user trains *when they train*, so a twice-a-week trainer needs
 * ~3.5 weeks to qualify, which is the correct semantics.
 */
export const STRAIN_MIN_TRAINING_DAYS = 7;

/**
 * Floor on the personal reference (TRIMP). Guards against a near-zero anchor
 * (a user whose training days are all very light) inflating every trivial day
 * toward 100.
 */
export const STRAIN_PERSONAL_REF_FLOOR = 10;

/** Which anchor produced a day's score. */
export type StrainAnchor = "personal" | "population";

/** The full `externalId` for a given run's Strain score row. */
export function strainExternalId(now: Date): string {
  return scoreExternalId(STRAIN_SCORE_EXTERNAL_ID_PREFIX, now);
}

/** Noon UTC on the scored (previous) day — same convention as the other scores. */
export function strainMeasuredAt(now: Date): Date {
  return scoreMeasuredAt(now);
}

/** Tanaka 2001 age-predicted maximum heart rate. */
export function tanakaHrMax(ageYears: number): number {
  return 208 - 0.7 * ageYears;
}

interface HrSample {
  t: string;
  hr?: number;
}

/**
 * Banister gender-weighted exponential TRIMP for one workout HR series.
 * Integrates fractional-HR-reserve over the inter-sample intervals. Samples
 * with no `hr`, or with an out-of-range fractional reserve, contribute
 * zero. Returns 0 for a series with fewer than two usable HR samples (no
 * interval to integrate). Pure — exported for unit testing.
 */
export function banisterTrimp(
  samples: readonly HrSample[],
  hrRest: number,
  hrMax: number,
  sex: ProfileSex,
): number {
  if (hrMax <= hrRest) return 0;
  // Morton/Fitz-Clarke/Banister weights. The published pair covers two
  // groups and nothing else, so an account that is neither (OTHER, or no
  // answer at all) is scored on the MIDPOINT of the two models rather than
  // silently on the male one — the same neutral fallback every other
  // sex-split formula in the repo uses (`value-bands`, `classifications`,
  // `pulse-targets`). Picking a side for someone who did not pick one is a
  // guess dressed as a measurement.
  const MALE_WEIGHTS = { a: 0.64, b: 1.92 } as const;
  const FEMALE_WEIGHTS = { a: 0.86, b: 1.67 } as const;
  const weights =
    sex === "MALE"
      ? [MALE_WEIGHTS]
      : sex === "FEMALE"
        ? [FEMALE_WEIGHTS]
        : [MALE_WEIGHTS, FEMALE_WEIGHTS];

  const usable = samples
    .filter((s) => typeof s.hr === "number" && Number.isFinite(s.hr))
    .map((s) => ({ t: Date.parse(s.t), hr: s.hr as number }))
    .filter((s) => Number.isFinite(s.t))
    .sort((x, y) => x.t - y.t);
  if (usable.length < 2) return 0;

  let trimp = 0;
  for (let i = 1; i < usable.length; i++) {
    const dtMin = (usable[i].t - usable[i - 1].t) / 60_000;
    if (dtMin <= 0) continue;
    // Use the interval's mean HR for the reserve fraction.
    const meanHr = (usable[i].hr + usable[i - 1].hr) / 2;
    let hrr = (meanHr - hrRest) / (hrMax - hrRest);
    if (!Number.isFinite(hrr)) continue;
    if (hrr <= 0) continue; // below resting → no training impulse.
    if (hrr > 1) hrr = 1; // clamp a spurious over-max sample.
    // One model for a known sex; the mean of both when there is none.
    let impulse = 0;
    for (const { a, b } of weights) impulse += a * Math.exp(b * hrr);
    trimp += (dtMin * hrr * impulse) / weights.length;
  }
  return trimp;
}

/**
 * Saturating map of a non-negative load to 0–100 against a reference. Uses
 * `1 − e^(−x/ref)` scaled to 100 so the score rises steeply at low load and
 * saturates toward 100 for very heavy days — never pinned exactly at 100
 * until the load is well above the reference. Pure.
 */
export function saturateToScore(load: number, reference: number): number {
  if (!(load > 0) || !(reference > 0)) return 0;
  const score = 100 * (1 - Math.exp(-load / reference));
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * The `p`-th percentile (0–100) of a numeric sample via linear interpolation
 * between order statistics. Returns 0 for an empty sample. Pure — exported for
 * unit testing.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** The training-day TRIMP history backing the personal anchor. */
export interface StrainAnchorHistory {
  /** Day-total TRIMP for each TRAINING day (TRIMP > 0) in the chronic window. */
  trainingDayTrimps: readonly number[];
  /** The EWMA reference persisted by the previous night's run, or null on first run. */
  priorRefPersonal: number | null;
}

/** The resolved reference + the provenance the score row's cache should record. */
export interface ResolvedStrainReference {
  /** The reference to feed `saturateToScore` for the TRIMP path. */
  reference: number;
  /** Which anchor was used. */
  anchor: StrainAnchor;
  /** Distinct training days seen in the chronic window. */
  trainingDays: number;
  /**
   * The EWMA-smoothed personal reference to persist for the next night. Always
   * the personal reference even when the population anchor was used this night
   * (so the EWMA keeps warming up toward activation); null only when there is
   * no training-day history at all.
   */
  refPersonalToPersist: number | null;
}

/**
 * Resolve the day's strain reference from the user's own training-day TRIMP
 * history. Below the cold-start floor → the fixed population anchor (labelled
 * `population`); at or above it → the EWMA-smoothed P75 of the user's own
 * training-day TRIMP (labelled `personal`), floored at
 * {@link STRAIN_PERSONAL_REF_FLOOR}.
 *
 * The EWMA blends this window's P75 with the prior night's reference
 * (`ref = α·P75 + (1−α)·prev`); on the first night with any history it seeds
 * from the window P75. Anchors on the TRIMP INPUT, never the score OUTPUT, so
 * there is no circular feedback. Pure — no Prisma. Exported for unit testing.
 */
export function resolvePersonalReference(
  history: StrainAnchorHistory,
  populationReference: number = STRAIN_TRIMP_REFERENCE,
): ResolvedStrainReference {
  const trimps = history.trainingDayTrimps.filter((t) => t > 0);
  const trainingDays = trimps.length;

  // The EWMA reference warms up regardless of the cold-start gate so it is
  // ready the night the user crosses the floor.
  let refPersonalToPersist: number | null = null;
  if (trainingDays > 0) {
    const windowP75 = Math.max(
      STRAIN_PERSONAL_REF_FLOOR,
      percentile(trimps, STRAIN_PERSONAL_REF_PERCENTILE),
    );
    refPersonalToPersist =
      history.priorRefPersonal != null
        ? STRAIN_EWMA_ALPHA * windowP75 +
          (1 - STRAIN_EWMA_ALPHA) * history.priorRefPersonal
        : windowP75;
    // Keep the persisted EWMA above the floor too (a long stretch of light
    // days should never drag the anchor below it).
    refPersonalToPersist = Math.max(
      STRAIN_PERSONAL_REF_FLOOR,
      refPersonalToPersist,
    );
  }

  if (trainingDays < STRAIN_MIN_TRAINING_DAYS) {
    return {
      reference: populationReference,
      anchor: "population",
      trainingDays,
      refPersonalToPersist,
    };
  }

  return {
    reference: refPersonalToPersist as number,
    anchor: "personal",
    trainingDays,
    refPersonalToPersist,
  };
}

export interface StrainComputeResult {
  /** The 0..100 score to persist, or null when the inputs gate. */
  score: number | null;
  /** Why the result gated / which path produced the score. */
  reason:
    | "trimp"
    | "active_energy_fallback"
    | "insufficient_profile"
    | "insufficient_inputs";
  /** Day-total TRIMP (0 when no usable HR series). */
  dayTrimp: number;
  /** Day-total active energy (kcal). */
  dayActiveEnergy: number;
  /** Workouts with a usable HR series on the day. */
  workoutsWithSeries: number;
  /**
   * v1.10.3 — which anchor the score was mapped against. `personal` once the
   * user has ≥ `STRAIN_MIN_TRAINING_DAYS` training days of history (TRIMP
   * path only); `population` during cold start and always for the
   * active-energy fallback (which has no personal intensity distribution).
   */
  anchor: StrainAnchor;
  /** Distinct training days (TRIMP > 0) in the chronic window. */
  trainingDays: number;
  /** EWMA personal reference to persist for the next night, or null. */
  refPersonalToPersist: number | null;
}

export interface StrainProfile {
  ageYears: number | null;
  sex: ProfileSex;
}

/**
 * Compute the Strain score for one user as of `now`. Reads the day's
 * workouts (+ HR series) and active-energy total, computes day-total TRIMP,
 * and maps it to 0–100. Falls back to an active-energy-only proxy when no
 * HR series is usable. Pure of persistence. Gates (null score) when the
 * profile yields no HRmax / resting HR, or there is no usable input at all.
 */
export async function computeStrainScore(
  prisma: PrismaClient,
  userId: string,
  profile: StrainProfile,
  hrRest: number | null,
  now: Date,
  anchorHistory: StrainAnchorHistory = {
    trainingDayTrimps: [],
    priorRefPersonal: null,
  },
): Promise<StrainComputeResult> {
  const dayKey = scoreDayKey(now);
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: UTC day window of the UTC-day score engines (scoreDayKey)
  const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);

  // Day-total active energy first — it is the fallback signal and cheap.
  const energyRows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "ACTIVE_ENERGY_BURNED" as MeasurementType,
      deletedAt: null,
      measuredAt: { gte: dayStart, lt: dayEnd },
    },
    orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
    select: {
      value: true,
      source: true,
      deviceType: true,
      measuredAt: true,
      type: true,
    },
    take: 5000,
  });

  // The day's workouts + their HR series, with the session identity the
  // cross-source picker needs: one run recorded by the watch and synced again
  // through a second service is one training impulse, not two.
  const [account, workouts] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { sourcePriorityJson: true },
    }),
    // Read through the windowed reader: a session whose twin lies across
    // midnight is counted once, on the day the list shows it.
    readWorkoutsAroundRange({ from: dayStart, to: dayEnd }, (bounds) =>
      prisma.workout.findMany({
        where: { userId, startedAt: bounds },
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          source: true,
          sportType: true,
          startedAt: true,
          durationSec: true,
          samples: { select: { samples: true } },
        },
        take: 100,
      }),
    ),
  ]);

  // The watch and the phone relay (or a ring) both write the day's active
  // energy: one source per day, the same pick the energy chart applies.
  const dayActiveEnergy = canonicalDayActiveEnergy(
    energyRows,
    account?.sourcePriorityJson ?? null,
  );

  const hrMax = profile.ageYears != null ? tanakaHrMax(profile.ageYears) : null;
  const canTrimp = hrMax != null && hrRest != null && hrMax > hrRest;

  let dayTrimp = 0;
  let workoutsWithSeries = 0;
  if (canTrimp) {
    const trimpOf = (w: (typeof workouts.rows)[number]): number => {
      const raw = w.samples?.samples;
      if (!Array.isArray(raw)) return 0;
      return banisterTrimp(
        raw as unknown as HrSample[],
        hrRest!,
        hrMax!,
        profile.sex,
      );
    };
    const sessions = canonicalWorkoutTrimps(
      workouts.rows,
      account?.sourcePriorityJson ?? null,
      trimpOf,
      (at) => startsInRange(workouts.range, at),
    );
    for (const trimp of sessions) {
      dayTrimp += trimp;
      workoutsWithSeries += 1;
    }
  }

  // v1.10.3 — resolve the personal-vs-population reference from the user's
  // own training-day TRIMP history. Below the cold-start floor (or with no
  // history) this returns the population anchor labelled `population`. The
  // scored day's own TRIMP is included in the distribution it is judged
  // against — the anchor is "your typical hard day", today included.
  const ref = resolvePersonalReference({
    trainingDayTrimps:
      dayTrimp > 0
        ? [...anchorHistory.trainingDayTrimps, dayTrimp]
        : anchorHistory.trainingDayTrimps,
    priorRefPersonal: anchorHistory.priorRefPersonal,
  });

  if (dayTrimp > 0) {
    return {
      score: saturateToScore(dayTrimp, ref.reference),
      reason: "trimp",
      dayTrimp,
      dayActiveEnergy,
      workoutsWithSeries,
      anchor: ref.anchor,
      trainingDays: ref.trainingDays,
      refPersonalToPersist: ref.refPersonalToPersist,
    };
  }

  // No usable HR series. Fall back to the active-energy-only proxy when
  // there is a non-trivial active-energy total. A profile with no HRmax /
  // resting HR can still get this fallback because it needs neither. The
  // fallback has no personal intensity distribution, so it stays on the
  // population anchor (honestly labelled `population`).
  if (dayActiveEnergy > 0) {
    return {
      score: saturateToScore(dayActiveEnergy, STRAIN_ACTIVE_ENERGY_REFERENCE),
      reason: "active_energy_fallback",
      dayTrimp: 0,
      dayActiveEnergy,
      workoutsWithSeries: 0,
      anchor: "population",
      trainingDays: ref.trainingDays,
      refPersonalToPersist: ref.refPersonalToPersist,
    };
  }

  // Neither a usable HR series nor active energy → nothing to score. If the
  // only reason TRIMP was unavailable is the profile, say so for the log.
  return {
    score: null,
    reason:
      rowsInRange(workouts).length > 0 && !canTrimp
        ? "insufficient_profile"
        : "insufficient_inputs",
    dayTrimp: 0,
    dayActiveEnergy,
    workoutsWithSeries: 0,
    anchor: "population",
    trainingDays: ref.trainingDays,
    refPersonalToPersist: ref.refPersonalToPersist,
  };
}

/**
 * The day's active energy from ONE source. The rows of a single scored day go
 * through the cumulative-metric picker on the `activeEnergy` ladder (source,
 * then device type); when no source on the ladder is present the picker keeps
 * every row, so the sources left are then compared by their day total and the
 * largest kept: never two sources' totals added. Pure; exported for tests.
 */
export function canonicalDayActiveEnergy<
  T extends SourcePickerRow & { value: number },
>(rows: readonly T[], priorityJson: unknown): number {
  const { canonicalRows } = pickCanonicalSourceRows(
    rows,
    "activeEnergy",
    priorityJson,
    () => "day",
  );
  const bySource = new Map<string, number>();
  for (const row of canonicalRows) {
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + row.value);
  }
  let best = 0;
  for (const total of bySource.values()) best = Math.max(best, total);
  return best;
}

/**
 * Build the Strain profile (age + sex) and resting HR from the user row +
 * the latest resting-HR reading. `prisma` is the (worker) client.
 */
export async function loadStrainInputs(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<{ profile: StrainProfile; hrRest: number | null }> {
  // Reuse the shared profile loader, then narrow to the Strain profile
  // (age + sex; height is not a TRIMP input). One loader for all three
  // engines + the derived route.
  const base = await loadBaselineProfile(prisma, userId);
  const profile: StrainProfile = {
    ageYears: base.ageYears,
    sex: base.sex,
  };

  // Most recent resting-HR reading within a 30-day window — the HRrest input
  // for the TRIMP reserve fraction. Null when the user has no recent RHR.
  const since = new Date(now.getTime() - 30 * MS_PER_DAY);
  const rhr = await prisma.measurement.findFirst({
    where: {
      userId,
      type: "RESTING_HEART_RATE" as MeasurementType,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "desc" },
    select: { value: true },
  });
  return { profile, hrRest: rhr?.value ?? null };
}

/**
 * v1.10.3 — read the trailing training-day TRIMP distribution + the prior
 * EWMA reference from the server-internal `strainTrimpCache`. Reads cheap
 * cached day-total TRIMP instead of re-integrating 42 days of HR series. The
 * cache populates itself forward (no backfill); a user with no cache rows yet
 * returns an empty history → the cold-start population anchor.
 *
 * `priorRefPersonal` = the most recent cached row's `refPersonal` STRICTLY
 * before the scored day, so a re-run for the same day (idempotent recompute)
 * blends against the prior night, never against its own previous write.
 */
export async function loadStrainAnchorHistory(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<StrainAnchorHistory> {
  const dayKey = scoreDayKey(now);
  const windowStart = shiftDateKey(dayKey, -STRAIN_CHRONIC_WINDOW_DAYS);

  // The chronic window of cached rows, excluding the scored day itself (its
  // TRIMP is added at compute time so the distribution always reflects the
  // freshly-computed day).
  const rows = await prisma.strainTrimpCache.findMany({
    where: { userId, day: { gte: windowStart, lt: dayKey } },
    select: {
      day: true,
      dayTrimp: true,
      refPersonal: true,
      trainingDays: true,
    },
    orderBy: { day: "desc" },
  });

  const trainingDayTrimps = rows.map((r) => r.dayTrimp).filter((t) => t > 0);
  // The prior EWMA = the most recent cached row that actually carried personal
  // training history (`trainingDays > 0`). A row written on a pure rest /
  // energy-only day stores the population seed only to keep the column
  // non-null; adopting it would pollute the EWMA and stall personal
  // activation, so it is skipped — the seed stays unset (null) until a real
  // training day has warmed the reference.
  const warmedRow = rows.find((r) => r.trainingDays > 0);
  const priorRefPersonal = warmedRow ? warmedRow.refPersonal : null;

  return { trainingDayTrimps, priorRefPersonal };
}

/**
 * v1.10.3 — upsert the scored day's Strain anchor cache row (day-total TRIMP +
 * the EWMA reference + the anchor used + the training-day count). Idempotent on
 * `(userId, day)` so a re-fired nightly tick overwrites in place. Server-only.
 */
export async function upsertStrainTrimpCache(
  prisma: PrismaClient,
  args: {
    userId: string;
    now: Date;
    dayTrimp: number;
    refPersonal: number;
    anchor: StrainAnchor;
    trainingDays: number;
  },
): Promise<void> {
  const day = scoreDayKey(args.now);
  await prisma.strainTrimpCache.upsert({
    where: { userId_day: { userId: args.userId, day } },
    create: {
      userId: args.userId,
      day,
      dayTrimp: args.dayTrimp,
      refPersonal: args.refPersonal,
      anchor: args.anchor,
      trainingDays: args.trainingDays,
    },
    update: {
      dayTrimp: args.dayTrimp,
      refPersonal: args.refPersonal,
      anchor: args.anchor,
      trainingDays: args.trainingDays,
    },
  });
}

export interface PersistStrainResult {
  outcome: "stored" | "insufficient";
  score: number | null;
  reason: StrainComputeResult["reason"];
  /** v1.10.3 — which anchor produced the score (drives the honesty label). */
  anchor: StrainAnchor;
}

/**
 * Compute + persist one user's Strain score for the `now` day. Upserts on
 * the `(userId, type, source, externalId)` key (idempotent per user per
 * day). Writes NOTHING when the inputs gate.
 */
export async function persistStrainScore(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<PersistStrainResult> {
  const { profile, hrRest } = await loadStrainInputs(prisma, userId, now);
  const anchorHistory = await loadStrainAnchorHistory(prisma, userId, now);
  const result = await computeStrainScore(
    prisma,
    userId,
    profile,
    hrRest,
    now,
    anchorHistory,
  );
  const {
    score,
    reason,
    dayTrimp,
    anchor,
    trainingDays,
    refPersonalToPersist,
  } = result;

  if (score === null) {
    return { outcome: "insufficient", score: null, reason, anchor };
  }

  await upsertScoreRow(prisma, {
    userId,
    type: "STRAIN_SCORE",
    externalIdPrefix: STRAIN_SCORE_EXTERNAL_ID_PREFIX,
    score,
    now,
  });

  // Persist the day's TRIMP + the EWMA reference so the next night's chronic
  // window reads cheap cached values. Only the TRIMP path contributes a
  // training day; the active-energy fallback (dayTrimp === 0) still writes a
  // row so the cache reflects a non-training day, but it never counts toward
  // the personal distribution. `refPersonalToPersist` is null only when there
  // is no training history at all — fall back to the population reference for
  // the stored EWMA seed so the column stays non-null.
  await upsertStrainTrimpCache(prisma, {
    userId,
    now,
    dayTrimp,
    refPersonal: refPersonalToPersist ?? STRAIN_TRIMP_REFERENCE,
    anchor,
    trainingDays,
  });

  return { outcome: "stored", score, reason, anchor };
}
