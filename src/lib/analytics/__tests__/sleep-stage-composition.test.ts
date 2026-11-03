import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The last test in this file drives the REAL `GET /api/sleep/night` handler so
// the two surfaces can be compared over one input rather than over one fixture
// used twice. The mocks below are the minimum that route needs.
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/tz/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tz/resolver")>();
  return { ...actual, resolveUserTimezone: vi.fn(async () => "UTC") };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET as sleepNightGET } from "@/app/api/sleep/night/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { buildSleepStageComposition } from "@/lib/analytics/sleep-stage-composition";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function row(iso: string, stage: string, minutes: number): SleepStageRow {
  return {
    measuredAt: new Date(iso),
    sleepStage: stage as SleepStageRow["sleepStage"],
    value: minutes,
    source: "APPLE_HEALTH" as SleepStageRow["source"],
  };
}

/**
 * One overnight block: 23:00 (Jun 3) → 07:00 (Jun 4) UTC, written as the
 * per-stage rows Apple Health produces. Wake day = 2026-06-04.
 *
 *   CORE  240  23:00 → 03:00
 *   DEEP   90  03:00 → 04:30
 *   REM    80  04:30 → 05:50
 *   AWAKE  20  05:50 → 06:10
 *   CORE   50  06:10 → 07:00
 *
 * Asleep = 460, CORE = 290, in bed = 480.
 */
const NIGHT_ROWS: SleepStageRow[] = [
  row("2026-06-04T07:00:00.000Z", "IN_BED", 480),
  row("2026-06-04T03:00:00.000Z", "CORE", 240),
  row("2026-06-04T04:30:00.000Z", "DEEP", 90),
  row("2026-06-04T05:50:00.000Z", "REM", 80),
  row("2026-06-04T06:10:00.000Z", "AWAKE", 20),
  row("2026-06-04T07:00:00.000Z", "CORE", 50),
];

/**
 * A 110-minute afternoon nap on the SAME wake day: 14:00 → 15:50 UTC. Seven
 * hours clear of the night's 07:00 wake, so it clusters as its own session.
 *
 * Deliberately large and deliberately CORE — folded into the night it moves
 * that night's CORE from 290 to 400, which no rounding or tolerance can hide.
 */
const NAP_ROWS: SleepStageRow[] = [
  row("2026-06-04T15:50:00.000Z", "CORE", 110),
];

const DAY = "2026-06-04";

describe("buildSleepStageComposition", () => {
  it("keeps an afternoon nap out of the night's stage composition", () => {
    const rows = [...NIGHT_ROWS, ...NAP_ROWS];

    // What the per-wake-day totals say — the shape this surface used to
    // publish. The nap's CORE is inside the night.
    const folded = reconstructSleepNights(rows, "UTC", null);
    expect(folded).toHaveLength(1);
    expect(folded[0].stages.CORE).toBe(400);

    const composition = buildSleepStageComposition(rows, "UTC", null, 30);
    expect(composition).not.toBeNull();
    expect(composition!.perNight).toHaveLength(1);

    const night = composition!.perNight[0];
    expect(night.dayKey).toBe(DAY);
    // The night's own CORE, not the night plus the nap.
    expect(night.stages.CORE).toBe(290);
    expect(night.stages.DEEP).toBe(90);
    expect(night.stages.REM).toBe(80);
    expect(night.stages.AWAKE).toBe(20);
    // The nap is reported, separately, at its full length.
    expect(night.napMinutes).toBe(110);
    expect(night.napCount).toBe(1);

    // The window aggregate follows the nights, so it is not inflated either.
    expect(composition!.stages.CORE).toBe(290);
    expect(composition!.nights).toBe(1);
  });

  it("leaves a night without a nap exactly as it was", () => {
    // `reconstructSleepNights` is the path this surface used before the
    // split. On a day with no nap the new path must reproduce it exactly.
    const before = reconstructSleepNights(NIGHT_ROWS, "UTC", null);
    expect(before).toHaveLength(1);

    const composition = buildSleepStageComposition(NIGHT_ROWS, "UTC", null, 30);
    expect(composition).not.toBeNull();
    expect(composition!.perNight).toHaveLength(1);

    const night = composition!.perNight[0];
    expect(night.dayKey).toBe(before[0].night);
    expect(night.stages).toEqual(before[0].stages);
    expect(composition!.stages).toEqual(before[0].stages);
    expect(composition!.totalMinutes).toBe(
      Object.values(before[0].stages).reduce((a, b) => a + (b ?? 0), 0),
    );

    // No nap means no nap fields at all — nothing for the chart to draw and
    // nothing to caption.
    expect(night).not.toHaveProperty("napMinutes");
    expect(night).not.toHaveProperty("napCount");
  });
});

describe("night view and stage composition agree on which session is the night", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  });

  it("publishes the same night and the same nap total over one input", async () => {
    const rows = [...NIGHT_ROWS, ...NAP_ROWS];
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    // Surface 1 — the real hypnogram route, which has always known the
    // difference between a night and a nap.
    const res = await sleepNightGET(
      new NextRequest(`http://localhost/api/sleep/night?date=${DAY}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        night: string;
        main: { stages: Record<string, number>; asleepMinutes: number };
        naps: Array<{ asleepMinutes: number }>;
      };
    };

    // Surface 2 — the stage composition, over the very same rows.
    const composition = buildSleepStageComposition(rows, "UTC", null, 30);
    expect(composition).not.toBeNull();
    const night = composition!.perNight.find(
      (n) => n.dayKey === body.data.night,
    );
    expect(night).toBeDefined();

    // The composition's night IS the route's main session: same wake day,
    // same per-stage map, minute for minute.
    const routeStages = body.data.main.stages;
    const compositionStages = Object.fromEntries(
      Object.entries(night!.stages).map(([stage, minutes]) => [
        stage,
        Math.round(minutes),
      ]),
    );
    expect(compositionStages).toEqual(routeStages);

    // And the nap the composition reports is the nap the route reports —
    // the same count, and the same minutes the route publishes for it.
    expect(body.data.naps).toHaveLength(1);
    expect(night!.napCount).toBe(body.data.naps.length);
    expect(night!.napMinutes).toBe(
      body.data.naps.reduce((sum, nap) => sum + nap.asleepMinutes, 0),
    );

    // Guard against both surfaces agreeing on a wrong answer: the nap is
    // real, large, and outside the night on both sides.
    expect(body.data.naps[0].asleepMinutes).toBe(110);
    expect(compositionStages.CORE).toBe(290);
  });
});
