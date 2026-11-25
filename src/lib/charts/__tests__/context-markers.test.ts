import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/cycle/day-math";
import { buildPhaseCycles } from "@/lib/cycle/engine-adapter";
import { phaseForDay } from "@/lib/cycle/phase";
import type { TimelineItem } from "@/lib/day/contract";

import {
  cyclePhaseSpans,
  illnessSpans,
  medicationMarks,
} from "../context-markers";

/**
 * The marks are a projection of the timeline lanes' items, never a read of
 * their own; these pin the projection. The route, the zone and the DST
 * nights are `tests/integration/chart-context.test.ts`.
 */
function item(
  rest: Partial<TimelineItem> & Pick<TimelineItem, "id" | "kind" | "start">,
): TimelineItem {
  return {
    end: null,
    open: false,
    precision: "DAY",
    startKnown: true,
    label: "Med",
    sub: null,
    href: null,
    group: null,
    ...rest,
  } as TimelineItem;
}

describe("medicationMarks", () => {
  it("marks starts, stops, dose changes, pauses and resumptions in day order", () => {
    const marks = medicationMarks([
      item({
        id: "m1",
        kind: "medication",
        start: "2026-01-05",
        open: true,
        group: "m1",
        href: "/medications/m1",
      }),
      item({
        id: "d1",
        kind: "doseChange",
        start: "2026-02-01",
        sub: "10 mg",
        group: "m1",
        href: "/medications/m1?tab=history",
      }),
      item({
        id: "p1",
        kind: "pause",
        start: "2026-03-01",
        end: "2026-03-08",
        group: "m1",
      }),
      item({
        id: "c1",
        kind: "course",
        start: "2026-04-01",
        end: "2026-04-10",
        group: "m1",
      }),
    ]);
    expect(marks.map((m) => [m.kind, m.date, m.dose])).toEqual([
      ["start", "2026-01-05", null],
      ["doseChange", "2026-02-01", "10 mg"],
      ["pause", "2026-03-01", null],
      ["resume", "2026-03-08", null],
      ["start", "2026-04-01", null],
      ["stop", "2026-04-10", null],
    ]);
    expect(marks[1].href).toBe("/medications/m1?tab=history");
    // A lane item without a link falls back to the medication.
    expect(marks[2].href).toBe("/medications/m1");
    expect(new Set(marks.map((m) => m.id)).size).toBe(marks.length);
  });

  it("folds a dose change on the start day into the start, and one start per day", () => {
    const marks = medicationMarks([
      item({
        id: "m1",
        kind: "medication",
        start: "2026-01-05",
        open: true,
        group: "m1",
      }),
      item({
        id: "c1",
        kind: "course",
        start: "2026-01-05",
        open: true,
        group: "m1",
      }),
      item({
        id: "d1",
        kind: "doseChange",
        start: "2026-01-05",
        sub: "5 mg",
        group: "m1",
      }),
    ]);
    expect(marks.map((m) => [m.kind, m.date, m.dose])).toEqual([
      ["start", "2026-01-05", "5 mg"],
    ]);
  });

  it("says when a start is the first logged dose, and leaves a one-off dose out", () => {
    const marks = medicationMarks([
      item({
        id: "m1",
        kind: "medication",
        start: "2026-01-05",
        open: true,
        startKnown: false,
        group: "m1",
      }),
      // A one-off medication: no end, not open.
      item({ id: "m2", kind: "medication", start: "2026-01-06", group: "m2" }),
      item({
        id: "d2",
        kind: "doseChange",
        start: "2026-01-09",
        sub: "1",
        group: "m2",
      }),
    ]);
    expect(marks.map((m) => [m.medicationId, m.kind, m.estimated])).toEqual([
      ["m1", "start", true],
    ]);
  });

  it("marks nothing for an empty lane", () => {
    expect(medicationMarks([])).toEqual([]);
  });
});

describe("illnessSpans", () => {
  it("keeps acute episodes and leaves chronic conditions out", () => {
    expect(
      illnessSpans([
        item({
          id: "e1",
          kind: "episode",
          start: "2026-02-01",
          end: "2026-02-06",
          label: "Flu",
          href: "/illness/e1",
        }),
        item({
          id: "e2",
          kind: "episode",
          start: "2026-03-01",
          open: true,
          label: "Cold",
        }),
        item({
          id: "c1",
          kind: "chronic",
          start: "2019-01-01",
          open: true,
          label: "Asthma",
        }),
      ]),
    ).toEqual([
      {
        id: "e1",
        start: "2026-02-01",
        end: "2026-02-06",
        label: "Flu",
        href: "/illness/e1",
      },
      {
        id: "e2",
        start: "2026-03-01",
        end: null,
        label: "Cold",
        href: "/illness/e2",
      },
    ]);
  });
});

describe("cyclePhaseSpans", () => {
  const cycles = [
    {
      startDate: "2026-01-01",
      endDate: "2026-01-28",
      periodEndDate: "2026-01-05",
      ovulationDate: null,
    },
    {
      startDate: "2026-01-29",
      endDate: "2026-02-27",
      periodEndDate: "2026-02-02",
      ovulationDate: "2026-02-12",
    },
    {
      startDate: "2026-02-28",
      endDate: null,
      periodEndDate: null,
      ovulationDate: null,
    },
  ];

  it("gives every day the phase the cycle engine gives it, contiguous and through today", () => {
    const today = "2026-03-10";
    const spans = cyclePhaseSpans(cycles, 14, today);
    expect(spans[0]).toEqual({
      phase: "MENSTRUAL",
      start: "2026-01-01",
      end: "2026-01-05",
    });
    expect(spans.at(-1)?.end).toBe(today);
    const phaseCycles = buildPhaseCycles(cycles, null, 14, today);
    let expected = "2026-01-01";
    for (const span of spans) {
      expect(span.start).toBe(expected);
      for (let day = span.start; day <= span.end; day = addDays(day, 1)) {
        const engine = phaseCycles
          .map((c) => phaseForDay(day, c).phase)
          .find((p) => p !== null);
        expect(engine, day).toBe(span.phase);
      }
      expected = addDays(span.end, 1);
    }
    // The confirmed ovulation day anchors its window.
    expect(spans).toContainEqual({
      phase: "OVULATORY",
      start: "2026-02-11",
      end: "2026-02-13",
    });
  });

  it("is empty without cycles", () => {
    expect(cyclePhaseSpans([], 14, "2026-03-10")).toEqual([]);
  });
});
