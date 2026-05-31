/**
 * Server-side aggregator for doctor-report data.
 *
 * Single source of truth for the aggregated payload consumed by both
 * `/api/doctor-report` (JSON, client renders PDF) and
 * `/api/doctor-report/pdf` (server-rendered PDF). Keeps the two endpoints
 * structurally identical so visual parity between client- and server-rendered
 * PDFs is guaranteed by construction, not by drift-prone copy-paste.
 */

import { prisma } from "@/lib/db";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import {
  resolveGlucoseUnit,
  thresholdMetricForContext,
  type GlucoseUnit,
} from "@/lib/glucose";
import type { GlucoseContext } from "@/generated/prisma/client";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";

export interface DoctorReportStats {
  avg: number;
  min: number;
  max: number;
  count: number;
  latest: number;
}

export interface DoctorReportCompliance {
  total: number;
  taken: number;
  skipped: number;
  missed: number;
}

export interface DoctorReportMood {
  avg: number;
  min: number;
  max: number;
  count: number;
  distribution: Record<number, number>;
}

export interface DoctorReportData {
  /**
   * Reporting period bounds. `start` and `end` are ISO timestamps; `days` is
   * the inclusive day-count between the two (rounded up) so existing callers
   * that displayed "last N days" continue to work without a UI rewrite.
   */
  period: { days: number; since: string; start: string; end: string };
  patient: {
    username: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    heightCm: number | null;
    // v1.7.0 — optional patient-identity fields for the export cover +
    // FHIR Patient. `fullName` + `insurerName` are plaintext columns; the
    // KVNR is NOT carried here (it's encrypted at rest and decrypted by
    // the route, then handed to the builders separately). Optional in the
    // type so pre-v1.7.0 fixtures that omit them still typecheck — the
    // renderer treats absent and null identically.
    fullName?: string | null;
    insurerName?: string | null;
  };
  /**
   * Free-text practice / clinic name printed on the cover. `null` omits the
   * line entirely. Persisted as a user preference (see
   * `User.lastReportPracticeName`).
   */
  practiceName: string | null;
  measurements: Record<string, Array<{ value: number; measuredAt: string }>>;
  stats: Record<string, DoctorReportStats>;
  glucoseStats: Record<string, DoctorReportStats>;
  glucoseRanges: Record<string, { min: number; max: number }>;
  glucoseUnit: GlucoseUnit;
  bmi: number | null;
  compliance: Record<string, DoctorReportCompliance>;
  medications: Array<{
    name: string;
    dose: string;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string | null;
    }>;
  }>;
  mood: DoctorReportMood | null;
  /**
   * v1.4.25 W4d — GLP-1 therapy section. Populated when the user has at
   * least one active GLP-1 medication. Null/absent when the user has no
   * GLP-1 prescription (the vast majority of accounts). When set the
   * PDF gains a "GLP-1 Therapy" section listing dose history, weight
   * change over the therapy window, side-effect counts, and compliance.
   * Optional in the type so legacy callers + test fixtures that omit
   * the field continue to work; the renderer treats absent and null
   * identically.
   */
  glp1?: {
    medications: Array<{
      name: string;
      currentDose: { value: number; unit: string; since: string } | null;
      doseHistory: Array<{
        value: number;
        unit: string;
        effectiveFrom: string;
        note: string | null;
      }>;
      lastInjection: { date: string; site: string | null } | null;
      compliance: { taken: number; total: number };
    }>;
    weightDeltaKg: number | null;
    weightStartKg: number | null;
    weightEndKg: number | null;
    sideEffects: Array<{ tag: string; count: number }>;
  } | null;
}

const GLUCOSE_CONTEXTS: GlucoseContext[] = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
];

/**
 * Validate and normalise the requested reporting window.
 * Accepts an unknown value (typically `body.days`); falls back to 90.
 */
export function normaliseDays(value: unknown, fallback = 90): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 365
  ) {
    return value;
  }
  return fallback;
}

const MIN_RANGE_DAYS = 1;
/**
 * Maximum span between `startDate` and `endDate`. Two years balances the
 * "give me everything I have" case (chronic condition follow-up) against
 * unbounded server work; the existing `days` fallback is capped at 365 so a
 * caller asking for a 730-day window must come through the explicit-range
 * surface and proves they want it.
 */
const MAX_RANGE_DAYS = 730;
const DEFAULT_RANGE_DAYS = 90;

export interface DoctorReportRange {
  /** Start of the reporting window (UTC, inclusive). */
  start: Date;
  /** End of the reporting window (UTC, inclusive). */
  end: Date;
  /** Inclusive day-count between `start` and `end` (rounded up). */
  days: number;
}

/** Hard cap on the printed cover line — protects PDF layout from runaway input. */
const PRACTICE_NAME_MAX_LENGTH = 120;

/**
 * Trim, collapse whitespace, drop control characters, and length-cap a
 * caller-provided practice name. Returns `null` if the result is empty so
 * the cover line is omitted entirely (rather than rendering a blank label).
 */
export function sanitisePracticeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Strip ASCII C0 + DEL controls (0x00..0x1F + 0x7F) which jsPDF can't
  // render and which break PDF text streams. Then collapse whitespace + trim.
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, PRACTICE_NAME_MAX_LENGTH);
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Turn an arbitrary `{ startDate?, endDate?, days? }` payload into a validated
 * inclusive reporting window.
 *
 * Resolution order:
 *  1. Both `startDate` AND `endDate` parse as valid ISO timestamps with
 *     `endDate >= startDate` and span <= 730 days → use them.
 *  2. Neither/invalid range, but a valid `days` integer (1..365) is provided
 *     → fall back to "last `days` days ending now".
 *  3. Otherwise fall back to "last 90 days ending now" (the v1.4.14 default).
 *
 * The function is intentionally tolerant: invalid input never throws — bad
 * shapes silently fall through to the next tier so a malformed request
 * still produces a useful report rather than a 422.
 */
export function normaliseDateRange(
  value: unknown,
  now: Date = new Date(),
): DoctorReportRange {
  const body =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const startCandidate = parseIsoDate(body.startDate);
  const endCandidate = parseIsoDate(body.endDate);

  if (startCandidate && endCandidate) {
    const startMs = startCandidate.getTime();
    const endMs = endCandidate.getTime();
    if (endMs >= startMs) {
      const spanMs = endMs - startMs;
      const spanDays = Math.ceil(spanMs / 86_400_000) || 1;
      if (spanDays >= MIN_RANGE_DAYS && spanDays <= MAX_RANGE_DAYS) {
        return {
          start: startCandidate,
          end: endCandidate,
          days: spanDays,
        };
      }
    }
  }

  const days = normaliseDays(body.days, DEFAULT_RANGE_DAYS);
  const end = now;
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { start, end, days };
}

export interface CollectDoctorReportOptions {
  /** Free-text practice/clinic name to print on the cover. Optional. */
  practiceName?: string | null;
  /**
   * v1.4.25 W6c — per-section visibility toggles. When omitted the
   * documented defaults apply (every section ON except mood). When
   * `sections.mood = false` the aggregator does NOT query
   * `MoodEntry` at all — the mood data never leaves the DB row
   * (privacy-by-default). Other sections are stripped from the
   * returned payload so downstream renderers (PDF + JSON consumer)
   * don't accidentally print a section the user opted out of.
   */
  sections?: Partial<DoctorReportPrefs>;
}

/**
 * Aggregate the doctor-report payload for a user over a `[start, end]` range.
 * Pure data assembly — no auth, no rate-limit, no audit. Idempotent.
 *
 * `range` is validated via `normaliseDateRange()` upstream; this function
 * trusts it and uses both bounds in the Prisma `where` clause so a custom
 * window (not just "last N days") filters correctly.
 */
export async function collectDoctorReportData(
  userId: string,
  range: DoctorReportRange,
  options: CollectDoctorReportOptions = {},
): Promise<DoctorReportData> {
  const { start, end, days } = range;

  // Resolve section toggles up-front. Mood is privacy-sensitive: when
  // it's off we don't issue the `MoodEntry` findMany at all so the data
  // never lands in this process's memory. Other sections are queried
  // either way (the queries are cheap on indexed columns) and stripped
  // from the returned payload below — keeping a single source of
  // truth for the data shape regardless of toggle state.
  const sections: DoctorReportPrefs = {
    ...DEFAULT_DOCTOR_REPORT_PREFS,
    ...(options.sections ?? {}),
  };

  const [measurements, medications, intakeEvents, moodEntries, userProfile] =
    await Promise.all([
      prisma.measurement.findMany({
        // v1.4.41 W-DELETED-2 — exclude soft-deleted measurements from
        // the doctor-report aggregator so deleted rows never leak into
        // the JSON payload or the server-rendered PDF.
        where: { userId, measuredAt: { gte: start, lte: end }, deletedAt: null },
        orderBy: { measuredAt: "asc" },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        include: {
          schedules: true,
          // v1.4.25 W4d — eager-load dose history + recent intake site
          // for any active medication. Generic meds carry empty arrays
          // so the legacy data path is byte-identical.
          doseChanges: { orderBy: { effectiveFrom: "asc" } },
          intakeEvents: {
            where: { takenAt: { not: null } },
            orderBy: { takenAt: "desc" },
            take: 1,
            select: { takenAt: true, injectionSite: true },
          },
        },
      }),
      prisma.medicationIntakeEvent.findMany({
        // v1.7.0 sync — exclude tombstoned rows from the doctor report.
        where: { userId, deletedAt: null, scheduledFor: { gte: start, lte: end } },
        include: { medication: { select: { name: true } } },
        orderBy: { scheduledFor: "asc" },
      }),
      // Mood data: zero DB read when the user opted out. This is the
      // privacy-by-default contract — the JSON payload + audit log
      // both reflect "mood was never fetched", not "mood was fetched
      // and then dropped".
      sections.mood
        ? prisma.moodEntry.findMany({
            // v1.7.0 sync — exclude tombstoned rows from the doctor report.
            where: { userId, deletedAt: null, moodLoggedAt: { gte: start, lte: end } },
            orderBy: { moodLoggedAt: "asc" },
          })
        : Promise.resolve([]),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          dateOfBirth: true,
          gender: true,
          heightCm: true,
          glucoseUnit: true,
          thresholdsJson: true,
          // v1.7.0 — patient-identity fields for the export cover + FHIR
          // Patient. KVNR is encrypted (and not selected here) — the route
          // decrypts it and hands it to the builders.
          fullName: true,
          insurerName: true,
        },
      }),
    ]);

  // Group measurements by type.
  const byType: Record<
    string,
    Array<{ value: number; measuredAt: string }>
  > = {};
  for (const m of measurements) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push({
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    });
  }

  // Per-type stats.
  const stats: Record<string, DoctorReportStats> = {};
  for (const [type, entries] of Object.entries(byType)) {
    const values = entries.map((e) => e.value);
    stats[type] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      latest: values[values.length - 1],
    };
  }

  // Medication compliance.
  const compliance: Record<string, DoctorReportCompliance> = {};
  for (const event of intakeEvents) {
    const name = event.medication.name;
    if (!compliance[name]) {
      compliance[name] = { total: 0, taken: 0, skipped: 0, missed: 0 };
    }
    compliance[name].total++;
    if (event.takenAt) {
      compliance[name].taken++;
    } else if (event.skipped) {
      compliance[name].skipped++;
    } else {
      compliance[name].missed++;
    }
  }

  // Mood summary.
  const moodScores = moodEntries.map((e) => e.score);
  const mood: DoctorReportMood | null =
    moodScores.length > 0
      ? {
          avg: moodScores.reduce((a, b) => a + b, 0) / moodScores.length,
          min: Math.min(...moodScores),
          max: Math.max(...moodScores),
          count: moodScores.length,
          distribution: {
            1: moodScores.filter((s) => s === 1).length,
            2: moodScores.filter((s) => s === 2).length,
            3: moodScores.filter((s) => s === 3).length,
            4: moodScores.filter((s) => s === 4).length,
            5: moodScores.filter((s) => s === 5).length,
          },
        }
      : null;

  // BMI from latest weight + profile height.
  const weightStats = stats.WEIGHT;
  const bmiRaw =
    weightStats && userProfile?.heightCm
      ? weightStats.latest / (userProfile.heightCm / 100) ** 2
      : null;
  const bmi = bmiRaw !== null ? Math.round(bmiRaw * 10) / 10 : null;

  // Per-context glucose stats + effective ranges (canonical mg/dL).
  const glucoseStats: Record<string, DoctorReportStats> = {};
  const glucoseRanges: Record<string, { min: number; max: number }> = {};
  const glucoseRows = measurements.filter((m) => m.type === "BLOOD_GLUCOSE");
  const overrides = (userProfile?.thresholdsJson ??
    null) as ThresholdOverridesJson | null;
  const profileForRange = {
    heightCm: userProfile?.heightCm ?? null,
    dateOfBirth: userProfile?.dateOfBirth ?? null,
    gender: userProfile?.gender ?? null,
  };
  for (const ctx of GLUCOSE_CONTEXTS) {
    const rows = glucoseRows.filter((m) => m.glucoseContext === ctx);
    if (rows.length === 0) continue;
    const values = rows.map((r) => r.value);
    glucoseStats[ctx] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      latest: values[values.length - 1],
    };
    const eff = getEffectiveRange(
      thresholdMetricForContext(ctx),
      profileForRange,
      overrides,
    );
    if (eff.range) {
      glucoseRanges[ctx] = { min: eff.range.greenMin, max: eff.range.greenMax };
    }
  }

  // `practiceName` is sanitised to a single-line string with a hard length
  // cap. The PDF cover prints it verbatim — never let unbounded input land in
  // a layout-sensitive header.
  const practiceName = sanitisePracticeName(options.practiceName);

  // Apply section toggles. Removing the type's keys from `byType`,
  // `stats`, and `compliance` lets the PDF renderer treat "section
  // disabled" identically to "section had no rows" — both paths skip
  // the table. Mood is already null when disabled (we never queried).
  const filteredByType = filterMeasurementKeys(byType, sections);
  const filteredStats = filterMeasurementKeys(stats, sections);
  const filteredCompliance = sections.compliance ? compliance : {};
  const filteredBmi = sections.bmi ? bmi : null;

  // v1.4.25 W4d — GLP-1 therapy section. Only assembled when the user
  // has at least one active GLP-1 medication AND the compliance toggle
  // is on (per the privacy contract: a doctor-report dose history needs
  // the compliance section enabled to be useful). Generic accounts
  // get `glp1: null` which the PDF renderer skips entirely.
  const glp1Meds = medications.filter((m) => m.treatmentClass === "GLP1");
  let glp1: DoctorReportData["glp1"] = null;
  if (sections.compliance && glp1Meds.length > 0) {
    const weightSorted = (byType.WEIGHT ?? []).slice();
    const weightStartKg = weightSorted[0]?.value ?? null;
    const weightEndKg = weightSorted[weightSorted.length - 1]?.value ?? null;
    const weightDeltaKg =
      weightStartKg !== null && weightEndKg !== null
        ? Math.round((weightEndKg - weightStartKg) * 10) / 10
        : null;

    // Side-effect tag counts (only when mood section is enabled — we
    // already gated the moodEntries read on `sections.mood`, so this
    // collapses to "no tags" when the user opted out).
    const sideEffectTags = new Set([
      "nausea",
      "constipation",
      "diarrhea",
      "fatigue",
      "appetite-loss",
      "heartburn",
      "headache",
      "übelkeit",
      "verstopfung",
      "durchfall",
      "müdigkeit",
      "appetitlosigkeit",
      "sodbrennen",
      "kopfschmerzen",
    ]);
    const sideEffectCounts = new Map<string, number>();
    for (const mood of moodEntries) {
      const rawTags = mood.tags ?? "";
      let tags: string[];
      try {
        const parsed = JSON.parse(rawTags);
        tags = Array.isArray(parsed)
          ? parsed
              .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
              .filter(Boolean)
          : [];
      } catch {
        tags = rawTags
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
      }
      for (const tag of tags) {
        const lower = tag.toLowerCase();
        if (!sideEffectTags.has(lower)) continue;
        sideEffectCounts.set(lower, (sideEffectCounts.get(lower) ?? 0) + 1);
      }
    }

    glp1 = {
      medications: glp1Meds.map((m) => {
        const latest = m.doseChanges[m.doseChanges.length - 1] ?? null;
        const lastIntake = m.intakeEvents[0] ?? null;
        const comp = compliance[m.name] ?? {
          taken: 0,
          total: 0,
          skipped: 0,
          missed: 0,
        };
        return {
          name: m.name,
          currentDose: latest
            ? {
                value: latest.doseValue,
                unit: latest.doseUnit,
                since: latest.effectiveFrom.toISOString(),
              }
            : null,
          doseHistory: m.doseChanges.map((dc) => ({
            value: dc.doseValue,
            unit: dc.doseUnit,
            effectiveFrom: dc.effectiveFrom.toISOString(),
            note: dc.note,
          })),
          lastInjection:
            lastIntake && lastIntake.takenAt
              ? {
                  date: lastIntake.takenAt.toISOString(),
                  site: lastIntake.injectionSite,
                }
              : null,
          compliance: { taken: comp.taken, total: comp.total },
        };
      }),
      weightStartKg,
      weightEndKg,
      weightDeltaKg,
      sideEffects: Array.from(sideEffectCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count })),
    };
  }

  return {
    period: {
      days,
      // `since` is preserved for backwards compatibility with any in-flight
      // clients that read the old field name; mirrors `start`.
      since: start.toISOString(),
      start: start.toISOString(),
      end: end.toISOString(),
    },
    patient: {
      username: userProfile?.username ?? null,
      dateOfBirth: userProfile?.dateOfBirth
        ? userProfile.dateOfBirth.toISOString()
        : null,
      gender: userProfile?.gender ?? null,
      heightCm: userProfile?.heightCm ?? null,
      fullName: userProfile?.fullName ?? null,
      insurerName: userProfile?.insurerName ?? null,
    },
    practiceName,
    measurements: filteredByType,
    stats: filteredStats,
    glucoseStats,
    glucoseRanges,
    glucoseUnit: resolveGlucoseUnit(userProfile?.glucoseUnit ?? null),
    bmi: filteredBmi,
    compliance: filteredCompliance,
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
      })),
    })),
    mood,
    glp1,
  };
}

/**
 * Per-measurement-type → section-toggle mapping. Keys not listed here
 * (e.g., glucose contexts, body fat, oxygen saturation) bypass the
 * toggles for now — those sections will get their own flags in a
 * future iteration. The current scope per Marc's directive is the
 * "big five" plus mood + compliance.
 */
const MEASUREMENT_TYPE_SECTION: Record<string, keyof DoctorReportPrefs> = {
  BLOOD_PRESSURE_SYS: "bp",
  BLOOD_PRESSURE_DIA: "bp",
  WEIGHT: "weight",
  PULSE: "pulse",
  SLEEP_DURATION: "sleep",
};

function filterMeasurementKeys<T>(
  map: Record<string, T>,
  sections: DoctorReportPrefs,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [type, value] of Object.entries(map)) {
    const sectionKey = MEASUREMENT_TYPE_SECTION[type];
    if (sectionKey && sections[sectionKey] === false) continue;
    out[type] = value;
  }
  return out;
}
