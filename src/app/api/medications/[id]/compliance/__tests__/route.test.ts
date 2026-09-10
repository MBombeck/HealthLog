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

// v1.15.20 — the route reads through the per-user compliance cache and a
// per-user rate limit. Pass-through mocks keep each test's fixture
// isolated (the real module-scope cache would leak state across tests);
// the rate-limit tests below flip `allowed` explicitly. v1.16.8 — the
// read is SWR (`cachedSwr`) and the ownership guard lives INSIDE the
// builder, so the pass-through exercises the guard on every call.
vi.mock("@/lib/cache/server-cache", () => ({
  cachedSwr: vi.fn(
    async (_cache: unknown, _key: string, builder: () => Promise<unknown>) =>
      builder(),
  ),
  caches: { medicationCompliance: {} },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
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
import { cachedSwr } from "@/lib/cache/server-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { userDayKey } from "@/lib/tz/format";

// UTC keeps the half-open day slice (`[dayStart, dayEnd)`) and the
// classifier's window anchor (`setUTCHours` on the day-start date) in the
// same reference frame, so the fixture instants below land deterministically
// in range regardless of the host timezone.
const TZ = "UTC";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    timezone: TZ,
  },
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
  // `resetAllMocks` clears the factory implementations — re-prime the
  // pass-through cache and the allowing rate limit for every test.
  vi.mocked(cachedSwr).mockImplementation(
    async (_cache: unknown, _key: string, builder: () => Promise<unknown>) =>
      builder(),
  );
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  });
});

async function callRoute(): Promise<Record<string, unknown>> {
  const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.dailyCompliance as Record<string, unknown>;
}

async function callRouteData(): Promise<Record<string, unknown>> {
  const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data as Record<string, unknown>;
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

  it("a 12h-late dose is an ad-hoc take + a missed 07:00 slot (band model)", async () => {
    // v1.15.18 — the heatmap now buckets the unified dose-history ledger. A
    // single 07:00 daily dose logged at 19:00 is 12h outside the 07:00 slot's
    // on-time band (±60min) AND its late tail (to ~10:00), so it is an AD-HOC
    // off-schedule take — a real logged dose (taken / on-time tone), NOT a
    // "very late" attribution onto the 07:00 slot. The 07:00 slot itself reads
    // missed (no intake inside its window past its cutoff). This is the audit's
    // intent: the cell no longer mislabels an off-schedule take as a punctuality
    // grade against a slot it never belonged to.
    const { start: dayStart } = dayBoundsForOffset(DAY_OFFSET);
    const dateKey = userDayKey(dayStart, TZ);

    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      medication([
        {
          id: "sched-1",
          windowStart: "07:00",
          windowEnd: "08:00",
          timesOfDay: [], // single-time daily: the minter mints a 07:00 band
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

    // Single 07:00 schedule, dose logged at 19:00 → outside every band → ad-hoc.
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
    // The off-schedule take reads as a logged dose; no late-attribution.
    expect(entry!.veryLate).toBe(0);
    expect(entry!.late).toBe(0);
    expect(entry!.onTime).toBe(1);
    expect(entry!.taken).toBe(1);
    // The 07:00 slot itself is missed (uncovered, past its cutoff).
    // expected = the missed slot + the ad-hoc take's own slot.
    expect(entry!.expected).toBe(2);
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

// v1.8.6 — the `complianceDisplay` block is always two percentage rows; the
// server scales the two windows to the dosing cadence. A daily med keeps
// 7 / 30 days; a sparse rolling med steps both windows up to the widest rung.
// The existing `compliance7` / `compliance30` fields stay untouched.
describe("GET /api/medications/[id]/compliance — complianceDisplay", () => {
  it("daily med → 7 / 30-day windows", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      medication([
        {
          id: "sched-1",
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00"],
          daysOfWeek: null,
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
          reminderGraceMinutes: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
        },
      ]) as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );

    const data = await callRouteData();
    const display = data.complianceDisplay as {
      shortDays: number;
      longDays: number;
      expectedLong: number;
      minStableDoses: number;
      short: { rate: number; streak: number };
      long: { rate: number };
    };
    expect(display.shortDays).toBe(7);
    expect(display.longDays).toBe(30);
    expect(display.expectedLong).toBeGreaterThanOrEqual(display.minStableDoses);
    expect(display.short).toBeDefined();
    expect(display.long).toBeDefined();
    // No timeline field — the display is two rows only.
    expect(display).not.toHaveProperty("mode");
    // The legacy fields stay on the wire.
    expect(data.compliance7).toBeDefined();
    expect(data.compliance30).toBeDefined();
  });

  it("35-day-interval med → steps the windows up past 7 / 30 days", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      startsOn: new Date(Date.now() - 380 * 24 * 60 * 60 * 1000),
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          id: "sched-1",
          windowStart: "10:00",
          windowEnd: "11:00",
          timesOfDay: ["10:00"],
          daysOfWeek: null,
          rrule: null,
          rollingIntervalDays: 35,
          reminderGraceMinutes: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
        },
      ],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        takenAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000),
        skipped: false,
        scheduledFor: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000),
      },
    ] as never);

    const data = await callRouteData();
    const display = data.complianceDisplay as {
      shortDays: number;
      longDays: number;
    };
    // A 35-day cadence can't clear four expected doses in a 30-day window, so
    // the ladder steps the short window beyond 7 days and the long beyond 30.
    expect(display.shortDays).toBeGreaterThan(7);
    expect(display.longDays).toBeGreaterThan(30);
  });
});

// v1.15.20 — server cache + bounded event read + per-user rate limit.
describe("GET /api/medications/[id]/compliance — caching and limits", () => {
  function mockDailyMed() {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      medication([
        {
          id: "sched-1",
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00"],
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
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
  }

  it("returns 429 when the per-user rate limit is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
    expect(res.status).toBe(429);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(
      "medication-compliance:user-1",
      60,
      60_000,
    );
    // The limited request never touches the medication tables.
    expect(prisma.medication.findUnique).not.toHaveBeenCalled();
  });

  it("reads through the per-user compliance cache key", async () => {
    mockDailyMed();

    const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    expect(vi.mocked(cachedSwr)).toHaveBeenCalledTimes(1);
    const [, key] = vi.mocked(cachedSwr).mock.calls[0];
    // `${userId}|...` prefix is what `invalidateUserMedications` sweeps.
    // The trailing tz segment (v1.16.1) makes a timezone change miss the
    // old entry instead of serving day buckets computed for the prior zone.
    expect(key).toBe("user-1|med-1|compliance|UTC");
  });

  it("bounds the intake-event read to a trailing window and the consumed columns", async () => {
    mockDailyMed();

    const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    const call = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0] as {
      where: { scheduledFor?: { gte?: Date } };
      select?: Record<string, boolean>;
    };
    // Lower-bounded: the widest served window is 365 days (+1 day margin).
    const gte = call.where.scheduledFor?.gte;
    expect(gte).toBeInstanceOf(Date);
    const minExpected = Date.now() - 367 * 24 * 60 * 60 * 1000;
    expect((gte as Date).getTime()).toBeGreaterThan(minExpected);
    // Column-bounded: only the five fields the math consumes
    // (v1.15.20 adds the slot-binding provenance for pinned takes).
    expect(call.select).toEqual({
      takenAt: true,
      skipped: true,
      scheduledFor: true,
      autoMissed: true,
      attributionSource: true,
    });
  });
});

// v1.16.8 — the ownership guard + medication read moved INSIDE the cache
// builder: the key is `${userId}|${medicationId}|…`, so a warm hit is by
// construction a payload this caller built for a medication they own, and
// the pre-cache session→rate-limit path no longer pays two row reads per
// card. The guard itself still runs on every cold build.
describe("GET /api/medications/[id]/compliance — ownership inside the builder", () => {
  it("returns the sealed 404 when the medication belongs to another user", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      ...medication([]),
      userId: "user-2",
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );

    const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
    expect(res.status).toBe(404);
    const body = await res.json();
    // Same envelope as the absent case — the existence channel stays sealed.
    expect(body.error).toBe("Medication not found");
  });

  it("returns the sealed 404 when the medication does not exist", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(null as never);

    const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Medication not found");
  });

  it("never touches the medication tables on a warm cache hit", async () => {
    // Simulate a warm cell: the SWR read resolves without invoking the
    // builder, so neither the medication nor the intake table is read.
    vi.mocked(cachedSwr).mockResolvedValue({
      compliance7: { rate: 100 },
      compliance30: { rate: 100 },
      dailyCompliance: {},
      complianceDisplay: { shortDays: 7, longDays: 30 },
    } as never);

    const res = await GET(new Request("http://localhost"), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect(prisma.medication.findUnique).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });
});
