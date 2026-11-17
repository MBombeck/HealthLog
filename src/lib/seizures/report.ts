/**
 * The seizure-diary section of the doctor report (#1368): the loader and the
 * pure assembly behind it.
 *
 * Layout follows the clinical brief: a summary line, the type × month table,
 * a monthly chart with medication changes as markers, duration and rescue
 * tables, suspected triggers, and the overlays the record can actually back
 * (a missed or skipped scheduled dose in the 48 hours before, the cycle day,
 * the night before, an illness at the time). Every overlay is descriptive and
 * appears only when its data exists. The cycle ratios appear only after three
 * complete tracked cycles, and only ever as a reference to Herzog's
 * twofold criterion, never as a finding.
 */
import { prisma } from "@/lib/db";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { reconstructNights } from "@/lib/insights/derived/sleep-score";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { daysBetweenDateKeys, shiftDateKey, userDayKey } from "@/lib/tz/format";

import {
  deriveClusters,
  durationFlags,
  median,
  monthlyByType,
  monthsBetween,
  NICE_CLUSTER_RULE,
  seizureDayKeys,
  seizureFreeSummary,
  totalSeizures,
  type ClusterRule,
} from "./derive";
import { ILAE_TYPE_INFO, isConvulsiveType } from "./ilae";
import type {
  SeizureReportCycleOverlay,
  SeizureReportEventRow,
  SeizureReportMarker,
  SeizureReportSection,
} from "./report-types";
import {
  decryptSeizureText,
  formatRescueDose,
  readClusterRule,
  toDerivable,
  type EventRow,
  type TypeLookup,
} from "./server";

/** Cycle days the distribution keeps; later days fold into the last bucket. */
export const CYCLE_DAY_BUCKETS = 40;

/** Complete cycles needed before a phase ratio is printed. */
export const MIN_CYCLES_FOR_RATIO = 3;

/** Nights on each side before the sleep overlay is printed. */
const MIN_SLEEP_NIGHTS = 3;

const HOUR_MS = 60 * 60 * 1000;

export interface CycleSpan {
  /** `YYYY-MM-DD`, first day of bleeding. */
  startDate: string;
}

/**
 * Seizures by cycle day, and Herzog's C1 / C2 rate ratios over the complete
 * cycles (those followed by another recorded start).
 *
 * C1 (perimenstrual) is day −3 to +3 around the first day of bleeding: the
 * first three days of a cycle and the last three of the one before. C2
 * (periovulatory) is day 10 to day −13, counted back from the next start.
 * A ratio is the seizure rate per day inside the window over the rate on the
 * remaining days of the same cycles; null below three cycles, or when the
 * remaining days held no seizure (a ratio over zero means nothing).
 *
 * Herzog et al., Epilepsia 1997 (pubmed 9579954).
 */
export function cycleOverlay(
  seizureDays: ReadonlyMap<string, number>,
  cycles: readonly CycleSpan[],
): SeizureReportCycleOverlay | null {
  const starts = [...new Set(cycles.map((c) => c.startDate))].sort();
  if (starts.length === 0) return null;

  const byCycleDay = new Array<number>(CYCLE_DAY_BUCKETS).fill(0);
  for (const [day, count] of seizureDays) {
    let start: string | null = null;
    for (const s of starts) {
      if (s <= day) start = s;
      else break;
    }
    if (start === null) continue;
    const next = starts.find((s) => s > start!);
    const d = daysBetweenDateKeys(start, day) + 1;
    // A seizure long after the last recorded start belongs to a cycle nobody
    // tracked; it is left out rather than filed under day 40.
    if (!next && d > CYCLE_DAY_BUCKETS) continue;
    byCycleDay[Math.min(d, CYCLE_DAY_BUCKETS) - 1] += count;
  }

  const complete: Array<{ start: string; length: number }> = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const length = daysBetweenDateKeys(starts[i], starts[i + 1]);
    if (length > 0) complete.push({ start: starts[i], length });
  }

  const ratio = (inWindow: (d: number, length: number) => boolean) => {
    let inDays = 0;
    let inSeizures = 0;
    let outDays = 0;
    let outSeizures = 0;
    for (const { start, length } of complete) {
      for (let d = 1; d <= length; d++) {
        const n = seizureDays.get(shiftDateKey(start, d - 1)) ?? 0;
        if (inWindow(d, length)) {
          inDays += 1;
          inSeizures += n;
        } else {
          outDays += 1;
          outSeizures += n;
        }
      }
    }
    if (inDays === 0 || outDays === 0 || outSeizures === 0) return null;
    return (
      Math.round((inSeizures / inDays / (outSeizures / outDays)) * 10) / 10
    );
  };

  const enough = complete.length >= MIN_CYCLES_FOR_RATIO;
  return {
    cycles: complete.length,
    byCycleDay,
    c1Ratio: enough ? ratio((d, L) => d <= 3 || d > L - 3) : null,
    c2Ratio: enough ? ratio((d, L) => d >= 10 && d <= L - 12) : null,
  };
}

/** Seizures per calendar day in `tz`, each row weighted by its count. */
export function seizuresPerDay(
  events: ReadonlyArray<{ onsetAt: Date; count: number }>,
  tz: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const key = userDayKey(e.onsetAt, tz);
    out.set(key, (out.get(key) ?? 0) + e.count);
  }
  return out;
}

export interface SeizureReportInput {
  rows: readonly EventRow[];
  types: ReadonlyArray<{
    id: string;
    label: string | null;
    ilaeType: SeizureReportSection["types"][number]["ilaeType"];
    usualDurationSec: number | null;
  }>;
  rule: ClusterRule;
  tz: string;
  start: Date;
  end: Date;
  /** Calendar today in `tz`, for "days since the last seizure". */
  todayKey: string;
  lastConfirmedAt: Date | null;
  markers: SeizureReportMarker[];
  overlays: SeizureReportSection["overlays"];
  /** Confirmed seizures per day with any, over the trailing 12 months. */
  trailingYearPerDay: number[];
}

/** Assemble the section from loaded rows. Pure. */
export function buildSeizureReportSection(
  input: SeizureReportInput,
): SeizureReportSection {
  const { rows, tz, start, end } = input;
  const lookup: TypeLookup = new Map(
    input.types.map((t) => [
      t.id,
      { ilaeType: t.ilaeType!, usualDurationSec: t.usualDurationSec },
    ]),
  );
  const derivable = rows.map((r) => toDerivable(r, lookup));
  const confirmed = derivable.filter((e) => e.certainty === "CONFIRMED");
  const fromKey = userDayKey(start, tz);
  const toKey = userDayKey(end, tz);
  const days = Math.max(1, daysBetweenDateKeys(fromKey, toKey) + 1);
  const seizures = totalSeizures(confirmed);
  const seizureDays = seizureDayKeys(confirmed, tz).length;
  const streak = seizureFreeSummary(
    derivable,
    tz,
    fromKey,
    toKey,
    input.todayKey,
  );
  const months = monthsBetween(fromKey, toKey);
  const monthly = monthlyByType(confirmed, tz);
  const align = (row: (typeof monthly.rows)[number]) => ({
    typeId: row.typeProfileId === "__total" ? null : row.typeProfileId,
    counts: months.map((m) => row.counts[m] ?? 0),
    days: months.map((m) => row.days[m] ?? 0),
    total: row.total,
  });

  // Types in their order, then the untyped row when any seizure has no type.
  const usedTypeIds = new Set(rows.map((r) => r.typeProfileId));
  const types: SeizureReportSection["types"] = [
    ...input.types.filter((t) => usedTypeIds.has(t.id)),
    ...(usedTypeIds.has(null)
      ? [{ id: null, label: null, ilaeType: null, usualDurationSec: null }]
      : []),
  ];
  const typeOrder = new Map(types.map((t, i) => [t.id, i]));
  const byType = <T extends { typeId: string | null }>(list: T[]) =>
    list.sort(
      (a, b) =>
        (typeOrder.get(a.typeId) ?? 99) - (typeOrder.get(b.typeId) ?? 99),
    );

  const durations = byType(
    types.map((t) => {
      const timed = confirmed.filter(
        (e) => e.typeProfileId === t.id && e.durationSec !== null,
      );
      const secs = timed.map((e) => e.durationSec!);
      const flags = timed.map((e) =>
        durationFlags(e.durationSec, e.ilaeType, t.usualDurationSec),
      );
      return {
        typeId: t.id,
        timed: timed.length,
        medianSec: median(secs),
        maxSec: secs.length ? Math.max(...secs) : null,
        t1Sec: t.ilaeType ? ILAE_TYPE_INFO[t.ilaeType].t1Sec : null,
        overT1: flags.filter((f) => f.overT1 === true).length,
        prolonged: flags.filter((f) => f.prolonged === true).length,
      };
    }),
  ).filter((d) => d.timed > 0);

  const rescue = rows
    .flatMap((r) =>
      r.rescueDoses.map((d) => {
        const minutes = Math.round(
          (d.givenAt.getTime() - r.onsetAt.getTime()) / 60_000,
        );
        return {
          givenAt: d.givenAt.toISOString(),
          medicationName: d.medicationName,
          dose: formatRescueDose(d.doseAmount, d.doseUnit),
          route: d.route,
          givenBy: d.givenBy,
          minutesFromOnset:
            r.onsetPrecision === "UNKNOWN_TIME" || minutes < 0 ? null : minutes,
          effect: d.effect,
        };
      }),
    )
    .sort((a, b) => a.givenAt.localeCompare(b.givenAt));

  const triggerCounts = new Map<string, number>();
  for (const r of rows) {
    for (const trig of r.triggers) {
      if (trig === "NONE_IDENTIFIED") continue;
      triggerCounts.set(trig, (triggerCounts.get(trig) ?? 0) + 1);
    }
  }

  const chronological = [...rows].sort(
    (a, b) => a.onsetAt.getTime() - b.onsetAt.getTime(),
  );
  const events: SeizureReportEventRow[] = chronological.map((r) => {
    const note = decryptSeizureText(r.noteEncrypted, "note");
    return {
      id: r.id,
      onsetAt: r.onsetAt.toISOString(),
      onsetUnknown: r.onsetPrecision === "UNKNOWN_TIME",
      typeId: r.typeProfileId,
      ilaeType: toDerivable(r, lookup).ilaeType,
      count: r.count,
      suspected: r.certainty === "SUSPECTED",
      durationSec: r.durationSec,
      estimated: r.durationSource === "ESTIMATED",
      sleepState: r.sleepState,
      rescue: r.rescueDoses.length > 0,
      injury: r.injuries.some((i) => i !== "NONE"),
      note: note ? (note.length > 80 ? `${note.slice(0, 79)}…` : note) : null,
      responsiveness: r.responsiveness,
      recall: r.recall,
      postictal: r.postictal,
      injuries: r.injuries,
      triggers: r.triggers,
      emergency: r.emergency,
      witnessed: r.witnessed,
      witnessRole: r.witnessRole,
      loggedByDelegate:
        r.loggedByUserId !== null && r.loggedByUserId !== r.userId,
      rescueDoses: r.rescueDoses.map((d) => ({
        medicationId: d.medicationId,
        medicationName: d.medicationName,
        doseAmount: d.doseAmount,
        doseUnit: d.doseUnit,
        route: d.route,
        givenAt: d.givenAt.toISOString(),
        givenBy: d.givenBy,
        effect: d.effect,
      })),
    };
  });

  const daysSinceLast =
    input.lastConfirmedAt === null
      ? null
      : Math.max(
          0,
          daysBetweenDateKeys(
            userDayKey(input.lastConfirmedAt, tz),
            input.todayKey,
          ),
        );

  return {
    rule: input.rule,
    niceRule: NICE_CLUSTER_RULE,
    types,
    summary: {
      seizures,
      suspected: totalSeizures(
        derivable.filter((e) => e.certainty === "SUSPECTED"),
      ),
      seizureDays,
      seizureFreeDays: Math.max(0, days - seizureDays),
      per28Days: Math.round((seizures / days) * 28 * 10) / 10,
      longestFreeDays: streak.longestFreeDays,
      daysSinceLast,
      convulsive: totalSeizures(
        confirmed.filter((e) => isConvulsiveType(e.ilaeType)),
      ),
      fromSleep: totalSeizures(
        confirmed.filter((e) => e.sleepState === "ASLEEP"),
      ),
      clusterEpisodes: deriveClusters(derivable, input.rule).length,
      niceClusterEpisodes: deriveClusters(derivable, NICE_CLUSTER_RULE).length,
      rescueDoses: rescue.length,
      emsCalled: rows.filter((r) => r.emergency === "EMS_CALLED").length,
      edVisits: rows.filter((r) => r.emergency === "ED_VISIT").length,
      admissions: rows.filter((r) => r.emergency === "ADMITTED").length,
    },
    months,
    monthly: byType(monthly.rows.map(align)),
    monthlyTotal: align(monthly.total),
    markers: input.markers,
    durations,
    rescue,
    triggers: [...triggerCounts.entries()]
      .map(([trigger, count]) => ({
        trigger: trigger as SeizureReportSection["triggers"][number]["trigger"],
        count,
      }))
      .sort((a, b) => b.count - a.count || a.trigger.localeCompare(b.trigger)),
    overlays: input.overlays,
    events,
    clusters: deriveClusters(derivable, input.rule),
    trailingYearPerDay: input.trailingYearPerDay,
  };
}

/** A `@db.Date` column's calendar day. */
function dateKeyOfDbDate(d: Date): string {
  return dateOnlyKey(d);
}

/** Starts, stops and dose changes of the record's scheduled medications. */
async function loadMarkers(
  userId: string,
  start: Date,
  end: Date,
  tz: string,
): Promise<SeizureReportMarker[]> {
  const fromKey = userDayKey(start, tz);
  const toKey = userDayKey(end, tz);
  const [changes, courses] = await Promise.all([
    prisma.medicationDoseChange.findMany({
      where: {
        medication: { userId, asNeeded: false },
        effectiveFrom: { gte: start, lte: end },
      },
      select: {
        effectiveFrom: true,
        doseValue: true,
        doseUnit: true,
        medication: { select: { name: true } },
      },
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
    }),
    prisma.medicationCourse.findMany({
      where: { userId, medication: { asNeeded: false } },
      select: {
        startsOn: true,
        endsOn: true,
        endedAt: true,
        medication: { select: { name: true } },
      },
    }),
  ]);
  const markers: SeizureReportMarker[] = changes.map((c) => ({
    date: userDayKey(c.effectiveFrom, tz),
    medicationName: c.medication.name,
    kind: "change",
    dose: `${Number(c.doseValue.toFixed(3))} ${c.doseUnit}`.trim(),
  }));
  for (const c of courses) {
    const started = dateKeyOfDbDate(c.startsOn);
    if (started >= fromKey && started <= toKey) {
      markers.push({
        date: started,
        medicationName: c.medication.name,
        kind: "start",
        dose: null,
      });
    }
    const stopped = c.endedAt
      ? userDayKey(c.endedAt, tz)
      : c.endsOn
        ? dateKeyOfDbDate(c.endsOn)
        : null;
    if (stopped && stopped >= fromKey && stopped <= toKey) {
      markers.push({
        date: stopped,
        medicationName: c.medication.name,
        kind: "stop",
        dose: null,
      });
    }
  }
  return markers.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.medicationName.localeCompare(b.medicationName),
  );
}

async function loadMissedDoseOverlay(
  userId: string,
  confirmed: readonly EventRow[],
): Promise<SeizureReportSection["overlays"]["missedDose"]> {
  const scheduled = await prisma.medication.count({
    where: { userId, asNeeded: false, trackIntake: true },
  });
  if (scheduled === 0 || confirmed.length === 0) return null;
  const earliest = Math.min(...confirmed.map((r) => r.onsetAt.getTime()));
  const latest = Math.max(...confirmed.map((r) => r.onsetAt.getTime()));
  const misses = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [{ autoMissed: true }, { skipped: true }],
      // A record-only medication counts no dose, so it misses none either.
      medication: { ...TRACKED_INTAKE_EVENT_WHERE.medication, asNeeded: false },
      scheduledFor: {
        gte: new Date(earliest - 48 * HOUR_MS),
        lt: new Date(latest),
      },
    },
    select: { scheduledFor: true },
  });
  const times = misses.map((m) => m.scheduledFor.getTime());
  let followed = 0;
  let of = 0;
  for (const r of confirmed) {
    of += r.count;
    const t = r.onsetAt.getTime();
    if (times.some((m) => m < t && m >= t - 48 * HOUR_MS)) followed += r.count;
  }
  return { followed, of };
}

async function loadSleepOverlay(
  userId: string,
  start: Date,
  end: Date,
  tz: string,
  seizureDayKeySet: ReadonlySet<string>,
): Promise<SeizureReportSection["overlays"]["sleep"]> {
  const [rows, priority] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        type: "SLEEP_DURATION",
        deletedAt: null,
        measuredAt: { gte: new Date(start.getTime() - 24 * HOUR_MS), lte: end },
      },
      orderBy: { measuredAt: "asc" },
      select: {
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        deviceType: true,
      },
    }),
    loadUserSourcePriority(userId),
  ]);
  if (rows.length === 0) return null;
  const nights = reconstructNights(rows, tz, priority).filter(
    (n) => n.asleepMinutes > 0,
  );
  const before = nights.filter((n) => seizureDayKeySet.has(n.night));
  const other = nights.filter((n) => !seizureDayKeySet.has(n.night));
  if (before.length < MIN_SLEEP_NIGHTS || other.length < MIN_SLEEP_NIGHTS) {
    return null;
  }
  const mean = (list: typeof nights) =>
    Math.round(list.reduce((s, n) => s + n.asleepMinutes, 0) / list.length);
  return {
    beforeSeizureDays: mean(before),
    otherNights: mean(other),
    nightsBefore: before.length,
    nightsOther: other.length,
  };
}

async function loadIllnessOverlay(
  userId: string,
  start: Date,
  end: Date,
  confirmed: readonly EventRow[],
): Promise<SeizureReportSection["overlays"]["illness"]> {
  const episodes = await prisma.illnessEpisode.findMany({
    where: {
      userId,
      deletedAt: null,
      onsetAt: { lte: end },
      OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }],
    },
    select: { onsetAt: true, resolvedAt: true },
  });
  if (episodes.length === 0) return null;
  let during = 0;
  for (const r of confirmed) {
    const t = r.onsetAt.getTime();
    if (
      episodes.some(
        (e) => e.onsetAt.getTime() <= t && t <= (e.resolvedAt ?? end).getTime(),
      )
    ) {
      during += r.count;
    }
  }
  return { during, episodes: episodes.length };
}

async function loadCycleOverlay(
  userId: string,
  start: Date,
  end: Date,
  tz: string,
  confirmed: readonly EventRow[],
): Promise<SeizureReportCycleOverlay | null> {
  const fromKey = userDayKey(start, tz);
  const toKey = userDayKey(end, tz);
  const cycles = await prisma.menstrualCycle.findMany({
    where: {
      userId,
      deletedAt: null,
      // One cycle before the period, so its first seizures have a day.
      startDate: { gte: shiftDateKey(fromKey, -60), lte: toKey },
    },
    select: { startDate: true },
    orderBy: { startDate: "asc" },
  });
  if (cycles.length === 0) return null;
  return cycleOverlay(seizuresPerDay(confirmed, tz), cycles);
}

/**
 * Which overlay sources the report may read. Each overlay is read only when
 * the leaf that owns its source is in the report too, so withholding the
 * illness episodes, the cycle, the sleep or the medication compliance from a
 * report also withholds what the seizure section would say about them.
 */
export interface SeizureOverlayAdmission {
  missedDose: boolean;
  cycle: boolean;
  sleep: boolean;
  illness: boolean;
}

const ALL_OVERLAYS: SeizureOverlayAdmission = {
  missedDose: true,
  cycle: true,
  sleep: true,
  illness: true,
};

/**
 * Load the section for the report window, or null when the period holds no
 * recorded seizure. The overlays are read only for what the record holds and
 * the report admits.
 */
export async function loadSeizureReport(
  userId: string,
  start: Date,
  end: Date,
  tz: string,
  admit: SeizureOverlayAdmission = ALL_OVERLAYS,
  now: Date = new Date(),
): Promise<SeizureReportSection | null> {
  const yearAgo = new Date(now.getTime() - 365 * 24 * HOUR_MS);
  const [typeRows, rule, rows, lastConfirmed, yearRows] = await Promise.all([
    prisma.seizureTypeProfile.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        labelEncrypted: true,
        ilaeType: true,
        usualDurationSec: true,
      },
    }),
    readClusterRule(userId),
    prisma.seizureEvent.findMany({
      where: { userId, onsetAt: { gte: start, lte: end } },
      include: { rescueDoses: true },
      orderBy: [{ onsetAt: "asc" }, { id: "asc" }],
    }),
    prisma.seizureEvent.findFirst({
      where: { userId, certainty: "CONFIRMED", onsetAt: { lte: now } },
      orderBy: { onsetAt: "desc" },
      select: { onsetAt: true },
    }),
    prisma.seizureEvent.findMany({
      where: {
        userId,
        certainty: "CONFIRMED",
        onsetAt: { gte: yearAgo, lte: now },
      },
      select: { onsetAt: true, count: true },
    }),
  ]);
  if (rows.length === 0) return null;

  const confirmed = rows.filter((r) => r.certainty === "CONFIRMED");
  const dayKeys = new Set(seizuresPerDay(confirmed, tz).keys());
  const [markers, missedDose, sleep, illness, cycle] = await Promise.all([
    loadMarkers(userId, start, end, tz),
    admit.missedDose ? loadMissedDoseOverlay(userId, confirmed) : null,
    admit.sleep ? loadSleepOverlay(userId, start, end, tz, dayKeys) : null,
    admit.illness ? loadIllnessOverlay(userId, start, end, confirmed) : null,
    admit.cycle ? loadCycleOverlay(userId, start, end, tz, confirmed) : null,
  ]);

  return buildSeizureReportSection({
    rows,
    types: typeRows.map((t) => ({
      id: t.id,
      label: decryptSeizureText(t.labelEncrypted, "label"),
      ilaeType: t.ilaeType,
      usualDurationSec: t.usualDurationSec,
    })),
    rule,
    tz,
    start,
    end,
    todayKey: userDayKey(now, tz),
    lastConfirmedAt: lastConfirmed?.onsetAt ?? null,
    markers,
    overlays: { missedDose, cycle, sleep, illness },
    trailingYearPerDay: [...seizuresPerDay(yearRows, tz).values()],
  });
}
