/**
 * v1.4.25 W17c — Withings Sleep v2 sync unit tests.
 *
 * Coverage focuses on the state → SleepStage enum mapping, the
 * unix-seconds vs minutes conversion (easy regression trap), and the
 * per-segment write path. End-to-end DB exercise lives in the
 * integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn().mockResolvedValue(false),
  recordSyncFailure: vi.fn(),
  recordSyncSuccess: vi.fn(),
}));

vi.mock("../sync", async () => {
  const actual = await vi.importActual<typeof import("../sync")>("../sync");
  return {
    ...actual,
    getValidToken: vi.fn(async () => ({
      accessToken: "token",
      connection: { id: "conn-1", withingsUserId: "wu-1" },
    })),
  };
});

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

import { prisma } from "@/lib/db";
import { recordSyncSuccess } from "@/lib/integrations/status";

import {
  fetchWithingsSleep,
  mapWithingsSleepState,
  syncUserSleep,
} from "../sync-sleep";

interface FakeSegment {
  startdate: number;
  enddate: number;
  state: number;
  id?: number;
}

function installFetchMock(segments: FakeSegment[]) {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    json: async () => ({
      status: 0,
      body: { series: segments },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapWithingsSleepState", () => {
  it("maps state 0 (awake) → AWAKE", () => {
    expect(mapWithingsSleepState(0)).toBe("AWAKE");
  });

  it("maps state 1 (light) → CORE (HealthKit-aligned NREM 1+2)", () => {
    expect(mapWithingsSleepState(1)).toBe("CORE");
  });

  it("maps state 2 (deep) → DEEP", () => {
    expect(mapWithingsSleepState(2)).toBe("DEEP");
  });

  it("maps state 3 (REM) → REM", () => {
    expect(mapWithingsSleepState(3)).toBe("REM");
  });

  it("returns null for state 4 (synthetic marker — ignored)", () => {
    expect(mapWithingsSleepState(4)).toBeNull();
  });

  it("returns null for any unknown state value", () => {
    expect(mapWithingsSleepState(99)).toBeNull();
    expect(mapWithingsSleepState(-1)).toBeNull();
  });
});

describe("fetchWithingsSleep", () => {
  it("POSTs sleep get with unix-seconds startdate + enddate", async () => {
    const fetchMock = installFetchMock([]);
    await fetchWithingsSleep("token", 1715000000, 1715100000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://wbsapi.withings.net/v2/sleep");
    const body = String(init.body);
    expect(body).toContain("action=get");
    expect(body).toContain("startdate=1715000000");
    expect(body).toContain("enddate=1715100000");
  });

  it("throws when Withings returns a non-zero status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 293 }),
      })),
    );
    await expect(
      fetchWithingsSleep("token", 1715000000, 1715100000),
    ).rejects.toThrow(/Withings sleep error: 293/);
  });
});

describe("syncUserSleep — segment writes + idempotency", () => {
  it("writes one row per stage segment with the mapped SleepStage", async () => {
    // A typical night: 4 segments — light, deep, REM, light.
    const base = 1715000000;
    installFetchMock([
      { startdate: base, enddate: base + 3600, state: 1, id: 99 }, // 60 min CORE
      { startdate: base + 3600, enddate: base + 5400, state: 2, id: 99 }, // 30 min DEEP
      { startdate: base + 5400, enddate: base + 7200, state: 3, id: 99 }, // 30 min REM
      { startdate: base + 7200, enddate: base + 7800, state: 0, id: 99 }, // 10 min AWAKE
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(4);

    const stages = vi
      .mocked(prisma.measurement.create)
      .mock.calls.map((c) => (c[0].data as { sleepStage: string }).sleepStage);
    expect(stages).toEqual(["CORE", "DEEP", "REM", "AWAKE"]);

    // First segment: 60 minutes (3600s / 60).
    const firstDuration = vi
      .mocked(prisma.measurement.create)
      .mock.calls[0][0] as { data: { value: number; unit: string } };
    expect(firstDuration.data.value).toBe(60);
    expect(firstDuration.data.unit).toBe("minutes");
  });

  it("converts startdate (unix seconds) to a Date in measuredAt", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 1 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserSleep("user-1");
    const arg = vi.mocked(prisma.measurement.create).mock.calls[0][0] as {
      data: { measuredAt: Date };
    };
    expect(arg.data.measuredAt.getTime()).toBe(1715000000 * 1000);
  });

  it("skips state 4 (synthetic marker) without throwing", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 4, id: 1 },
      { startdate: 1715003600, enddate: 1715007200, state: 2, id: 1 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(1);
    const stages = vi
      .mocked(prisma.measurement.create)
      .mock.calls.map((c) => (c[0].data as { sleepStage: string }).sleepStage);
    expect(stages).toEqual(["DEEP"]);
  });

  it("updates existing rows on a re-sync rather than inserting duplicates", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 1 },
    ]);
    // findFirst returns an existing row → writer takes the update path.
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue({
      id: "row-1",
    } as never);
    vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(1);
    expect(prisma.measurement.create).not.toHaveBeenCalled();
    expect(prisma.measurement.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { value: 60 },
    });
  });

  it("stamps every row with an externalId tied to the segment", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 42 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserSleep("user-1");
    const arg = vi.mocked(prisma.measurement.create).mock.calls[0][0] as {
      data: { externalId: string };
    };
    expect(arg.data.externalId).toBe("withings:sleep:user-1:42:0");
  });

  it("calls recordSyncSuccess after a clean round-trip", async () => {
    installFetchMock([]);
    await syncUserSleep("user-1");
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings");
  });

  it("tolerates a ScanWatch night with no REM segment (no all-zeros row)", async () => {
    // ScanWatch reports CORE + DEEP only; a missing REM should NOT
    // synthesise an all-zeros REM row. Withings simply omits the
    // segment, so the writer never sees it.
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 1, id: 7 },
      { startdate: 1715003600, enddate: 1715005400, state: 2, id: 7 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(2);
    const stages = vi
      .mocked(prisma.measurement.create)
      .mock.calls.map((c) => (c[0].data as { sleepStage: string }).sleepStage);
    expect(stages).not.toContain("REM");
  });
});
