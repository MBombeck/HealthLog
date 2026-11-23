/**
 * A rate or a streak with no eligible data behind it is an empty state,
 * never a number.
 *
 * Three surfaces claimed figures nothing had produced: a medication added an
 * hour ago read "Adherence 100 %" twice and "1 day streak" with no dose yet,
 * and a seizure diary opened today put "Longest run without a recorded
 * seizure: 90 days" and "0.3 per 28 days" into the doctor report. The rules,
 * each in one place:
 *
 *   - adherence: every web surface reads the two rates through
 *     `shownAdherence` / `scoredRate`, null when the window's denominator is
 *     zero (`src/lib/medications/shown-adherence.ts`);
 *   - streaks: a run starts on a day with an answered dose
 *     (`streaksFromTimeline`); the achievement day streaks already require a
 *     resolved slot (`src/lib/gamification/care-metrics.ts`);
 *   - seizure figures count from the diary's start (`figuresFrom`), and the
 *     report names that start;
 *   - the health score: each pillar refuses below its own minimum input and
 *     the composite refuses when no pillar is usable (pinned in
 *     `src/lib/analytics/score/__tests__/{pillars,composite}.test.ts`).
 *
 * The last leg freezes the readers: no medication surface reads a rate off
 * the compliance payload except through the helper.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (b: Uint8Array) => Buffer.from(b).toString("utf8"),
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(s, "utf8")),
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { readSourceFolder } from "@/__tests__/helpers/source-files";
import {
  buildComplianceDisplay,
  buildComplianceMedicationContext,
  type ComplianceSchedule,
} from "@/lib/analytics/compliance";
import { streaksFromTimeline } from "@/lib/medications/scheduling/compliance";
import type { PairedDose } from "@/lib/medications/scheduling/cadence";
import { scoredRate, shownAdherence } from "@/lib/medications/shown-adherence";
import { buildSeizureReportSection } from "@/lib/seizures/report";
import { figuresFrom, type EventRow } from "@/lib/seizures/server";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("adherence without a dose to score", () => {
  const evening: ComplianceSchedule = {
    windowStart: "19:00",
    windowEnd: "19:00",
    timesOfDay: ["19:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };

  it("shows no rate and no streak for a medication added this morning", () => {
    const now = new Date("2026-11-21T11:00:00.000Z");
    const ctx = buildComplianceMedicationContext(
      {
        startsOn: null,
        endsOn: null,
        endedAt: null,
        oneShot: false,
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      },
      null,
      "UTC",
    );
    const display = buildComplianceDisplay([], [evening], ctx, { now });
    expect(display.short.expected).toBe(0);
    expect(display.short.streak).toBe(0);
    const shown = shownAdherence({ complianceDisplay: display });
    expect(shown.rate7).toBeNull();
    expect(shown.rate30).toBeNull();
    expect(shown.streak).toBe(0);
  });

  it("keeps a rate that has a denominator", () => {
    expect(scoredRate(100, 0)).toBeNull();
    expect(scoredRate(80, 5)).toBe(80);
    // An older payload without a denominator keeps what it said.
    expect(scoredRate(80, undefined)).toBe(80);
  });
});

describe("streaks start on a day with an answered dose", () => {
  const dose = (day: string, status: PairedDose["status"]): PairedDose => ({
    day: new Date(`${day}T00:00:00.000Z`),
    windowStart: new Date(`${day}T08:00:00.000Z`),
    windowEnd: new Date(`${day}T08:00:00.000Z`),
    scheduleIndex: 0,
    match: null,
    status,
  });
  const asOf = new Date("2026-11-21T12:00:00.000Z");

  it("counts nothing before the first answered dose", () => {
    expect(
      streaksFromTimeline([dose("2026-11-21", "upcoming")], asOf, 30, "UTC")
        .current,
    ).toBe(0);
    expect(streaksFromTimeline([], asOf, 30, "UTC").current).toBe(0);
  });

  it("carries a run over days without a dose once it has started", () => {
    // A weekly dose taken on the 16th: the days after it carry the run on.
    const { current } = streaksFromTimeline(
      [dose("2026-11-16", "taken")],
      asOf,
      30,
      "UTC",
    );
    expect(current).toBe(6);
  });
});

describe("seizure figures count from the diary's start", () => {
  const row = (onsetAt: string): EventRow =>
    ({
      id: "s1",
      userId: "u1",
      typeProfileId: null,
      onsetAt: new Date(onsetAt),
      onsetPrecision: "EXACT",
      durationSec: 60,
      durationSource: "TIMED",
      count: 1,
      certainty: "CONFIRMED",
      sleepState: "AWAKE",
      semiology: [],
      triggers: [],
      postictal: [],
      injuries: [],
      emergency: "NONE",
      loggedByUserId: "u1",
      source: "MANUAL",
      createdAt: new Date(onsetAt),
      updatedAt: new Date(onsetAt),
      rescueDoses: [],
    }) as unknown as EventRow;

  it("claims no run for the days before a diary opened today", () => {
    const end = new Date("2026-11-21T23:59:59.000Z");
    const start = new Date(end.getTime() - 90 * DAY_MS);
    const diaryStart = new Date("2026-11-21T09:00:00.000Z");
    const section = buildSeizureReportSection({
      rows: [row("2026-11-21T10:30:00.000Z")],
      types: [],
      rule: { count: 2, windowHours: 24 },
      tz: "UTC",
      start,
      end,
      figuresFrom: figuresFrom(start, end, diaryStart),
      todayKey: "2026-11-21",
      lastConfirmedAt: new Date("2026-11-21T10:30:00.000Z"),
      markers: [],
      overlays: { missedDose: null, cycle: null, sleep: null, illness: null },
      trailingYearPerDay: [],
    });
    expect(section.summary.longestFreeDays).toBe(0);
    expect(section.summary.seizureFreeDays).toBe(0);
    expect(section.summary.per28Days).toBe(28);
    expect(section.summary.diaryFrom).toBe(diaryStart.toISOString());
  });

  it("counts an empty diary as a single day, not the whole window", () => {
    const to = new Date("2026-11-21T12:00:00.000Z");
    const from = new Date(to.getTime() - 90 * DAY_MS);
    expect(figuresFrom(from, to, null)).toEqual(to);
    expect(figuresFrom(from, to, new Date("2026-01-01T00:00:00Z"))).toEqual(
      from,
    );
  });
});

describe("medication surfaces read a rate only through the helper", () => {
  it("leaves no direct read of the compliance payload's rates", () => {
    const files = readSourceFolder("src", {
      floor: 1000,
      include: (rel) =>
        /^(components|app)\//.test(rel) &&
        !rel.startsWith("app/api/") &&
        !rel.includes("__tests__/"),
    });
    // The readers that do go through the helper: card, GLP-1 card, detail
    // page, table and the Insights medications page.
    const readers = files.filter(([, text]) =>
      /\b(shownAdherence|scoredRate)\(/.test(text),
    );
    expect(readers.length).toBeGreaterThanOrEqual(5);
    const offenders = files
      .filter(([, text]) =>
        /\b(short|long)\.rate\b|compliance(7|30)\??\.rate\b|(?<!scoredRate\()med\.compliance(7|30)\b/.test(
          text,
        ),
      )
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });
});
