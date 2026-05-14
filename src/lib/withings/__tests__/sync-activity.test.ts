/**
 * v1.4.25 W17b — Withings activity-sync unit tests.
 *
 * Coverage focuses on the per-page response shape, field mapping, and
 * the writer's idempotency hook. The end-to-end DB path is covered by
 * the integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: {
      findUnique: vi.fn(),
    },
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

import { fetchWithingsActivity, syncUserActivity } from "../sync-activity";

interface FakeActivity {
  date: string;
  steps?: number;
  distance?: number;
  calories?: number;
}

function installFetchMock(entries: FakeActivity[]) {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    json: async () => ({
      status: 0,
      body: {
        activities: entries,
        more: false,
        offset: 0,
      },
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

describe("fetchWithingsActivity", () => {
  it("POSTs getactivity with steps + distance + calories in data_fields", async () => {
    const fetchMock = installFetchMock([]);
    await fetchWithingsActivity("token", "2026-05-01", "2026-05-12");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://wbsapi.withings.net/v2/measure");
    const body = String(init.body);
    expect(body).toContain("action=getactivity");
    expect(body).toContain("startdateymd=2026-05-01");
    expect(body).toContain("enddateymd=2026-05-12");
    expect(body).toContain("data_fields=steps%2Cdistance%2Ccalories");
  });

  it("returns one entry per day from the response", async () => {
    installFetchMock([
      { date: "2026-05-10", steps: 8420, distance: 6720, calories: 412 },
      { date: "2026-05-11", steps: 5012, distance: 3950, calories: 245 },
    ]);
    const entries = await fetchWithingsActivity(
      "token",
      "2026-05-10",
      "2026-05-11",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].steps).toBe(8420);
    expect(entries[1].date).toBe("2026-05-11");
  });

  it("throws when Withings returns a non-zero status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 293, error: "insufficient scope" }),
      })),
    );
    await expect(
      fetchWithingsActivity("token", "2026-05-10", "2026-05-11"),
    ).rejects.toThrow(/Withings activity error: 293/);
  });
});

describe("syncUserActivity — field mapping + idempotency", () => {
  it("writes one row per (date, metric) the first time a day shows up", async () => {
    installFetchMock([
      { date: "2026-05-12", steps: 8420, distance: 6720, calories: 412 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(3);
    expect(prisma.measurement.create).toHaveBeenCalledTimes(3);

    const types = vi
      .mocked(prisma.measurement.create)
      .mock.calls.map((c) => (c[0].data as { type: string }).type);
    expect(types.sort()).toEqual([
      "ACTIVE_ENERGY_BURNED",
      "ACTIVITY_STEPS",
      "WALKING_RUNNING_DISTANCE",
    ]);
  });

  it("updates instead of inserting when the same (date, metric) already exists", async () => {
    installFetchMock([
      { date: "2026-05-12", steps: 9001, distance: 7000, calories: 450 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue({
      id: "row-existing",
    } as never);
    vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(3);
    expect(prisma.measurement.create).not.toHaveBeenCalled();
    expect(prisma.measurement.update).toHaveBeenCalledTimes(3);
  });

  it("anchors measuredAt at noon UTC so the instant lands inside the local day for every supported tz", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 1000 }]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserActivity("user-1");

    const createArg = vi.mocked(prisma.measurement.create).mock.calls[0][0] as {
      data: { measuredAt: Date };
    };
    const measuredAt = createArg.data.measuredAt;
    expect(measuredAt.toISOString()).toBe("2026-05-12T12:00:00.000Z");

    // Regression: anchoring at noon UTC keeps the row inside the
    // calendar day every user reads it in. Bucketing the same instant
    // via `Intl.DateTimeFormat` across the canonical Withings user
    // span — Honolulu (UTC-10), Los Angeles (UTC-7/-8), Berlin
    // (UTC+1/+2) and Tokyo (UTC+9) — must all return "2026-05-12".
    // Anchoring at end-of-day UTC (the v1.4.25 W17b shape) shifted
    // Tokyo by +1 day; anchoring at midnight UTC would shift LA by -1.
    // Noon UTC is the only choice that holds across the practical
    // [-11, +12) range.
    const bucket = (tz: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(measuredAt);
    expect(bucket("Pacific/Honolulu")).toBe("2026-05-12");
    expect(bucket("America/Los_Angeles")).toBe("2026-05-12");
    expect(bucket("Europe/Berlin")).toBe("2026-05-12");
    expect(bucket("Asia/Tokyo")).toBe("2026-05-12");
  });

  it("skips missing fields without writing zero rows or throwing", async () => {
    // `distance` absent — Withings drops the field rather than emitting 0
    // when there's no GPS. Steps + calories still write.
    installFetchMock([{ date: "2026-05-12", steps: 8000, calories: 380 }]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(2);
    const types = vi
      .mocked(prisma.measurement.create)
      .mock.calls.map((c) => (c[0].data as { type: string }).type);
    expect(types).not.toContain("WALKING_RUNNING_DISTANCE");
  });

  it("ingests a 0-step rest day rather than dropping it", async () => {
    // Withings reports 0 steps for a day a user spent in bed — that's
    // a valid datapoint, not a missing one. The mapper must not skip
    // it (which would let the prior day's value erroneously "stick").
    installFetchMock([
      { date: "2026-05-12", steps: 0, distance: 0, calories: 0 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserActivity("user-1");
    expect(imported).toBe(3);
  });

  it("calls recordSyncSuccess after a clean round-trip", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 1000 }]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserActivity("user-1");
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings");
  });

  it("tags every row with the canonical externalId so future replays dedup", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 8420 }]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserActivity("user-1");

    const createArg = vi.mocked(prisma.measurement.create).mock.calls[0][0] as {
      data: { externalId: string };
    };
    expect(createArg.data.externalId).toBe(
      "withings:activity:user-1:2026-05-12:steps",
    );
  });
});
