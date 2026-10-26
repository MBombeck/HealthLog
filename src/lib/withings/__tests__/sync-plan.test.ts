/**
 * Withings API plans (2026-10-12): a request naming one meastype outside the
 * account's plan is refused whole with status 277. These tests drive the real
 * measure sync and the real client against a mocked `safeFetch` that behaves
 * like the plan: any refused meastype in `meastypes` answers 277, anything
 * else answers with one reading per requested type.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    integrationStatus: {
      findMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => v),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getUserWithingsCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "secret",
  })),
}));

vi.mock("@/lib/integrations/status", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/status")
  >("@/lib/integrations/status");
  return {
    ...actual,
    isReauthRequired: vi.fn().mockResolvedValue(false),
    recordSyncFailure: vi.fn().mockResolvedValue(undefined),
    recordSyncSuccess: vi.fn().mockResolvedValue(undefined),
    resumeIntegrationFromPark: vi.fn().mockResolvedValue({ wasParked: false }),
  };
});

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForKeys: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
  invalidateUserMeasurements: vi.fn(),
}));

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
    addMeta: vi.fn(),
    toJSON: () => ({ meta: {} }),
  })),
  annotate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { safeFetch } from "@/lib/safe-fetch";
import {
  recordSyncFailure,
  recordSyncSuccess,
  resumeIntegrationFromPark,
} from "@/lib/integrations/status";
import { classifyWithingsResponse } from "../response-classifier";
import { WithingsApiError } from "../response-classifier";
import {
  recordWithingsSyncFailure,
  syncUserMeasurements,
  WITHINGS_INCREMENTAL_OVERLAP_MS,
} from "../sync";
import {
  releasePlanGatedWithingsParks,
  requestWithinPlan,
  shouldPersistPlanLeg,
  WITHINGS_ADVANCED_MEASTYPES,
  WITHINGS_PLAN_MAX_REQUESTS,
} from "../api-plan";
import { withingsPlanUnavailableFeatures } from "../plan-features";
import { WITHINGS_MEASTYPES } from "../client";

const LAST_GOOD_SYNC = new Date("2026-10-12T21:12:00Z");

/** The meastypes the free plan refuses in these tests (the documented set). */
let refused = new Set<number>(WITHINGS_ADVANCED_MEASTYPES);

/** Every `meastypes` list the client sent, in order. */
const requestedTypes: number[][] = [];
const requestedStartdates: string[] = [];

function installPlanFetch() {
  vi.mocked(safeFetch).mockImplementation(async (_url, init) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    const types = (params.get("meastypes") ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    requestedTypes.push(types);
    requestedStartdates.push(params.get("startdate") ?? "");
    const body = types.some((t) => refused.has(t))
      ? {
          status: 277,
          error:
            "One of the data type requested in this API request is not available in your API plan",
        }
      : {
          status: 0,
          body: {
            measuregrps: [
              {
                grpid: 1,
                date: Math.floor(Date.parse("2026-10-13T07:00:00Z") / 1000),
                measures: types.map((type) => ({ type, value: 800, unit: -1 })),
              },
            ],
            more: 0,
          },
        };
    return { status: 200, json: async () => body } as unknown as Response;
  });
}

function connection(
  apiPlanState: unknown = null,
  lastSyncedAt = LAST_GOOD_SYNC,
) {
  return {
    id: "conn-1",
    userId: "user-1",
    withingsUserId: "wu-1",
    accessToken: "enc-access",
    refreshToken: "enc-refresh",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastSyncedAt,
    apiPlanState,
  };
}

/** The legs the sync merged into `api_plan_state`, read off the raw SQL. */
function persistedLegs(): Array<{ leg: unknown; value: unknown }> {
  return vi.mocked(prisma.$executeRaw).mock.calls.map((call) => ({
    leg: call[1],
    value: JSON.parse(String(call[2])),
  }));
}

function createdTypes(): string[] {
  return vi
    .mocked(prisma.measurement.createManyAndReturn)
    .mock.calls.flatMap((c) =>
      (c[0] as { data: Array<{ type: string }> }).data.map((d) => d.type),
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  requestedTypes.length = 0;
  requestedStartdates.length = 0;
  refused = new Set<number>(WITHINGS_ADVANCED_MEASTYPES);
  installPlanFetch();
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
    connection() as never,
  );
  vi.mocked(prisma.withingsConnection.update).mockResolvedValue({} as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
  vi.mocked(prisma.measurement.createManyAndReturn).mockImplementation(
    (async (args: { data: Array<{ type: string; measuredAt: Date }> }) =>
      args.data.map((d) => ({
        id: `m-${d.type}`,
        type: d.type,
        measuredAt: d.measuredAt,
      }))) as never,
  );
  vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);
});

describe("syncUserMeasurements inside the Withings API plan", () => {
  it("retries without the advanced types on a 277 and imports the core ones", async () => {
    const result = await syncUserMeasurements("user-1");

    expect(requestedTypes).toHaveLength(2);
    expect(requestedTypes[0]).toEqual(
      expect.arrayContaining([...WITHINGS_ADVANCED_MEASTYPES, 1, 9, 10]),
    );
    expect(requestedTypes[1]!.some((t) => refused.has(t))).toBe(false);
    expect(requestedTypes[1]).toEqual(expect.arrayContaining([1, 9, 10, 11]));

    expect(result).toEqual({ imported: expect.any(Number), failed: false });
    expect(result.imported).toBeGreaterThan(0);
    expect(createdTypes()).toEqual(
      expect.arrayContaining([
        "WEIGHT",
        "BLOOD_PRESSURE_SYS",
        "BLOOD_PRESSURE_DIA",
        "PULSE",
      ]),
    );
    expect(createdTypes()).not.toContain("VASCULAR_AGE");

    // A partial-by-plan run is a success, and the watermark moves on.
    expect(recordSyncFailure).not.toHaveBeenCalled();
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "measures",
    });
    expect(prisma.withingsConnection.update).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { lastSyncedAt: expect.any(Date) },
    });

    expect(persistedLegs()).toEqual([
      {
        leg: "measures",
        value: {
          unavailable: [...WITHINGS_ADVANCED_MEASTYPES].sort((a, b) => a - b),
          checkedAt: expect.any(String),
        },
      },
    ]);
  });

  it("skips the remembered types on the next sync without a refused round trip", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection({
        version: 1,
        measures: {
          unavailable: [...WITHINGS_ADVANCED_MEASTYPES],
          checkedAt: new Date().toISOString(),
        },
      }) as never,
    );

    const result = await syncUserMeasurements("user-1");

    expect(requestedTypes).toHaveLength(1);
    expect(requestedTypes[0]!.some((t) => refused.has(t))).toBe(false);
    expect(result.failed).toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("asks for the full set again once the remembered refusal is a week old", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection({
        version: 1,
        measures: {
          unavailable: [...WITHINGS_ADVANCED_MEASTYPES],
          checkedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        },
      }) as never,
    );
    // The account moved to a plan that allows everything.
    refused = new Set();

    await syncUserMeasurements("user-1");

    expect(requestedTypes).toHaveLength(1);
    expect(requestedTypes[0]).toEqual(
      expect.arrayContaining([...WITHINGS_ADVANCED_MEASTYPES]),
    );
    expect(createdTypes()).toContain("VASCULAR_AGE");
    expect(persistedLegs()).toEqual([
      {
        leg: "measures",
        value: { unavailable: [], checkedAt: expect.any(String) },
      },
    ]);
  });

  it("narrows further when the reduced request is still refused", async () => {
    // An undocumented refusal on top of the documented set: fat ratio (6).
    refused = new Set([...WITHINGS_ADVANCED_MEASTYPES, 6]);

    const result = await syncUserMeasurements("user-1");

    expect(result.failed).toBe(false);
    expect(requestedTypes.length).toBeLessThanOrEqual(
      WITHINGS_PLAN_MAX_REQUESTS,
    );
    expect(createdTypes()).toEqual(
      expect.arrayContaining(["WEIGHT", "BLOOD_PRESSURE_SYS", "PULSE"]),
    );
    expect(createdTypes()).not.toContain("BODY_FAT");
    const [persisted] = persistedLegs();
    expect(persisted?.value).toEqual({
      unavailable: [6, ...WITHINGS_ADVANCED_MEASTYPES].sort((a, b) => a - b),
      checkedAt: expect.any(String),
    });
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("never remembers a type the budget could not resolve, and converges over runs", async () => {
    // Two undocumented refusals on top of the documented set. Over the 19
    // types the first run runs out of budget before it reaches 12, 54, 71,
    // 76, 77 and 88, all free.
    refused = new Set([...WITHINGS_ADVANCED_MEASTYPES, 6, 35]);
    let stored: unknown = null;
    let lastSyncedAt = LAST_GOOD_SYNC;
    vi.mocked(prisma.withingsConnection.findUnique).mockImplementation(
      (async () => connection(stored, lastSyncedAt)) as never,
    );
    vi.mocked(prisma.withingsConnection.update).mockImplementation(
      (async (args: { data: { lastSyncedAt: Date } }) => {
        lastSyncedAt = args.data.lastSyncedAt;
        return {};
      }) as never,
    );
    const runs: Array<{ unavailable: number[]; startdates: string[] }> = [];
    const read = new Set<number>();

    for (let run = 0; run < 4; run++) {
      vi.mocked(prisma.$executeRaw).mockClear();
      vi.mocked(prisma.measurement.createManyAndReturn).mockClear();
      requestedStartdates.length = 0;
      await syncUserMeasurements("user-1");
      const [persisted] = persistedLegs();
      if (persisted) {
        const value = persisted.value as {
          unavailable: number[];
          checkedAt: string;
        };
        stored = { version: 1, measures: value };
      }
      for (const types of requestedTypes.splice(0)) {
        if (!types.some((t) => refused.has(t)))
          types.forEach((t) => read.add(t));
      }
      const current = stored as {
        measures?: { unavailable: number[] };
      } | null;
      runs.push({
        unavailable: current?.measures?.unavailable ?? [],
        startdates: [...requestedStartdates],
      });
    }

    const truly = [...refused].sort((a, b) => a - b);
    // No run ever stored a type Withings did not refuse.
    for (const r of runs) {
      expect(r.unavailable.every((t) => refused.has(t))).toBe(true);
    }
    expect(runs.at(-1)!.unavailable).toEqual(truly);
    // Every type the plan allows was read in an accepted request, the free
    // ones the first run never reached included.
    expect(read).toEqual(
      new Set(WITHINGS_MEASTYPES.filter((t) => !refused.has(t))),
    );
    expect([...read]).toEqual(expect.arrayContaining([12, 54, 71, 76, 77, 88]));
    // The first run read nothing for the unresolved types, so the second
    // still reads from the last good sync.
    const fromLastGood = String(
      Math.floor(
        (LAST_GOOD_SYNC.getTime() - WITHINGS_INCREMENTAL_OVERLAP_MS) / 1000,
      ),
    );
    expect(runs[1]!.startdates.every((s) => s === fromLastGood)).toBe(true);
  });

  it("keeps the remembered date when a run that is not the re-probe finds one more refusal", async () => {
    const remembered = new Date(Date.now() - 3 * 86_400_000).toISOString();
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection({
        version: 1,
        measures: {
          unavailable: [...WITHINGS_ADVANCED_MEASTYPES],
          checkedAt: remembered,
        },
      }) as never,
    );
    // The plan starts refusing fat ratio too.
    refused = new Set([...WITHINGS_ADVANCED_MEASTYPES, 6]);

    await syncUserMeasurements("user-1");

    expect(persistedLegs()).toEqual([
      {
        leg: "measures",
        value: {
          unavailable: [6, ...WITHINGS_ADVANCED_MEASTYPES].sort(
            (a, b) => a - b,
          ),
          checkedAt: remembered,
        },
      },
    ]);
  });

  it("reads the whole gap since the last good sync", async () => {
    await syncUserMeasurements("user-1");

    const expected = String(
      Math.floor(
        (LAST_GOOD_SYNC.getTime() - WITHINGS_INCREMENTAL_OVERLAP_MS) / 1000,
      ),
    );
    expect(requestedStartdates.every((s) => s === expected)).toBe(true);
  });

  it("treats a run where every request was refused as transient: nothing remembered, watermark held", async () => {
    refused = new Set([
      1, 5, 6, 8, 9, 10, 11, 12, 35, 54, 71, 76, 77, 88, 91, 123, 155, 170, 73,
    ]);

    const result = await syncUserMeasurements("user-1");

    expect(result).toEqual({ imported: 0, failed: true });
    expect(prisma.withingsConnection.update).not.toHaveBeenCalled();
    // A 277 stays off the ledger, and a run that read nothing is no success.
    expect(recordSyncFailure).not.toHaveBeenCalled();
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(requestedTypes.length).toBeLessThanOrEqual(
      WITHINGS_PLAN_MAX_REQUESTS,
    );
    // Weight and blood pressure are not remembered as refused.
    expect(persistedLegs()).toEqual([]);

    // The fault clears; the next run asks for everything again and reads the
    // whole gap since the last good sync.
    refused = new Set(WITHINGS_ADVANCED_MEASTYPES);
    requestedTypes.length = 0;
    requestedStartdates.length = 0;
    const next = await syncUserMeasurements("user-1");
    expect(next.failed).toBe(false);
    expect(requestedTypes[0]).toEqual(expect.arrayContaining([1, 9, 10, 11]));
    expect(createdTypes()).toEqual(
      expect.arrayContaining(["WEIGHT", "BLOOD_PRESSURE_SYS", "PULSE"]),
    );
    const fromLastGood = String(
      Math.floor(
        (LAST_GOOD_SYNC.getTime() - WITHINGS_INCREMENTAL_OVERLAP_MS) / 1000,
      ),
    );
    expect(requestedStartdates.every((s) => s === fromLastGood)).toBe(true);
  });

  it("holds the watermark when plan memory leaves nothing to request", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection({
        version: 1,
        measures: {
          unavailable: [...WITHINGS_MEASTYPES],
          checkedAt: new Date().toISOString(),
        },
      }) as never,
    );

    const result = await syncUserMeasurements("user-1");

    expect(requestedTypes).toHaveLength(0);
    expect(result).toEqual({ imported: 0, failed: true });
    expect(prisma.withingsConnection.update).not.toHaveBeenCalled();
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("holds the watermark when a core type was skipped from plan memory", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection({
        version: 1,
        measures: {
          unavailable: [1, ...WITHINGS_ADVANCED_MEASTYPES],
          checkedAt: new Date().toISOString(),
        },
      }) as never,
    );

    const result = await syncUserMeasurements("user-1");

    expect(requestedTypes).toHaveLength(1);
    expect(requestedTypes[0]).not.toContain(1);
    expect(result.failed).toBe(false);
    expect(createdTypes()).toContain("BLOOD_PRESSURE_SYS");
    // Weight was not read in this window, so the window stays open for it.
    expect(prisma.withingsConnection.update).not.toHaveBeenCalled();
  });

  it("still moves the watermark when only advanced types are remembered", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection({
        version: 1,
        measures: {
          unavailable: [...WITHINGS_ADVANCED_MEASTYPES],
          checkedAt: new Date().toISOString(),
        },
      }) as never,
    );

    await syncUserMeasurements("user-1");

    expect(prisma.withingsConnection.update).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { lastSyncedAt: expect.any(Date) },
    });
  });
});

describe("shouldPersistPlanLeg", () => {
  it("remembers a refusal only from a run where something else was accepted", () => {
    expect(
      shouldPersistPlanLeg({ gated: true, reprobed: false, acceptedAny: true }),
    ).toBe(true);
    expect(
      shouldPersistPlanLeg({
        gated: true,
        reprobed: false,
        acceptedAny: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistPlanLeg({ gated: true, reprobed: true, acceptedAny: false }),
    ).toBe(false);
    expect(
      shouldPersistPlanLeg({ gated: false, reprobed: true, acceptedAny: true }),
    ).toBe(true);
    expect(
      shouldPersistPlanLeg({
        gated: false,
        reprobed: false,
        acceptedAny: true,
      }),
    ).toBe(false);
  });
});

describe("a 277 is never an auth failure", () => {
  it("classifies 277 as persistent, not reauth_required", () => {
    expect(classifyWithingsResponse(200, { status: 277 }).classification).toBe(
      "persistent",
    );
    // The rest of the OAuth range keeps its meaning.
    expect(classifyWithingsResponse(200, { status: 250 }).classification).toBe(
      "reauth_required",
    );
  });

  it("keeps a stray 277 off the ledger entirely", async () => {
    await recordWithingsSyncFailure(
      "user-1",
      new WithingsApiError({
        verb: "measure",
        classification: "persistent",
        withingsStatus: 277,
        reason: "withings_277",
      }),
      "activity",
    );
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("lifts connections an earlier build parked over a 277, and only those", async () => {
    vi.mocked(prisma.integrationStatus.findMany).mockResolvedValue([
      {
        userId: "plan-user",
        lastError:
          "Withings measure error: 277 - One of the data type requested in this API request is not available in your API plan",
      },
      { userId: "revoked-user", lastError: "Withings refresh error: 101" },
    ] as never);

    const released = await releasePlanGatedWithingsParks();

    expect(released).toBe(1);
    expect(resumeIntegrationFromPark).toHaveBeenCalledTimes(1);
    expect(resumeIntegrationFromPark).toHaveBeenCalledWith(
      "plan-user",
      "withings",
    );
  });
});

describe("requestWithinPlan", () => {
  const gatedError = () =>
    new WithingsApiError({
      verb: "measure",
      classification: "persistent",
      withingsStatus: 277,
      reason: "withings_277",
    });

  it("isolates refused keys deterministically and keeps every accepted part", async () => {
    const refusedKeys = new Set(["c", "f"]);
    const calls: string[][] = [];
    const run = () =>
      requestWithinPlan({
        keys: ["a", "b", "c", "d", "e", "f", "g"],
        knownGated: [],
        fetch: async (keys: string[]) => {
          calls.push(keys);
          if (keys.some((k) => refusedKeys.has(k))) throw gatedError();
          return keys;
        },
      });

    const first = await run();
    const firstCalls = calls.splice(0);
    const second = await run();

    expect(first.unavailable.sort()).toEqual(["c", "f"]);
    expect(first.results.sort()).toEqual(["a", "b", "d", "e", "g"]);
    expect(first.gated).toBe(true);
    expect(first.acceptedAny).toBe(true);
    expect(calls).toEqual(firstCalls);
    expect(second.unavailable.sort()).toEqual(["c", "f"]);
  });

  it("stops at the request budget and leaves what is left unverified, not unavailable", async () => {
    const result = await requestWithinPlan({
      keys: ["a", "b", "c", "d", "e", "f", "g", "h"],
      knownGated: [],
      maxRequests: 3,
      fetch: async () => {
        throw gatedError();
      },
    });
    expect(result.requests).toBe(3);
    // Only the requests actually made prove anything: [a..h], [a..d] and [a,b]
    // were refused, which isolates no single key.
    expect(result.unavailable).toEqual([]);
    expect(result.unverified.sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
    expect(result.acceptedAny).toBe(false);
  });

  it("lets any other error through untouched", async () => {
    const boom = new Error("Withings measure error: 503");
    await expect(
      requestWithinPlan({
        keys: [1, 2],
        knownGated: [],
        fetch: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });
});

describe("withingsPlanUnavailableFeatures", () => {
  it("names each withheld reading once, in display order", () => {
    expect(
      withingsPlanUnavailableFeatures({
        version: 1,
        measures: { unavailable: [155, 35, 54, 91], checkedAt: "x" },
        sleepSummary: { unavailable: ["sleep_score"], checkedAt: "x" },
        ecg: { unavailable: ["heart"], checkedAt: "x" },
      }),
    ).toEqual([
      "spo2",
      "vascularAge",
      "pulseWaveVelocity",
      "ecg",
      "sleepScore",
    ]);
  });
});
