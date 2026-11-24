/**
 * What happened around a metric, for the marks a metric chart draws over its
 * line: medication starts, stops, dose changes and pauses, illness episodes,
 * and the phases of the observed cycles.
 *
 * Nothing here reads a table of its own. The medications and the illness
 * episodes come from the timeline's lane readers (`LANE_READERS`), and the
 * cycles from the lane's own row selector (`cycleRows`), so a chart and the
 * timeline can never disagree about what started when: correcting the row
 * corrects both. Each part is read only when its lane is visible to the
 * caller (module switched on, section shared), exactly as on the timeline.
 *
 * The lanes read the whole history of their tables; the window only decides
 * what is sent. That keeps the statement count fixed whatever the window.
 */
import type { TimelineItem } from "@/lib/day/contract";
import { buildPhaseCycles } from "@/lib/cycle/engine-adapter";
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import { phaseForDay } from "@/lib/cycle/phase";
import { LUTEAL_DEFAULT } from "@/lib/cycle/types";
import { prisma } from "@/lib/db";
import {
  cycleRows,
  LANE_READERS,
  laneVisible,
  type LaneFrame,
  type TimelineAccess,
} from "@/lib/timeline/lanes";
import { userDayKey } from "@/lib/tz/format";

import type {
  ChartContextCyclePhaseSpan,
  ChartContextIllnessSpan,
  ChartContextMedicationKind,
  ChartContextMedicationMark,
  ChartContextResponse,
} from "./context-markers-contract";

/**
 * The medication lane's items as marks: a start and a stop per medication
 * and per course, a mark per dose change, a pause and its resumption. Within
 * one medication a mark of the same kind on the same day is one mark, and a
 * dose change on a start day folds into the start (it is the starting dose,
 * not a change). A one-off medication is a single dose, not a change of
 * treatment, and draws nothing.
 */
export function medicationMarks(
  items: readonly TimelineItem[],
): ChartContextMedicationMark[] {
  const oneShot = new Set<string>();
  for (const it of items) {
    // The lane gives a one-off medication no end and does not leave it open.
    if (it.kind === "medication" && it.end === null && !it.open) {
      oneShot.add(it.group ?? it.id);
    }
  }
  const marks = new Map<string, ChartContextMedicationMark>();
  const add = (
    it: TimelineItem,
    kind: ChartContextMedicationKind,
    date: string,
    extra: { estimated?: boolean; dose?: string | null } = {},
  ) => {
    const medicationId = it.group ?? it.id;
    const key = `${medicationId}:${kind}:${date}`;
    if (marks.has(key)) return;
    marks.set(key, {
      id: key,
      medicationId,
      kind,
      date,
      estimated: extra.estimated ?? false,
      name: it.label,
      dose: extra.dose ?? null,
      // A dose change opens the medication's history, everything else the
      // medication itself: the lane's own links.
      href: it.href ?? `/medications/${medicationId}`,
    });
  };
  for (const it of items) {
    const medicationId = it.group ?? it.id;
    if (oneShot.has(medicationId)) continue;
    switch (it.kind) {
      case "medication":
      case "course":
        add(it, "start", it.start, {
          estimated: it.kind === "medication" && !it.startKnown,
        });
        if (it.end !== null) add(it, "stop", it.end);
        break;
      case "doseChange":
        add(it, "doseChange", it.start, { dose: it.sub });
        break;
      case "pause":
        add(it, "pause", it.start);
        if (it.end !== null) add(it, "resume", it.end);
        break;
    }
  }
  // A dose change on a day the medication starts is its starting dose.
  for (const mark of [...marks.values()]) {
    if (mark.kind !== "doseChange") continue;
    const start = marks.get(`${mark.medicationId}:start:${mark.date}`);
    if (!start) continue;
    start.dose = mark.dose;
    marks.delete(mark.id);
  }
  return [...marks.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
}

/** The illness lane's acute episodes as spans; a chronic condition is not one. */
export function illnessSpans(
  items: readonly TimelineItem[],
): ChartContextIllnessSpan[] {
  return items
    .filter((it) => it.kind === "episode")
    .map((it) => ({
      id: it.id,
      start: it.start,
      end: it.end,
      label: it.label,
      href: it.href ?? `/illness/${it.id}`,
    }));
}

/**
 * The phases of the observed cycles as runs of days, through `today` at
 * most. Built with the cycle module's own phase rules (`buildPhaseCycles`
 * and `phaseForDay`), so a day carries the phase the cycle calendar gives
 * it. No forecast is read: the open cycle runs on the population default
 * until a next start closes it, and only its days up to today are drawn.
 */
export function cyclePhaseSpans(
  cycles: ReadonlyArray<{
    startDate: string;
    endDate: string | null;
    periodEndDate: string | null;
    ovulationDate: string | null;
  }>,
  lutealLength: number,
  today: string,
): ChartContextCyclePhaseSpan[] {
  const out: ChartContextCyclePhaseSpan[] = [];
  for (const cycle of buildPhaseCycles(cycles, null, lutealLength, today)) {
    const last = addDays(cycle.nextStart, -1);
    const through = dayDiff(last, today) > 0 ? today : last;
    let run: ChartContextCyclePhaseSpan | null = null;
    for (
      let day = cycle.startDate;
      dayDiff(through, day) >= 0;
      day = addDays(day, 1)
    ) {
      const { phase } = phaseForDay(day, cycle);
      if (phase === null) continue;
      if (run && run.phase === phase) {
        run.end = day;
        continue;
      }
      run = { phase, start: day, end: day };
      out.push(run);
    }
  }
  return out;
}

/** Whether a span (or a single day, `end` equal to `start`) touches `[from, to]`. */
function touches(
  start: string,
  end: string,
  from: string | undefined,
  to: string,
): boolean {
  return start <= to && (from === undefined || end >= from);
}

export async function loadChartContext(args: {
  recordId: string;
  tz: string;
  access: TimelineAccess;
  from?: string;
  to?: string;
  now?: Date;
}): Promise<ChartContextResponse> {
  const { recordId, tz, access } = args;
  const today = userDayKey(args.now ?? new Date(), tz);
  const to = args.to ?? today;
  const from = args.from;
  const frame: LaneFrame = { userId: recordId, tz, access };

  const [medications, illness, cycles] = await Promise.all([
    laneVisible("medications", access) ? LANE_READERS.medications(frame) : null,
    laneVisible("illness", access) ? LANE_READERS.illness(frame) : null,
    laneVisible("cycle", access)
      ? Promise.all([
          cycleRows(frame),
          prisma.cycleProfile.findFirst({
            where: { userId: recordId },
            select: { lutealPhaseLength: true },
          }),
        ])
      : null,
  ]);

  const phases = cycles
    ? cyclePhaseSpans(
        cycles[0],
        cycles[1]?.lutealPhaseLength ?? LUTEAL_DEFAULT,
        today,
      )
    : [];

  return {
    today,
    medications: medicationMarks(medications?.items ?? []).filter((m) =>
      touches(m.date, m.date, from, to),
    ),
    illnesses: illnessSpans(illness?.items ?? [])
      .filter((s) => touches(s.start, s.end ?? today, from, to))
      .sort((a, b) => a.start.localeCompare(b.start)),
    cyclePhases: phases.filter((p) => touches(p.start, p.end, from, to)),
  };
}
