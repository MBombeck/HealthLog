/**
 * Doctor-report pure helpers.
 *
 * The synchronous, DB-free functions behind the doctor-report aggregator:
 * window normalisation, canonical-source collapse, recovery summarisation,
 * ledger-based compliance tallying, and the export-surface sanitisers. Split
 * out of `doctor-report-data.ts` as pure code motion; that module re-exports
 * every public name here, so existing call sites keep importing from it
 * unchanged. The data shapes live in `doctor-report-types.ts`; the aggregator
 * itself stays in `doctor-report-data.ts`.
 */

import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { userDayKey } from "@/lib/tz/resolver";
import { resolveCanonicalRecovery } from "@/lib/insights/derived/recovery-resolve";
import {
  buildComplianceMedicationContext,
  expectsDoses,
  lastNonSkippedTakenAt,
  tallyComplianceFromLedger,
} from "@/lib/analytics/compliance";
import {
  WELLNESS_SCORE_REPORT_TYPES,
  type CanonicalCollapseRow,
  type DoctorReportCompliance,
  type DoctorReportComplianceIntake,
  type DoctorReportComplianceMedication,
  type DoctorReportRange,
  type DoctorReportStats,
} from "./doctor-report-types";

/**
 * Canonical adherence-rate rounding for the doctor-report export surfaces.
 *
 * The PDF table, the PDF clinical-summary headline, the FHIR adherence
 * Observation, and the GLP-1 block all derive the rate from the SAME ledger
 * denominator (`taken / total`, `total = taken + missed`). They MUST round it
 * the same way the app does so a clinician comparing the export to the in-app
 * card never sees a presentational divergence (87 % on the card, 87.3 % on the
 * PDF). The app convention is `round(100 · taken / denominator)` capped at 100
 * (see `dose-history-ledger-compute.ts` + `tallyComplianceFromLedger`) — an
 * integer percent. This is the one source of truth for every export surface.
 *
 * Returns `null` when `total <= 0` so callers render the "no expected dose"
 * placeholder instead of a misleading `0` or `100`.
 */
export function adherenceRatePercent(
  taken: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.round((taken / total) * 100));
}

/** One wellness-summary row (latest + range over the report window). */
interface WellnessScoreSummary {
  type: string;
  latest: number;
  avg: number;
  min: number;
  max: number;
  count: number;
  latestAt: string;
}

/** A measurement row as the doctor-report aggregator reads it (subset). */
interface RecoveryMeasurementRow {
  type: string;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
}

/**
 * Collapse a window's raw Measurement rows to one canonical source per metric
 * before the doctor report computes per-type avg/min/max. Without this the PDF
 * + FHIR stats blend every source (a WHOOP + Apple-Watch resting-heart-rate
 * day would average two readings), while the dashboard / insights aggregator
 * already collapse to the ladder-canonical source per day. This routes the rows
 * through the SAME picker (`pickCanonicalSourceRows`, keyed by
 * `metricKeyForType` + the user's day key + source-priority ladder), so the two
 * surfaces report identical numbers.
 *
 * SLEEP_DURATION is passed through untouched: it carries per-stage rows that
 * `reconstructSleepNights` resolves with its own source de-dup downstream, so a
 * pre-collapse here would drop stages the night reconstruction needs. A type
 * with no ladder, or a day with a single source, passes through unchanged via
 * the picker's documented fallback. Exported for unit tests.
 */
export function collapseMeasurementsToCanonical<T extends CanonicalCollapseRow>(
  measurements: readonly T[],
  timezone: string,
  sourcePriorityJson: unknown,
): T[] {
  const dayKey = (d: Date) => userDayKey(d, timezone);
  const byType = new Map<string, T[]>();
  for (const m of measurements) {
    const slot = byType.get(m.type);
    if (slot) slot.push(m);
    else byType.set(m.type, [m]);
  }
  const out: T[] = [];
  for (const [type, rows] of byType) {
    const metricKey =
      type === "SLEEP_DURATION"
        ? null
        : metricKeyForType(type as MeasurementType);
    if (!metricKey) {
      // Loop, not `push(...rows)` — a sample-dense type's window rows run to
      // six figures and a spread call overflows the stack (v1.28.22 class).
      for (const r of rows) out.push(r);
      continue;
    }
    const { canonicalRows } = pickCanonicalSourceRows(
      rows.map((m) => ({
        ...m,
        type: m.type as MeasurementType,
      })),
      metricKey,
      sourcePriorityJson,
      dayKey,
    );
    // `pickCanonicalSourceRows` returns the spread copies; re-key back to the
    // original rows by reference identity is unnecessary because the spread
    // preserves every field the caller reads (value / measuredAt / type).
    for (const r of canonicalRows as unknown as T[]) out.push(r);
  }
  return out;
}

/**
 * Loop-based min/max over a value array. NEVER `Math.min(...values)` here: the
 * report window's per-type rows are raw measurements, and a sample-dense type
 * (per-sample heart rate, CGM glucose) runs to six figures over a year — a
 * spread call overflows the stack exactly on the heaviest accounts (the same
 * failure class as the Google Health fullSync tracker, fixed v1.28.22).
 */
export function minMaxOf(values: readonly number[]): {
  min: number;
  max: number;
} {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Summarise RECOVERY_SCORE over the window from the CANONICAL row per day:
 * a WHOOP-native row wins over the COMPUTED proxy for the same day, so the
 * doctor PDF never blends the proxy and the native value into one min/avg/max.
 * Returns null when no recovery row exists. Exported for unit tests.
 */
export function summariseCanonicalRecovery(
  measurements: readonly RecoveryMeasurementRow[],
  timezone?: string | null,
): WellnessScoreSummary | null {
  const recovery = measurements.filter((m) => m.type === "RECOVERY_SCORE");
  if (recovery.length === 0) return null;
  const canonical = resolveCanonicalRecovery(
    recovery.map((m) => ({
      value: m.value,
      measuredAt: m.measuredAt,
      source: m.source,
    })),
    timezone,
  );
  if (canonical.length === 0) return null;
  // `resolveCanonicalRecovery` returns rows newest-first; the report wants the
  // latest value + the window range over the canonical set.
  const values = canonical.map((r) => r.value);
  const latestRow = canonical[0];
  return {
    type: "RECOVERY_SCORE",
    latest: Math.round(latestRow.value),
    avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    min: Math.round(minMaxOf(values).min),
    max: Math.round(minMaxOf(values).max),
    count: values.length,
    latestAt: latestRow.measuredAt.toISOString(),
  };
}

/**
 * The wellness summary of a report: one row per wellness score leaf the
 * report admits and holds readings for, from the same stats the measurement
 * table prints, so the two cannot disagree. RECOVERY_SCORE carries both the
 * native row and the computed proxy for one day; it resolves to the canonical
 * row so the PDF reads the SAME value the tile shows. Null when no row is
 * left.
 */
export function summariseWellnessScores(input: {
  admits: (type: (typeof WELLNESS_SCORE_REPORT_TYPES)[number]) => boolean;
  stats: Readonly<Record<string, DoctorReportStats>>;
  byType: Readonly<Record<string, ReadonlyArray<{ measuredAt: string }>>>;
  measurements: readonly RecoveryMeasurementRow[];
  timezone: string;
}): WellnessScoreSummary[] | null {
  const { admits, stats, byType, measurements, timezone } = input;
  const summaries = WELLNESS_SCORE_REPORT_TYPES.flatMap((type) => {
    if (!admits(type)) return [];
    if (type === "RECOVERY_SCORE") {
      const summary = summariseCanonicalRecovery(measurements, timezone);
      return summary ? [summary] : [];
    }
    const s = stats[type];
    const rows = byType[type];
    if (!s || !rows || rows.length === 0) return [];
    return [
      {
        type,
        latest: Math.round(s.latest),
        avg: Math.round(s.avg),
        min: Math.round(s.min),
        max: Math.round(s.max),
        count: s.count,
        latestAt: rows[rows.length - 1].measuredAt,
      },
    ];
  });
  return summaries.length > 0 ? summaries : null;
}

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

/**
 * Default ceiling on the number of `MedicationAdministration` source rows
 * materialised per export, and the bounds an operator override is clamped
 * to. The report window is already bounded at {@link MAX_RANGE_DAYS}
 * (730 days), but a chronic medication dosed several times a day across
 * that window — multiplied by several such medications — can still produce
 * thousands of administration resources in a single Bundle. The default of
 * 5 000 covers ~3.5 years at four doses a day, so it effectively never bites
 * on a realistic report period while still bounding a pathological export.
 */
const DEFAULT_MAX_MEDICATION_ADMINISTRATIONS = 5000;
const MIN_MEDICATION_ADMINISTRATIONS = 1;
const MAX_MEDICATION_ADMINISTRATIONS_CEILING = 50000;

/**
 * Resolve the administration ceiling from `FHIR_MAX_MEDICATION_ADMINISTRATIONS`.
 * Accepts a positive integer within `[1, 50000]`; any unset / non-integer /
 * out-of-range value falls back to the default. Exported as a pure function so
 * the resolution can be tested without import-time env coupling.
 */
export function resolveMaxMedicationAdministrations(
  raw: string | undefined,
): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) &&
    parsed >= MIN_MEDICATION_ADMINISTRATIONS &&
    parsed <= MAX_MEDICATION_ADMINISTRATIONS_CEILING
    ? parsed
    : DEFAULT_MAX_MEDICATION_ADMINISTRATIONS;
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
  const cleaned = value
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * v1.17 — doctor-report medication adherence through the dose-ledger
 * authority.
 *
 * The previous implementation tallied RAW intake rows: `taken = takenAt != null`,
 * else `skipped`, else `missed`, with the denominator being every row. That
 * double-counted cross-source duplicate rows (a REMINDER row + an API row for
 * the same slot both counted as taken), ignored band timing (a pre-window or
 * ad-hoc take counted as a plain "taken", a pending row counted as "missed"
 * regardless of the miss cutoff), and honoured no cadence (rolling / cyclic /
 * RRULE off-weeks could enter the tally). A clinician comparing the PDF % to
 * the app detail page could see two different adherence numbers for one drug.
 *
 * Route the report through the SAME ledger the detail page uses: per
 * medication, mint the cadence-aware bands over the report window
 * `[start, end]` and tally `taken` (on-time + late), `missed` and `skipped`
 * from the unified dose-history ledger. `total = taken + missed` so the
 * renderers' `taken / total` rate equals the ledger rate the detail page
 * shows. PRN / as-needed medications are excluded exactly as before (no
 * schedule, no expected dose — a fabricated 100 % on a clinical report).
 *
 * Pure / synchronous — bands come from pre-fetched schedules + intake
 * instants. Keyed by medication id: two medications can share a name, and
 * a name key let the second overwrite the first. The name rides in the value.
 */
export function buildLedgerCompliance(
  medications: DoctorReportComplianceMedication[],
  intakeEvents: DoctorReportComplianceIntake[],
  userTz: string,
  start: Date,
  end: Date,
  now: Date,
): Record<string, DoctorReportCompliance> {
  const eventsByMedId = new Map<string, DoctorReportComplianceIntake[]>();
  for (const event of intakeEvents) {
    const list = eventsByMedId.get(event.medicationId);
    if (list) list.push(event);
    else eventsByMedId.set(event.medicationId, [event]);
  }

  const compliance: Record<string, DoctorReportCompliance> = {};
  for (const med of medications) {
    // PRN / as-needed carry no schedule and no expected dose — excluded so
    // the report never prints a fabricated 100 %. Both arms now live in the
    // shared predicate, which is what the other adherence surfaces read.
    if (!expectsDoses(med)) continue;

    const events = eventsByMedId.get(med.id) ?? [];
    const ctx = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(events),
      userTz,
    );
    const tally = tallyComplianceFromLedger(
      events,
      med.schedules,
      ctx,
      start,
      end,
      now,
    );
    // `total = taken + missed` (the ledger denominator) so the renderer's
    // `taken / total` equals `tally.rate` — the exact number the detail page
    // shows. Deliberate skips are reported separately but stay out of `total`.
    compliance[med.id] = {
      name: med.name,
      total: tally.denominator,
      taken: tally.taken,
      skipped: tally.skipped,
      missed: tally.missed,
    };
  }
  return compliance;
}

/**
 * Decrypt an allergy reaction envelope for a clinician-facing export, keeping
 * "unreadable" distinct from "unset". A genuinely-empty envelope yields
 * `{ reaction: null, reactionUnreadable: false }`; a stored-but-undecryptable
 * one (key-rotation gap / GCM corruption) yields
 * `{ reaction: null, reactionUnreadable: true }` so the report can render an
 * honest marker instead of a blank that reads as "no reaction recorded". Pure
 * (no logging) so it is unit-testable; the caller logs on the unreadable flag.
 */
export function decryptAllergyReaction(reactionEncrypted: Uint8Array | null): {
  reaction: string | null;
  reactionUnreadable: boolean;
} {
  if (!reactionEncrypted || reactionEncrypted.byteLength === 0) {
    return { reaction: null, reactionUnreadable: false };
  }
  try {
    return {
      reaction: decryptFromBytes(reactionEncrypted),
      reactionUnreadable: false,
    };
  } catch {
    return { reaction: null, reactionUnreadable: true };
  }
}
