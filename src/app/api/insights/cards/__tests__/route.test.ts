import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Day-mean reads fold per-day aggregates in SQL; the fake folds the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    // The operator switches are read by nothing on this route any more; the
    // mock stays so a test can prove a switch-off changes nothing.
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    // v1.28 — PULSE now reads through the DAY-rollup read-swap
    // (`probeRollupCoverage` + `readDayMeanSeries`). An empty coverage
    // probe sends every test down the live-fallback branch, which itself
    // reads via the already-mocked `measurement.findMany` — no rollup
    // rows needed for these tests.
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

// The route no longer asks the `insights` module (the AI analysis opt-out);
// the mock stays so a test can prove it is never consulted.
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

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
import { requireModuleEnabled } from "@/lib/modules/gate";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    heightCm: null,
    dateOfBirth: null,
  } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  // v1.28 — empty coverage probe routes PULSE through the
  // live-fallback branch of `readDayMeanSeries`, which reads via the
  // already-mocked `measurement.findMany` above.
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/cards");
}

describe("GET /api/insights/cards — rule alerts are data", () => {
  it("answers 200 with every AI switch off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      assistantEnabled: false,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: false,
      assistantInsightStatusEnabled: false,
      assistantDocumentAiEnabled: false,
    } as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
  });

  it("answers 200 with the AI analysis opt-out on, without asking the module", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    expect(requireModuleEnabled).not.toHaveBeenCalled();
  });
});

describe("GET /api/insights/cards", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns an empty array when no data is available", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it("emits cards when measurements trigger alerts", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Provide enough sys + dia measurements to trigger danger-level alert.
    const now = new Date();
    const measurements: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let i = 0; i < 10; i++) {
      const at = new Date(now.getTime() - i * 86_400_000);
      measurements.push({
        type: "BLOOD_PRESSURE_SYS",
        value: 180,
        measuredAt: at,
      });
      measurements.push({
        type: "BLOOD_PRESSURE_DIA",
        value: 110,
        measuredAt: at,
      });
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(
      measurements as never,
    );
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        severity: string;
        provider: string;
        title: string;
        summary: string | null;
      }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    // The threshold engine wrote these, never a model: the provider says so
    // and no card ever carries null text (a native decoder needs both).
    for (const card of body.data) {
      expect(card.provider).toBe("rules");
      expect(typeof card.summary).toBe("string");
    }
    expect(body.data.some((c) => c.severity === "alert")).toBe(true);
  });

  it("reads PULSE through the day-rollup read-swap, never the manual raw-row query (perf)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    // 27 quiet days + 3 outlier days, one raw sample per day — a large
    // enough quiet cluster that the 3 outliers still clear the z-score > 2
    // threshold once folded into day means by the live-fallback branch of
    // `readDayMeanSeries` (a small n dilutes the mean/stddev too much for
    // the outliers to stand out).
    const pulseRows: Array<{ value: number; measuredAt: Date }> = [];
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      const at = new Date(now.getTime() - i * 86_400_000);
      pulseRows.push({ value: i < 3 ? 300 : 68, measuredAt: at });
    }

    vi.mocked(prisma.measurement.findMany).mockImplementation((async (args: {
      where?: { type?: unknown };
    }) => {
      // `readDayMeanSeries`'s live-fallback probes a single `type`
      // equality filter; the manual WEIGHT/BP query below probes an
      // `{ in: [...] }` list — the two calls are distinguishable by shape.
      if (args?.where?.type === "PULSE") return pulseRows;
      return [];
    }) as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ title: string; summary: string }>;
    };
    expect(
      body.data.some((c) => c.summary.includes("unusual pulse readings")),
    ).toBe(true);

    // The bounded manual-measurements query (WEIGHT / BP) must never ask
    // for PULSE — a dense wearable account's raw PULSE rows only ever
    // reach this route through the day-mean rollup read.
    const manualCall = vi
      .mocked(prisma.measurement.findMany)
      .mock.calls.find(
        (call) =>
          typeof (call[0] as { where?: { type?: { in?: unknown[] } } })?.where
            ?.type === "object",
      );
    expect(manualCall).toBeDefined();
    const typeIn = (manualCall?.[0] as { where: { type: { in: string[] } } })
      .where.type.in;
    expect(typeIn).not.toContain("PULSE");
  });

  it("does NOT flag a fully-adherent weekly injectable as low compliance (#214 regression)", async () => {
    // Pre-fix this path used a naive `schedules.length × 7` denominator, so a
    // weekly Monday injectable with its one dose taken computed ~14% and fired
    // a false "Low compliance" warning. The cadence-aware engine counts only
    // the Monday in the window → 100%, no alert.
    vi.useFakeTimers();
    // Pin NOW to a Wednesday so the trailing 7-day window holds exactly one
    // Monday (the prior 2025-01-13).
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
    try {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      vi.mocked(prisma.medication.findMany).mockResolvedValue([
        {
          id: "med-weekly",
          name: "Weekly injectable",
          dose: null,
          active: true,
          asNeeded: false,
          oneShot: false,
          startsOn: null,
          endsOn: null,
          createdAt: new Date("2024-06-01T00:00:00Z"),
          scheduleRevisions: [],
          pauseEras: [],
          schedules: [
            {
              id: "sched-mon",
              windowStart: "08:00",
              windowEnd: "10:00",
              daysOfWeek: "1",
              timesOfDay: ["08:30"],
              reminderGraceMinutes: null,
              rrule: "FREQ=WEEKLY;BYDAY=MO",
              rollingIntervalDays: null,
              scheduleType: "SCHEDULED",
              cyclicOnWeeks: null,
              cyclicOffWeeks: null,
              doseWindows: null,
            },
          ],
        },
      ] as never);
      vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
        {
          medicationId: "med-weekly",
          scheduledFor: new Date("2025-01-13T08:30:00Z"),
          takenAt: new Date("2025-01-13T08:35:00Z"),
          skipped: false,
        },
      ] as never);

      const res = await callGet(makeReq());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ title: string }>;
      };
      expect(body.data.some((c) => c.title.startsWith("Low compliance"))).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
