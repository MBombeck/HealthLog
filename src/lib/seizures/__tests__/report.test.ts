import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (b: Uint8Array) => Buffer.from(b).toString("utf8"),
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(s, "utf8")),
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  buildSeizureReportSection,
  cycleOverlay,
  seizuresPerDay,
} from "../report";
import type { EventRow } from "../server";

let n = 0;
function row(onsetAt: string, extra: Partial<EventRow> = {}): EventRow {
  n += 1;
  return {
    id: `s${n}`,
    userId: "u1",
    typeProfileId: "t1",
    ilaeType: null,
    onsetAt: new Date(onsetAt),
    onsetPrecision: "EXACT",
    durationSec: 120,
    durationSource: "TIMED",
    count: 1,
    certainty: "CONFIRMED",
    sleepState: "AWAKE",
    observableManifestations: null,
    responsiveness: null,
    recall: null,
    semiology: [],
    semiologyNoteEncrypted: null,
    auraEncrypted: null,
    triggers: [],
    postictalMinutes: null,
    postictal: [],
    injuries: [],
    incontinence: null,
    emergency: "NONE",
    witnessed: null,
    witnessRole: null,
    witnessNoteEncrypted: null,
    loggedByUserId: "u1",
    source: "MANUAL",
    noteEncrypted: null,
    createdAt: new Date(onsetAt),
    updatedAt: new Date(onsetAt),
    rescueDoses: [],
    ...extra,
  } as EventRow;
}

const TYPES = [
  {
    id: "t1",
    label: "Big one",
    ilaeType: "FOCAL_TO_BILATERAL_TC" as const,
    usualDurationSec: 90,
  },
  {
    id: "t2",
    label: "Absences",
    ilaeType: "ABSENCE_TYPICAL" as const,
    usualDurationSec: 10,
  },
];

function build(rows: EventRow[]) {
  return buildSeizureReportSection({
    rows,
    types: TYPES,
    rule: { count: 2, windowHours: 24 },
    tz: "UTC",
    start: new Date("2026-01-01T00:00:00Z"),
    end: new Date("2026-03-31T23:59:59Z"),
    todayKey: "2026-03-31",
    lastConfirmedAt: rows.length ? rows.at(-1)!.onsetAt : null,
    markers: [],
    overlays: { missedDose: null, cycle: null, sleep: null, illness: null },
    trailingYearPerDay: [],
  });
}

describe("buildSeizureReportSection", () => {
  it("summarises confirmed seizures and lists suspected ones apart", () => {
    const section = build([
      row("2026-01-05T08:00:00Z"),
      row("2026-01-05T20:00:00Z", { durationSec: 400, sleepState: "ASLEEP" }),
      row("2026-02-10T08:00:00Z", {
        typeProfileId: "t2",
        count: 5,
        durationSec: 8,
      }),
      row("2026-03-01T08:00:00Z", { certainty: "SUSPECTED" }),
    ]);
    expect(section.summary.seizures).toBe(7);
    expect(section.summary.suspected).toBe(1);
    expect(section.summary.seizureDays).toBe(2);
    expect(section.summary.convulsive).toBe(2);
    expect(section.summary.fromSleep).toBe(1);
    expect(section.summary.clusterEpisodes).toBe(2);
    expect(section.months).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(section.monthlyTotal.counts).toEqual([2, 5, 0]);
    const big = section.monthly.find((m) => m.typeId === "t1")!;
    expect(big.counts).toEqual([2, 0, 0]);
    expect(big.days).toEqual([1, 0, 0]);
  });

  it("flags durations against t1 and the usual duration plus two minutes", () => {
    const section = build([
      row("2026-01-05T08:00:00Z", { durationSec: 300 }),
      row("2026-01-20T08:00:00Z", { durationSec: 100 }),
      row("2026-01-28T08:00:00Z", {
        durationSec: null,
        durationSource: "UNKNOWN",
      }),
    ]);
    const big = section.durations.find((d) => d.typeId === "t1")!;
    expect(big.timed).toBe(2);
    expect(big.t1Sec).toBe(300);
    expect(big.overT1).toBe(1);
    expect(big.prolonged).toBe(1);
    expect(big.maxSec).toBe(300);
    expect(big.medianSec).toBe(200);
  });

  it("times rescue doses from the onset", () => {
    const onset = "2026-01-05T08:00:00Z";
    const section = build([
      row(onset, {
        rescueDoses: [
          {
            id: "d1",
            userId: "u1",
            eventId: "s",
            medicationId: "m1",
            medicationName: "Midazolam",
            doseAmount: 10,
            doseUnit: "mg",
            route: "BUCCAL",
            givenAt: new Date("2026-01-05T08:06:00Z"),
            givenBy: "PARENT",
            effect: "STOPPED",
            seizureEndedAt: null,
            intakeEventId: null,
            createdAt: new Date(onset),
            updatedAt: new Date(onset),
          },
        ],
      }),
    ]);
    expect(section.rescue).toEqual([
      expect.objectContaining({
        medicationName: "Midazolam",
        dose: "10 mg",
        minutesFromOnset: 6,
        effect: "STOPPED",
      }),
    ]);
    expect(section.events[0].rescue).toBe(true);
  });

  it("keeps the untyped row and the note cut to one line", () => {
    const long = "x".repeat(120);
    const section = build([
      row("2026-01-05T08:00:00Z", {
        typeProfileId: null,
        noteEncrypted: Uint8Array.from(Buffer.from(long)),
      }),
    ]);
    expect(section.types.at(-1)).toEqual(expect.objectContaining({ id: null }));
    expect(section.events[0].note!.length).toBe(80);
  });

  it("counts suspected triggers and leaves out 'none identified'", () => {
    const section = build([
      row("2026-01-05T08:00:00Z", { triggers: ["FEVER", "NONE_IDENTIFIED"] }),
      row("2026-01-09T08:00:00Z", { triggers: ["FEVER", "STRESS"] }),
    ]);
    expect(section.triggers).toEqual([
      { trigger: "FEVER", count: 2 },
      { trigger: "STRESS", count: 1 },
    ]);
  });
});

describe("cycleOverlay", () => {
  // Four 28-day cycles from 1 January.
  const cycles = [
    { startDate: "2026-01-01" },
    { startDate: "2026-01-29" },
    { startDate: "2026-02-26" },
    { startDate: "2026-03-26" },
  ];

  it("places seizures on their cycle day", () => {
    const per = new Map([
      ["2026-01-01", 1],
      ["2026-01-02", 2],
      ["2026-02-10", 1],
    ]);
    const overlay = cycleOverlay(per, cycles)!;
    expect(overlay.byCycleDay[0]).toBe(1);
    expect(overlay.byCycleDay[1]).toBe(2);
    // 10 February is day 13 of the cycle that began on 29 January.
    expect(overlay.byCycleDay[12]).toBe(1);
  });

  it("withholds the ratios below three complete cycles", () => {
    const overlay = cycleOverlay(
      new Map([["2026-01-02", 1]]),
      cycles.slice(0, 3),
    )!;
    expect(overlay.cycles).toBe(2);
    expect(overlay.c1Ratio).toBeNull();
    expect(overlay.c2Ratio).toBeNull();
  });

  it("computes the perimenstrual rate ratio over three complete cycles", () => {
    // One seizure on day 1 of each cycle (C1), one mid-cycle (outside both).
    const per = new Map([
      ["2026-01-01", 1],
      ["2026-01-29", 1],
      ["2026-02-26", 1],
      ["2026-01-08", 1],
    ]);
    const overlay = cycleOverlay(per, cycles)!;
    expect(overlay.cycles).toBe(3);
    // C1: 6 days per cycle, 18 days, 3 seizures; outside: 66 days, 1 seizure.
    expect(overlay.c1Ratio).toBe(Math.round((3 / 18 / (1 / 66)) * 10) / 10);
  });

  it("answers null without any recorded cycle", () => {
    expect(cycleOverlay(new Map(), [])).toBeNull();
  });
});

describe("seizuresPerDay", () => {
  it("weights by count on the person's calendar day", () => {
    const per = seizuresPerDay(
      [
        { onsetAt: new Date("2026-01-01T23:30:00Z"), count: 3 },
        { onsetAt: new Date("2026-01-02T08:00:00Z"), count: 1 },
      ],
      "Europe/Berlin",
    );
    expect(per.get("2026-01-02")).toBe(4);
  });
});
