/**
 * v1.25 — "what changed since your last panel" shaping.
 *
 * Groups the user's numeric lab results by panel DATE (the calendar day of
 * `takenAt`, UTC), finds the two most-recent dates, and for every analyte that
 * appears in BOTH the latest and the previous panel reports the signed delta,
 * the direction, and where the latest value sits against the reference window
 * in force for it — the range that reading's own report printed when it has
 * one, the catalog band otherwise, resolved through the shared
 * `resolveEffectiveReferenceRange`. Qualitative (valueText-only) results carry
 * no numeric value, so they are skipped — a delta is meaningless for them.
 *
 * Pure + Prisma-free so the present / absent states are unit-testable: it is
 * absent when there are fewer than two panel dates, no analyte is shared, or
 * the newest panel is older than `LAB_CHANGE_RECENCY_DAYS`. Neutral framing
 * only — a delta is not a diagnosis.
 */
import { recordedPrecision } from "@/lib/format/recorded-number";
import {
  classifyAgainstEffectiveRange,
  resolveEffectiveReferenceRange,
  type ReferenceRangeStatus,
  type SourceReferenceRange,
} from "@/lib/labs/reference-range";

/** A single numeric lab reading, with both windows it could be judged against. */
export interface LabChangeRow extends SourceReferenceRange {
  analyte: string;
  /**
   * The marker the reading is filed under. Two reports print the same marker
   * under different names ("HbA1c", "Glykiertes Hämoglobin"); the marker is
   * what pairs them. A reading without one pairs by its printed name.
   */
  biomarkerId?: string | null;
  unit: string;
  value: number;
  /**
   * The figure the source report printed when `value` was converted from
   * another unit; it sets the precision the converted value is read at.
   */
  sourceValue?: number | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  takenAt: Date;
}

export interface LabChange {
  analyte: string;
  unit: string;
  /** The readings at the precision they were recorded at (`recordedPrecision`). */
  latest: number;
  previous: number;
  /**
   * Signed latest − previous, at the finer of the two readings' precisions,
   * so TSH 0.004 → 0.009 is +0.005 and not a rounded-away 0.
   */
  delta: number;
  direction: "up" | "down" | "flat";
  status: ReferenceRangeStatus;
}

export interface LabChangesSummary {
  present: boolean;
  /** YYYY-MM-DD of the most-recent panel, or null when absent. */
  latestDate: string | null;
  /** YYYY-MM-DD of the prior panel, or null when absent. */
  previousDate: string | null;
  changes: LabChange[];
}

/**
 * How long the comparison keeps calling itself "since your last panel".
 *
 * The card's whole claim is time-bound: a delta between the two newest panels
 * is news for a while, and then it is simply history the labs page already
 * holds. Someone whose newest panel is years old was still being shown "what
 * changed since your last panel", which is not a stale piece of UI state — it
 * is a stale STATEMENT.
 *
 * A year, and not less, because routine panels are commonly drawn annually. A
 * shorter window would hide a comparison that is genuinely the newest thing
 * the person has for months of every year. Past a year the wording cannot be
 * defended at all, so the comparison stops being surfaced rather than being
 * re-worded into something nobody asked for.
 *
 * Expressed on the DATA, not per user: nothing to acknowledge, nothing to
 * persist, no housekeeping asked of anyone, and every client — web and iOS —
 * reads the same answer through the existing `present: false` contract.
 */
export const LAB_CHANGE_RECENCY_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ABSENT: LabChangesSummary = {
  present: false,
  latestDate: null,
  previousDate: null,
  changes: [],
};

/** UTC calendar-day key (YYYY-MM-DD) for a sample instant. */
function dayKey(d: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: groups draws by UTC day; this summariser has no zone yet (labReadingDay is the target)
  return d.toISOString().slice(0, 10);
}

/**
 * Cross-panel matching key: the marker when the reading is filed under one,
 * else the normalised printed name (free-text tolerant).
 */
function analyteKey(row: LabChangeRow): string {
  return row.biomarkerId
    ? `marker:${row.biomarkerId}`
    : `name:${row.analyte.trim().toLowerCase()}`;
}

function sameUnit(a: LabChangeRow, b: LabChangeRow): boolean {
  return a.unit.trim().toLowerCase() === b.unit.trim().toLowerCase();
}

/**
 * Summarise the change between the two most-recent numeric lab panels. `rows`
 * should already be the user's live (non-deleted) numeric results; this helper
 * does the grouping + pairing.
 */
export function summariseLabChanges(
  rows: readonly LabChangeRow[],
  now: Date = new Date(),
): LabChangesSummary {
  const numeric = rows.filter((r) => Number.isFinite(r.value));
  if (numeric.length === 0) return ABSENT;

  // Group by panel day, keeping the latest reading per analyte within a day.
  const byDay = new Map<string, Map<string, LabChangeRow>>();
  for (const row of numeric) {
    const day = dayKey(row.takenAt);
    let analytes = byDay.get(day);
    if (!analytes) {
      analytes = new Map();
      byDay.set(day, analytes);
    }
    const key = analyteKey(row);
    const existing = analytes.get(key);
    if (!existing || row.takenAt.getTime() >= existing.takenAt.getTime()) {
      analytes.set(key, row);
    }
  }

  const days = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (days.length < 2) return ABSENT;

  const latestDate = days[0];
  const previousDate = days[1];
  const latest = byDay.get(latestDate)!;
  const previous = byDay.get(previousDate)!;

  // Read the freshness off the newest actual sample instant in that panel, not
  // off the day key: the key is a UTC calendar day and re-parsing it would put
  // the boundary a few hours out for anyone east or west of UTC.
  const newestSampleAt = Math.max(
    ...[...latest.values()].map((r) => r.takenAt.getTime()),
  );
  if (now.getTime() - newestSampleAt > LAB_CHANGE_RECENCY_DAYS * MS_PER_DAY) {
    return ABSENT;
  }

  const changes: LabChange[] = [];
  for (const [key, latestRow] of latest) {
    const previousRow = previous.get(key);
    // A delta across two units is no change, it is a conversion; skip it.
    if (!previousRow || !sameUnit(latestRow, previousRow)) continue;
    // Each reading at the digits it was recorded with; the delta at the
    // finer of the two, so it says what the printed figures say.
    const latestReading = recordedPrecision(
      latestRow.value,
      latestRow.sourceValue,
    );
    const previousReading = recordedPrecision(
      previousRow.value,
      previousRow.sourceValue,
    );
    const digits = Math.max(
      latestReading.fractionDigits,
      previousReading.fractionDigits,
    );
    const delta = Number(
      (latestReading.value - previousReading.value).toFixed(digits),
    );
    const direction: LabChange["direction"] =
      delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    changes.push({
      analyte: latestRow.analyte,
      unit: latestRow.unit,
      latest: latestReading.value,
      previous: previousReading.value,
      delta,
      direction,
      status: classifyAgainstEffectiveRange(
        latestRow.value,
        resolveEffectiveReferenceRange(
          latestRow.referenceLow,
          latestRow.referenceHigh,
          latestRow,
        ),
      ),
    });
  }

  if (changes.length === 0) return ABSENT;

  changes.sort((a, b) => a.analyte.localeCompare(b.analyte));

  return { present: true, latestDate, previousDate, changes };
}
