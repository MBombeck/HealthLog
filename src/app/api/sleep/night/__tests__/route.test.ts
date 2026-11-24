import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
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

// v1.18.0 — pin the sleep module gate to "enabled" so this suite stays
// focused on the hypnogram read; the gate itself is covered by the module
// gate + route-gate-inventory suites.
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
  isModuleEnabled: vi.fn(async () => true),
}));

// The latest-night walk pages nights in SQL; its own behaviour is pinned by
// the SQL parity integration suite. Here it is stubbed to a fixed day so the
// route's "no date" arm can be read.
vi.mock("@/lib/measurements/list/sleep-nights", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/measurements/list/sleep-nights")
    >();
  return { ...actual, latestMainSleepNight: vi.fn(async () => null) };
});

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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { latestMainSleepNight } from "@/lib/measurements/list/sleep-nights";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { Prisma } from "@/generated/prisma/client";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function signIn(): void {
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
}

function withStages(rows: ReturnType<typeof stage>[]): void {
  vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);
}

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/sleep/night?${query}`);
}

function stage(
  iso: string,
  s: string,
  minutes: number,
  source = "APPLE_HEALTH",
) {
  return {
    value: minutes,
    measuredAt: new Date(iso),
    sleepStage: s,
    source,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
});

/** One folded row of the overlay read. */
function bucket(
  type: string,
  source: string,
  idx: number | null,
  value: number,
) {
  return {
    type,
    source,
    idx,
    n: 1,
    sum: value,
    min_value: value,
    max_value: value,
  };
}

/** The measurement types the overlay read asked for. */
function overlayTypesRead(): string[] {
  const sql = vi.mocked(prisma.$queryRaw).mock
    .calls[0]![0] as unknown as Prisma.Sql;
  return sql.values.filter(
    (v): v is string => typeof v === "string" && /^[A-Z_]+$/.test(v),
  );
}

describe("GET /api/sleep/night", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req(""));
    expect(res.status).toBe(401);
  });

  it("422s on a malformed date", async () => {
    signIn();
    const res = await GET(req("date=2026-13-40"));
    expect(res.status).toBe(422);
  });

  it("returns the requested night's hypnogram segments", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      stage("2026-06-04T01:00:00.000Z", "CORE", 240),
      stage("2026-06-04T03:00:00.000Z", "DEEP", 120),
      stage("2026-06-04T05:00:00.000Z", "REM", 120),
      stage("2026-06-04T05:00:00.000Z", "IN_BED", 510),
    ] as never);
    const res = await GET(req("date=2026-06-04"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.night).toBe("2026-06-04");
    expect(body.data.main.asleepMinutes).toBe(480);
    expect(body.data.main.inBedMinutes).toBe(510);
    // Segments carry absolute start/end spans (start = end − duration).
    const core = body.data.main.segments.find(
      (seg: { stage: string }) => seg.stage === "CORE",
    );
    expect(core.start).toBe("2026-06-03T21:00:00.000Z");
    expect(core.end).toBe("2026-06-04T01:00:00.000Z");
  });

  it("rounds asleep / awake minutes to whole numbers", async () => {
    // iOS #18 — `asleepMinutesOf` / awake totals sum raw second-precision
    // minute values, so a night sums to e.g. 433.4999; the serializer must
    // emit whole minutes. CORE+DEEP = 433.4999 → 433; AWAKE 12.6 → 13.
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      stage("2026-06-04T03:00:00.000Z", "CORE", 300.25),
      stage("2026-06-04T05:00:00.000Z", "DEEP", 133.2499),
      stage("2026-06-04T05:10:00.000Z", "AWAKE", 12.6),
    ] as never);
    const res = await GET(req("date=2026-06-04"));
    const body = await res.json();
    expect(body.data.main.asleepMinutes).toBe(433);
    expect(body.data.main.awakeMinutes).toBe(13);
    expect(Number.isInteger(body.data.main.asleepMinutes)).toBe(true);
    expect(Number.isInteger(body.data.main.awakeMinutes)).toBe(true);
  });

  it("defaults to the latest main night when date omitted", async () => {
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      stage("2026-06-02T03:00:00.000Z", "CORE", 200),
      stage("2026-06-04T03:00:00.000Z", "CORE", 300),
    ] as never);
    vi.mocked(latestMainSleepNight).mockResolvedValueOnce("2026-06-04");
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.data.night).toBe("2026-06-04");
    expect(body.data.main.asleepMinutes).toBe(300);
  });

  it("reads a night of any age from a day and a half either side of it", async () => {
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      stage("2019-03-01T06:00:00.000Z", "CORE", 420),
    ] as never);
    const res = await GET(req("date=2019-03-01"));
    const body = await res.json();
    // Years past any trailing window, the night is still served.
    expect(body.data.main.asleepMinutes).toBe(420);
    const where = vi.mocked(prisma.measurement.findMany).mock.calls[0][0]!
      .where as { AND: Array<{ measuredAt: { gte: Date; lte: Date } }> };
    expect(where.AND[0].measuredAt.gte.toISOString()).toBe(
      "2019-02-27T12:00:00.000Z",
    );
    expect(where.AND[0].measuredAt.lte.toISOString()).toBe(
      "2019-03-03T12:00:00.000Z",
    );
  });

  it("answers a day of naps alone with its naps and no main night", async () => {
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      // 13:00 to 14:00 UTC, nothing overnight.
      stage("2026-06-04T14:00:00.000Z", "CORE", 60),
    ] as never);
    const res = await GET(req("date=2026-06-04"));
    const body = await res.json();
    expect(body.data.night).toBe("2026-06-04");
    expect(body.data.main).toBeNull();
    expect(body.data.naps).toHaveLength(1);
    expect(body.data.naps[0].asleepMinutes).toBe(60);
  });

  it("surfaces a daytime nap separately from the main night", async () => {
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      // Nap on Jun 4 (12:00 → 12:40 UTC).
      stage("2026-06-04T12:40:00.000Z", "CORE", 40),
      // Overnight ending Jun 4 morning.
      stage("2026-06-04T01:00:00.000Z", "CORE", 240),
      stage("2026-06-04T05:00:00.000Z", "DEEP", 240),
    ] as never);
    const res = await GET(req("date=2026-06-04"));
    const body = await res.json();
    expect(body.data.main.asleepMinutes).toBe(480);
    expect(body.data.naps).toHaveLength(1);
    expect(body.data.naps[0].asleepMinutes).toBe(40);
  });

  it("returns a null main when the night has no asleep minutes", async () => {
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const res = await GET(req("date=2026-06-04"));
    const body = await res.json();
    expect(body.data.main).toBeNull();
    expect(body.data.naps).toEqual([]);
  });

  // A reconstruction edge (a session of only bare ASLEEP / stage-less rows
  // alongside a granular partition for the same span) must return a valid empty
  // night, NEVER a 500 from the unguarded `segments[0]` access.
  it("returns 200 + empty night on an IN_BED/AWAKE-only reconstruction, never 500", async () => {
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      stage("2026-06-04T06:00:00.000Z", "IN_BED", 60),
      stage("2026-06-04T06:00:00.000Z", "AWAKE", 60),
    ] as never);
    const res = await GET(req("date=2026-06-04"));
    expect(res.status).toBe(200); // not 500
    const body = await res.json();
    expect(body.data.main).toBeNull();
    expect(body.data.naps).toEqual([]);
  });

  it("returns 200 on a bare ASLEEP + stage-less + granular mix, never 500", async () => {
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      stage("2026-06-04T02:00:00.000Z", "DEEP", 1),
      stage("2026-06-04T06:00:00.000Z", "ASLEEP", 480),
      // stage-less twin (sleepStage: null) for the same span.
      {
        value: 480,
        measuredAt: new Date("2026-06-04T06:00:00.000Z"),
        sleepStage: null,
        source: "APPLE_HEALTH",
      },
    ] as never);
    const res = await GET(req("date=2026-06-04"));
    expect(res.status).toBe(200); // never 500 on the reconstruction edge
  });
  it("cannot serve an in-bed headline that contradicts its stage legend", async () => {
    // A device wrote the same night twice: an envelope 16:06 -> 02:09:59 and
    // a corrected one 16:06 -> 02:18:59. Raw-summing them served a 613-minute
    // headline next to a 1217-minute legend on the same screen.
    signIn();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      stage("2026-07-25T02:09:59.000Z", "IN_BED", 603 + 59 / 60),
      stage("2026-07-25T02:18:59.000Z", "IN_BED", 612 + 59 / 60),
      stage("2026-07-24T21:55:42.000Z", "CORE", 319.7),
      stage("2026-07-24T23:30:36.000Z", "DEEP", 94.9),
      stage("2026-07-24T23:37:31.200Z", "AWAKE", 6.92),
      stage("2026-07-25T01:53:25.200Z", "REM", 135.9),
    ] as never);
    const res = await GET(req("date=2026-07-25"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.main.inBedMinutes).toBe(613);
    expect(body.data.main.stages.IN_BED).toBe(613);
    // One in-bed bar on the hypnogram, not the night drawn twice over.
    expect(
      body.data.main.segments.filter(
        (seg: { stage: string }) => seg.stage === "IN_BED",
      ),
    ).toHaveLength(1);
    expect(body.data.main.stages.CORE).toBe(320);
    expect(body.data.main.asleepMinutes).toBe(551);
  });

  describe("overlays (#1419)", () => {
    const NIGHT = [
      stage("2026-06-04T01:00:00.000Z", "CORE", 240),
      stage("2026-06-04T03:00:00.000Z", "DEEP", 120),
      stage("2026-06-04T05:00:00.000Z", "REM", 120),
    ];

    it("lays the night's metrics on a grid from 15 minutes before the night", async () => {
      signIn();
      withStages(NIGHT);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        bucket("PULSE", "APPLE_HEALTH", 3, 62),
        bucket("PULSE", "APPLE_HEALTH", 4, 58),
        bucket("PULSE", "GARMIN", 3, 70),
        bucket("PULSE", "GARMIN", 4, 71),
        bucket("HRV_RMSSD", "GARMIN", null, 44),
      ]);
      const res = await GET(req("date=2026-06-04"));
      expect(res.status).toBe(200);
      const { overlays, main } = (await res.json()).data;
      expect(main.start).toBe("2026-06-03T21:00:00.000Z");
      expect(overlays.from).toBe("2026-06-03T20:45:00.000Z");
      expect(overlays.to).toBe("2026-06-04T05:15:00.000Z");
      expect(overlays.bucketMinutes).toBe(5);
      const pulse = overlays.metrics.find(
        (m: { kind: string }) => m.kind === "pulse",
      );
      // The night is Apple Health's, so its pulse is too.
      expect(pulse.source).toBe("APPLE_HEALTH");
      expect(pulse.points.map((p: { at: string }) => p.at)).toEqual([
        "2026-06-03T21:00:00.000Z",
        "2026-06-03T21:05:00.000Z",
      ]);
      expect(pulse.summary).toEqual({ min: 58, max: 62, avg: 60 });
      const hrv = overlays.metrics.find(
        (m: { kind: string }) => m.kind === "hrv",
      );
      expect(hrv).toMatchObject({ nightValue: 44, points: [], summary: null });
    });

    it("serves no overlay on a night of stage totals, and reads none", async () => {
      signIn();
      // Every total stamped on the wake instant: no order, no timeline.
      withStages([
        stage("2026-06-04T05:00:00.000Z", "CORE", 240, "WHOOP"),
        stage("2026-06-04T05:00:00.000Z", "DEEP", 90, "WHOOP"),
        stage("2026-06-04T05:00:00.000Z", "REM", 100, "WHOOP"),
      ]);
      const res = await GET(req("date=2026-06-04"));
      const body = await res.json();
      expect(body.data.main.reconstructed).toBe(true);
      expect(body.data.overlays).toBeNull();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("serves no overlay without a main night", async () => {
      signIn();
      const res = await GET(req("date=2026-06-04"));
      expect((await res.json()).data.overlays).toBeNull();
    });

    it("leaves out the types of a module the account switched off", async () => {
      signIn();
      withStages(NIGHT);
      vi.mocked(isModuleEnabled).mockImplementation(
        async (_userId, key) => key !== "recovery",
      );
      await GET(req("date=2026-06-04"));
      const types = overlayTypesRead();
      expect(types).toContain("PULSE");
      expect(types).not.toContain("HRV_RMSSD");
    });
  });
});
