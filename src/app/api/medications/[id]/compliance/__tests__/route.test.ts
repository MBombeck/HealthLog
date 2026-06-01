/**
 * v1.8.1 B15 follow-on — per-slot timing classification for the History
 * compliance heatmap.
 *
 * The `dailyCompliance` builder in `GET /api/medications/[id]/compliance`
 * classifies each taken intake into early / on_time / late / very_late
 * buckets and paints the heatmap cell off those counts. The bug: a
 * twice-daily medication stored as ONE schedule row
 * (`timesOfDay = ["07:00","19:00"]`, `windowStart = "07:00"`) matched the
 * 19:00 dose against the single `windowStart` "07:00" — classifying a
 * perfectly on-time evening dose as `very_late` (~12h late) and painting
 * the cell orange even though both doses were taken on time.
 *
 * The fix matches each taken event to the closest effective time-of-day
 * SLOT across every schedule (candidate slots = `timesOfDay` when
 * non-empty, else `[windowStart]`) and classifies against that slot's
 * window (slot..slot+span, span = windowEnd − windowStart). Single-time
 * schedules stay byte-identical to the pre-fix behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { getUserTodayBounds } from "@/lib/timezone";
import { userDayKey } from "@/lib/tz/format";

// UTC keeps the half-open day slice (`[dayStart, dayEnd)`) and the
// classifier's window anchor (`setUTCHours` on the day-start date) in the
// same reference frame, so the fixture instants below land deterministically
// in range regardless of the host timezone.
const TZ = "UTC";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const, timezone: TZ },
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

// A representative "yesterday" so the day is fully in the past and the
// medication's createdAt clearly precedes it. The route walks 90 days
// back from `new Date()`; this instant lands well inside that window.
const DAY_OFFSET = 1;
function dayBoundsForOffset(offset: number) {
  const now = new Date();
  const representative = new Date(
    now.getTime() - offset * 24 * 60 * 60 * 1000 - 12 * 60 * 60 * 1000,
  );
  const { start, end } = getUserTodayBounds(representative, TZ);
  return { start, endInclusive: end };
}

// Build a UTC instant for a given "HH:mm" anchored on the day-start date,
// mirroring how `classifyIntakeTiming` interprets the window via
// `setUTCHours` on the scheduled date. Keeps the fixture's takenAt aligned
// with the classifier's reference frame regardless of host timezone.
function atSlotUTC(dayStart: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dayStart);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

function medication(schedules: unknown[]) {
  return {
    id: "med-1",
    userId: "user-1",
    createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    startsOn: null,
    endsOn: null,
    oneShot: false,
    schedules,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

async function callRoute(): Promise<Record<string, unknown>> {
  const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.dailyCompliance as Record<string, unknown>;
}

describe("GET /api/medications/[id]/compliance — per-slot timing", () => {
  it("classifies both doses of a single-row twice-daily schedule as on_time (green cell)", async () => {
    const { start: dayStart } = dayBoundsForOffset(DAY_OFFSET);
    const dateKey = userDayKey(dayStart, TZ);

    // ONE schedule row, two times-of-day, a 1h window per slot.
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      medication([
        {
          id: "sched-1",
          windowStart: "07:00",
          windowEnd: "08:00",
          timesOfDay: ["07:00", "19:00"],
          daysOfWeek: null,
          rrule: null,
          rollingIntervalDays: null,
          reminderGraceMinutes: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
        },
      ]) as never,
    );

    // Both doses logged right at their slot times.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        takenAt: atSlotUTC(dayStart, "07:05"),
        skipped: false,
        scheduledFor: atSlotUTC(dayStart, "07:00"),
      },
      {
        takenAt: atSlotUTC(dayStart, "19:05"),
        skipped: false,
        scheduledFor: atSlotUTC(dayStart, "19:00"),
      },
    ] as never);

    const daily = await callRoute();
    const entry = daily[dateKey] as Record<string, number> | undefined;
    expect(entry).toBeDefined();
    expect(entry!.veryLate).toBe(0);
    expect(entry!.late).toBe(0);
    // Both doses compliant → green cell.
    expect(entry!.onTime).toBe(2);
  });

  it("keeps single-time schedules byte-identical: a 12h-late dose is still very_late", async () => {
    const { start: dayStart } = dayBoundsForOffset(DAY_OFFSET);
    const dateKey = userDayKey(dayStart, TZ);

    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      medication([
        {
          id: "sched-1",
          windowStart: "07:00",
          windowEnd: "08:00",
          timesOfDay: [], // single-time: candidate = [windowStart]
          daysOfWeek: null,
          rrule: null,
          rollingIntervalDays: null,
          reminderGraceMinutes: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
        },
      ]) as never,
    );

    // Single 07:00 schedule, dose taken at 19:00 → ~12h late → very_late.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        takenAt: atSlotUTC(dayStart, "19:00"),
        skipped: false,
        scheduledFor: atSlotUTC(dayStart, "07:00"),
      },
    ] as never);

    const daily = await callRoute();
    const entry = daily[dateKey] as Record<string, number> | undefined;
    expect(entry).toBeDefined();
    expect(entry!.veryLate).toBe(1);
    expect(entry!.onTime).toBe(0);
    expect(entry!.late).toBe(0);
  });

  it("handles an overnight per-slot window (23:00 slot, 1h span) as on_time near the slot", async () => {
    const { start: dayStart } = dayBoundsForOffset(DAY_OFFSET);
    const dateKey = userDayKey(dayStart, TZ);

    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      medication([
        {
          id: "sched-1",
          windowStart: "23:00",
          windowEnd: "00:00", // overnight: end <= start
          timesOfDay: ["09:00", "23:00"],
          daysOfWeek: null,
          rrule: null,
          rollingIntervalDays: null,
          reminderGraceMinutes: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
        },
      ]) as never,
    );

    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        takenAt: atSlotUTC(dayStart, "23:10"),
        skipped: false,
        scheduledFor: atSlotUTC(dayStart, "23:00"),
      },
    ] as never);

    const daily = await callRoute();
    const entry = daily[dateKey] as Record<string, number> | undefined;
    expect(entry).toBeDefined();
    expect(entry!.veryLate).toBe(0);
    expect(entry!.late).toBe(0);
    expect(entry!.onTime).toBe(1);
  });
});
