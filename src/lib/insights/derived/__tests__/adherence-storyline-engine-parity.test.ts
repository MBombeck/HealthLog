/**
 * v1.26.0 — the adherence storyline must read the SAME
 * schedule-anchored, cadence-aware adherence number the dashboard tile does.
 *
 * The regression this pins: the storyline used to derive its adherence % from
 * `readMedicationCompliance`, the RAW coverage rollup whose `scheduled` counts
 * LOGGED intake slots. A user who logs only the doses they TOOK — never
 * minting `takenAt:null` reminder rows for the doses they missed — therefore
 * read ~100 % adherence (every logged row was both numerator and denominator),
 * and the dip gate (`adherencePct > 80 → null`) wrongly suppressed the whole
 * storyline. Anchoring on the recurrence engine's EXPECTED-dose count makes the
 * missed days pull the rate below 100 %.
 *
 * The real compliance engine (`@/lib/analytics/compliance`) and the shared
 * `buildScheduleAnchoredComplianceBuckets` run unmocked here — only the DB and
 * the vital-series reader are stubbed — so the test exercises the actual
 * expected-dose expansion, not a re-mock of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  medicationFindMany: vi.fn(),
  intakeFindMany: vi.fn(),
  probeRollupCoverage: vi.fn(),
  readDayMeanSeries: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: mocks.medicationFindMany },
    medicationIntakeEvent: { findMany: mocks.intakeFindMany },
  },
}));

vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: mocks.probeRollupCoverage,
}));

vi.mock("@/lib/insights/derived/baseline", () => ({
  readDayMeanSeries: mocks.readDayMeanSeries,
}));

import { buildAdherenceStoryline } from "@/lib/insights/derived/adherence-storyline";
import { buildScheduleAnchoredComplianceBuckets } from "@/lib/analytics/schedule-anchored-compliance";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-06-21T12:00:00.000Z");
const TZ = "UTC";

/** A legacy daily schedule — one expected dose/day at 08:00, every day. */
const dailySchedule = {
  id: "sched-1",
  windowStart: "08:00",
  windowEnd: "09:00",
  daysOfWeek: null,
  timesOfDay: [],
  rrule: null,
  rollingIntervalDays: null,
  reminderGraceMinutes: null,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
  doseWindows: null,
};

const medication = {
  id: "med-1",
  name: "ramipril",
  treatmentClass: "GENERIC",
  active: true,
  oneShot: false,
  startsOn: null,
  endsOn: null,
  // Created well before the window so no day is skipped for being pre-creation.
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  schedules: [dailySchedule],
  scheduleRevisions: [],
  pauseEras: [],
};

/** ISO 08:00 on a given YYYY-MM-DD. */
const at8 = (day: string) => new Date(`${day}T08:00:00.000Z`);

beforeEach(() => {
  mocks.medicationFindMany.mockReset();
  mocks.intakeFindMany.mockReset();
  mocks.probeRollupCoverage.mockReset();
  mocks.readDayMeanSeries.mockReset();

  // The same medication row satisfies both call sites: the storyline's
  // `select: { name, treatmentClass }` and the engine's `include: {...}`.
  mocks.medicationFindMany.mockResolvedValue([medication]);

  // Only-taken intakes: 7 taken doses across 14 scheduled days. The 7 missed
  // days carry NO row at all (the user never minted a takenAt:null miss row).
  const takenDays = [
    "2026-06-08",
    "2026-06-10",
    "2026-06-12",
    "2026-06-14",
    "2026-06-16",
    "2026-06-18",
    "2026-06-20",
  ];
  mocks.intakeFindMany.mockResolvedValue(
    takenDays.map((d) => ({
      medicationId: "med-1",
      scheduledFor: at8(d),
      takenAt: new Date(`${d}T08:05:00.000Z`),
      skipped: false,
      autoMissed: false,
    })),
  );

  mocks.probeRollupCoverage.mockResolvedValue(new Map());

  // Vital before/after: 8 prior days ~124, 8 recent days ~134 — a material
  // move on a ~7.4 robust spread, so a storyline is produced once the dip
  // gate lets it through.
  const priorDays: { day: string; mean: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(
      new Date("2026-05-25T00:00:00.000Z").getTime() + i * DAY_MS,
    );
    priorDays.push({ day: d.toISOString().slice(0, 10), mean: 124 });
  }
  const recentDays: { day: string; mean: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(
      new Date("2026-06-08T00:00:00.000Z").getTime() + i * DAY_MS,
    );
    recentDays.push({ day: d.toISOString().slice(0, 10), mean: 134 });
  }
  mocks.readDayMeanSeries.mockResolvedValue({
    points: [...priorDays, ...recentDays],
    source: "live",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adherence storyline ↔ dashboard-tile engine parity", () => {
  it("derives adherence from the schedule-anchored engine (missed doses pull it below 100)", async () => {
    // The dashboard-tile number, straight from the shared engine.
    const buckets = await buildScheduleAnchoredComplianceBuckets(
      "user-1",
      14,
      TZ,
      NOW,
    );
    let scheduled = 0;
    let taken = 0;
    for (const b of buckets) {
      if (b.scheduled > 0) {
        scheduled += b.scheduled;
        taken += b.taken;
      }
    }
    // Sanity: 14 expected days, 7 taken → genuinely below 100 %. The raw
    // coverage rollup would have read scheduled == taken == 7 → 100 %.
    expect(scheduled).toBeGreaterThan(taken);
    const dashboardPct = (100 * taken) / scheduled;
    expect(dashboardPct).toBeLessThan(100);

    // The storyline must surface (the dip gate no longer wrongly suppresses it)
    // and its adherence number must equal the dashboard-tile number.
    const story = await buildAdherenceStoryline("user-1", TZ, NOW);
    expect(story).not.toBeNull();
    expect(story!.adherencePct).toBeLessThan(100);
    expect(story!.adherencePct).toBe(Math.round(dashboardPct));
  });

  it("still suppresses the storyline when adherence is genuinely high (dip gate honoured)", async () => {
    // Log a taken dose on EVERY one of the 14 scheduled days → ~100 %.
    const allDays: { day: string }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(NOW.getTime() - i * DAY_MS);
      allDays.push({ day: d.toISOString().slice(0, 10) });
    }
    mocks.intakeFindMany.mockResolvedValue(
      allDays.map(({ day }) => ({
        medicationId: "med-1",
        scheduledFor: at8(day),
        takenAt: new Date(`${day}T08:05:00.000Z`),
        skipped: false,
        autoMissed: false,
      })),
    );

    const story = await buildAdherenceStoryline("user-1", TZ, NOW);
    // High adherence → the dip gate (adherencePct > 80) returns null.
    expect(story).toBeNull();
  });
});

describe("adherence storyline course window", () => {
  it("keeps a course on its last day in the user's zone", async () => {
    // 2026-06-21 20:00 in Los Angeles, already the 22nd in UTC. A course
    // whose `endsOn` (a calendar date) is the 21st is still running.
    const now = new Date("2026-06-22T03:00:00.000Z");
    await buildAdherenceStoryline("user-1", "America/Los_Angeles", now);
    const where = mocks.medicationFindMany.mock.calls[0]![0].where as {
      OR: [unknown, { endsOn: { gte: Date } }];
    };
    const lastDay = new Date("2026-06-21T00:00:00.000Z"); // @db.Date value
    expect(where.OR[1].endsOn.gte.getTime()).toBeLessThanOrEqual(
      lastDay.getTime(),
    );
    expect(where.OR[1].endsOn.gte.toISOString()).toBe(lastDay.toISOString());
  });

  it("leaves out a course ended with End course on its last day (#1280)", async () => {
    await buildAdherenceStoryline(
      "user-1",
      "UTC",
      new Date("2026-06-21T12:00:00.000Z"),
    );
    // The candidate read is the one that bounds the window by `endsOn`.
    const where = mocks.medicationFindMany.mock.calls
      .map(([args]) => (args as { where?: Record<string, unknown> }).where)
      .reverse()
      .find((w) => w && "OR" in w);
    expect(where).toHaveProperty("endedAt", null);
  });
});
