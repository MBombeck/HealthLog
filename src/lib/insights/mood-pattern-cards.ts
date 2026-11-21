/**
 * Mood patterns the server finds and publishes (v1.43, ios #116 item 6).
 *
 * The native client used to compute six pattern cards itself (the day after
 * a low day, weekends, the best weekday, days with a note, delayed tag
 * effects, several entries a day) on the device calendar and without any
 * statistical gate, and removed them. They are computed here instead, on the
 * account's mood day (`MoodEntry.date`, anchored to the entry's own zone),
 * and only the ones that pass the gate are published:
 *
 *   - at least `PATTERN_MIN_DAYS_PER_SIDE` days on each side of a comparison;
 *   - a Welch two-sample t-test on the two groups of daily means (the same
 *     test the tag influence board uses);
 *   - Benjamini-Hochberg over every comparison tested in the window, kept at
 *     q ≤ `PATTERN_FDR_Q` (the false discovery rate the mood crosstabs use).
 *
 * An empty list means nothing passed, not that something failed. Every
 * comparison is a daily-mean comparison, so a day with five entries weighs
 * as much as a day with one. Observational only: the copy a client renders
 * says "tends to", never "because".
 *
 * Pure; the caller hands over the entries and which days carry a note.
 */
import { welchTTest } from "@/lib/insights/correlations";
import { benjaminiHochberg } from "@/lib/insights/correlation-discovery";
import type {
  MoodAggregateEntry,
  StructuredTagRef,
} from "@/lib/insights/mood-aggregates";
import { round } from "@/lib/insights/status-shared";
import { shiftDateKey } from "@/lib/tz/format";
import { mean, median } from "@/lib/stats/central";

export const PATTERN_MIN_DAYS_PER_SIDE = 8;
export const PATTERN_FDR_Q = 0.1;

export type MoodPatternKind =
  | "previous_day"
  | "weekend"
  | "best_weekday"
  | "notes"
  | "delayed_tag"
  | "multiple_entries";

/** A pattern as the aggregate caches it: the tag's label is resolved at the wire. */
export interface MoodPatternFinding {
  id: string;
  kind: MoodPatternKind;
  strength: "weak" | "moderate" | "strong";
  direction: "higher" | "lower" | "none";
  values: {
    subject: number;
    comparison: number;
    delta: number;
    weekday?: number;
    tagKey?: string;
  };
  sampleSize: { subject: number; comparison: number };
  /** For `delayed_tag`: how to name the tag (custom label first). */
  tag?: { labelKey: string; label: string | null };
  /** BH-adjusted q, kept for ordering and tests; not on the wire. */
  qValue: number;
}

/** The wire shape (`MoodPattern` in OpenAPI). */
export interface MoodPatternWire {
  id: string;
  kind: MoodPatternKind;
  strength: "weak" | "moderate" | "strong";
  direction: "higher" | "lower" | "none";
  values: {
    subject: number;
    comparison: number;
    delta: number;
    weekday?: number;
    tagKey?: string;
    tagLabel?: string;
  };
  sampleSize: { subject: number; comparison: number };
}

interface MoodDay {
  date: string;
  mean: number;
  entries: number;
  hasNote: boolean;
  tags: Map<string, StructuredTagRef>;
}

interface Candidate {
  id: string;
  kind: MoodPatternKind;
  subject: number[];
  comparison: number[];
  weekday?: number;
  tag?: StructuredTagRef;
}

/** 0 = Monday … 6 = Sunday, read off the day key itself. */
export function weekdayOfKey(dateKey: string): number {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

function collapseDays(
  entries: readonly MoodAggregateEntry[],
  noteDays: ReadonlySet<string>,
): Map<string, MoodDay> {
  const days = new Map<
    string,
    { sum: number; count: number; tags: Map<string, StructuredTagRef> }
  >();
  for (const entry of entries) {
    const day = days.get(entry.date) ?? {
      sum: 0,
      count: 0,
      tags: new Map<string, StructuredTagRef>(),
    };
    day.sum += entry.score;
    day.count += 1;
    for (const ref of entry.structuredTags ?? []) day.tags.set(ref.key, ref);
    days.set(entry.date, day);
  }
  const out = new Map<string, MoodDay>();
  for (const [date, day] of days) {
    out.set(date, {
      date,
      mean: day.sum / day.count,
      entries: day.count,
      hasNote: noteDays.has(date),
      tags: day.tags,
    });
  }
  return out;
}

/** Cohen's d on the pooled SD, banded at the conventional 0.5 / 0.8. */
function strengthOf(
  subject: readonly number[],
  comparison: readonly number[],
): MoodPatternFinding["strength"] {
  const ms = mean(subject);
  const mc = mean(comparison);
  if (ms === null || mc === null) return "weak";
  const vs =
    subject.reduce((s, v) => s + (v - ms) ** 2, 0) / (subject.length - 1);
  const vc =
    comparison.reduce((s, v) => s + (v - mc) ** 2, 0) / (comparison.length - 1);
  const pooled =
    ((subject.length - 1) * vs + (comparison.length - 1) * vc) /
    (subject.length + comparison.length - 2);
  const d = pooled > 0 ? Math.abs(ms - mc) / Math.sqrt(pooled) : 0;
  if (d >= 0.8) return "strong";
  if (d >= 0.5) return "moderate";
  return "weak";
}

function candidates(days: Map<string, MoodDay>): Candidate[] {
  const list = [...days.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const out: Candidate[] = [];

  // The day after a day below the person's own median, against the day after
  // one above it. Days on the median itself belong to neither side.
  const med = median(list.map((d) => d.mean)) ?? 0;
  const afterLow: number[] = [];
  const afterHigh: number[] = [];
  for (const day of list) {
    const prev = days.get(shiftDateKey(day.date, -1));
    if (!prev) continue;
    if (prev.mean < med) afterLow.push(day.mean);
    else if (prev.mean > med) afterHigh.push(day.mean);
  }
  out.push({
    id: "previous_day",
    kind: "previous_day",
    subject: afterLow,
    comparison: afterHigh,
  });

  // Saturday and Sunday against Monday to Friday.
  out.push({
    id: "weekend",
    kind: "weekend",
    subject: list.filter((d) => weekdayOfKey(d.date) >= 5).map((d) => d.mean),
    comparison: list.filter((d) => weekdayOfKey(d.date) < 5).map((d) => d.mean),
  });

  // Each weekday against the rest. All seven are tested so the selection of
  // the best one is paid for in the false discovery control; only the best
  // can be published.
  for (let weekday = 0; weekday < 7; weekday += 1) {
    out.push({
      id: `weekday:${weekday}`,
      kind: "best_weekday",
      weekday,
      subject: list
        .filter((d) => weekdayOfKey(d.date) === weekday)
        .map((d) => d.mean),
      comparison: list
        .filter((d) => weekdayOfKey(d.date) !== weekday)
        .map((d) => d.mean),
    });
  }

  out.push({
    id: "notes",
    kind: "notes",
    subject: list.filter((d) => d.hasNote).map((d) => d.mean),
    comparison: list.filter((d) => !d.hasNote).map((d) => d.mean),
  });

  out.push({
    id: "multiple_entries",
    kind: "multiple_entries",
    subject: list.filter((d) => d.entries >= 2).map((d) => d.mean),
    comparison: list.filter((d) => d.entries === 1).map((d) => d.mean),
  });

  // A tag's association with the NEXT day's mood: the day after a tagged day
  // against the day after an untagged one. Only consecutive logged days count.
  const tagRefs = new Map<string, StructuredTagRef>();
  for (const day of list) {
    for (const [key, ref] of day.tags)
      if (!tagRefs.has(key)) tagRefs.set(key, ref);
  }
  for (const [key, ref] of tagRefs) {
    const afterTag: number[] = [];
    const afterOther: number[] = [];
    for (const day of list) {
      const prev = days.get(shiftDateKey(day.date, -1));
      if (!prev) continue;
      if (prev.tags.has(key)) afterTag.push(day.mean);
      else afterOther.push(day.mean);
    }
    out.push({
      id: `delayed_tag:${key}`,
      kind: "delayed_tag",
      tag: ref,
      subject: afterTag,
      comparison: afterOther,
    });
  }
  return out;
}

/**
 * The gated patterns over the entries whose mood day falls inside the
 * trailing `windowDays` ending at `todayKey`.
 */
export function computeMoodPatterns(args: {
  entries: readonly MoodAggregateEntry[];
  noteDays: ReadonlySet<string>;
  todayKey: string;
  windowDays: number;
}): MoodPatternFinding[] {
  const fromKey = shiftDateKey(args.todayKey, -(args.windowDays - 1));
  const inWindow = args.entries.filter(
    (e) => e.date >= fromKey && e.date <= args.todayKey,
  );
  const days = collapseDays(inWindow, args.noteDays);

  const tested: Array<{ c: Candidate; p: number }> = [];
  for (const c of candidates(days)) {
    if (
      c.subject.length < PATTERN_MIN_DAYS_PER_SIDE ||
      c.comparison.length < PATTERN_MIN_DAYS_PER_SIDE
    ) {
      continue;
    }
    const welch = welchTTest(c.subject, c.comparison);
    // No spread on either side: nothing a test can stand behind.
    if (welch.status !== "ok") continue;
    tested.push({ c, p: welch.pValue });
  }
  if (tested.length === 0) return [];

  const q = benjaminiHochberg(tested.map((t) => t.p));
  const passed: MoodPatternFinding[] = [];
  tested.forEach(({ c }, i) => {
    if (q[i] > PATTERN_FDR_Q) return;
    const subject = mean(c.subject);
    const comparison = mean(c.comparison);
    if (subject === null || comparison === null) return;
    const delta = subject - comparison;
    passed.push({
      id: c.kind === "best_weekday" ? "best_weekday" : c.id,
      kind: c.kind,
      strength: strengthOf(c.subject, c.comparison),
      direction: delta > 0 ? "higher" : delta < 0 ? "lower" : "none",
      values: {
        subject: round(subject, 2),
        comparison: round(comparison, 2),
        delta: round(delta, 2),
        ...(c.weekday !== undefined ? { weekday: c.weekday } : {}),
        ...(c.tag ? { tagKey: c.tag.key } : {}),
      },
      sampleSize: {
        subject: c.subject.length,
        comparison: c.comparison.length,
      },
      ...(c.tag
        ? { tag: { labelKey: c.tag.labelKey, label: c.tag.label ?? null } }
        : {}),
      qValue: q[i],
    });
  });

  // One best weekday at most: the highest one that passed and is above the
  // rest. A weekday that is only significantly LOWER is not a best weekday.
  const weekdays = passed
    .filter((p) => p.kind === "best_weekday" && p.direction === "higher")
    .sort((a, b) => b.values.subject - a.values.subject);
  const kept = passed.filter((p) => p.kind !== "best_weekday");
  if (weekdays.length > 0) kept.push(weekdays[0]);

  const STRENGTH_RANK = { strong: 0, moderate: 1, weak: 2 } as const;
  return kept.sort(
    (a, b) =>
      STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength] ||
      Math.abs(b.values.delta) - Math.abs(a.values.delta) ||
      a.id.localeCompare(b.id),
  );
}

/** The wire form: the tag named in the reader's language, no internal fields. */
export function moodPatternsWire(
  findings: readonly MoodPatternFinding[] | undefined,
  t: (key: string) => string,
): MoodPatternWire[] {
  return (findings ?? []).map((f) => ({
    id: f.id,
    kind: f.kind,
    strength: f.strength,
    direction: f.direction,
    values: {
      ...f.values,
      ...(f.tag ? { tagLabel: f.tag.label ?? t(f.tag.labelKey) } : {}),
    },
    sampleSize: f.sampleSize,
  }));
}
