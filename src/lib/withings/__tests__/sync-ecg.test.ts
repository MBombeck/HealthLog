/**
 * v1.18.11 — Withings ECG / AFib sync unit tests.
 *
 * Coverage focuses on the `ecg.afib` code → RhythmClassification mapping, the
 * EVENT-row write shape (value=1, unit=event, verdict in rhythmClassification),
 * the stable signalid externalId, the non-ECG-entry skip, and the reauth /
 * 403 park behaviour. End-to-end DB exercise lives in the integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The waveform write goes through the shared writer
// (`@/lib/ecg/persist-recording`), which opens a transaction and looks the
// recording up under both identities before upserting. The mock hands the
// transaction the same `ecgRecording` delegate, so these tests still watch the
// real assembly rather than a stub standing in for it.
vi.mock("@/lib/db", () => {
  const ecgRecording = {
    upsert: vi.fn(),
    findUnique: vi.fn(),
  };
  return {
    prisma: {
      measurement: {
        upsert: vi.fn(),
      },
      ecgRecording,
      withingsConnection: {
        findUnique: vi.fn(),
      },
      $executeRaw: vi.fn(),
      $transaction: vi.fn(
        async (fn: (tx: unknown) => unknown) => await fn({ ecgRecording }),
      ),
    },
  };
});

vi.mock("../ecg-waveform-codec", () => ({
  encryptWaveformToBytes: vi.fn((samples: number[]) =>
    Uint8Array.from([samples.length & 0xff]),
  ),
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
    getValidToken: vi.fn(async () => ({ accessToken: "token" })),
    recordWithingsSyncFailure: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
  annotate: vi.fn(),
}));

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  const perKey = vi.fn().mockResolvedValue(undefined);
  return {
    ...actual,
    recomputeBucketsForMeasurement: perKey,
    // The keyed refold, observed as the per-key recomputes it stands for.
    recomputeBucketsForKeys: vi.fn(
      async (
        userId: string,
        keys: Array<{ type: string; measuredAt: Date }>,
      ) => {
        for (const k of keys) await perKey(userId, k.type, k.measuredAt);
      },
    ),
  };
});

import { prisma } from "@/lib/db";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import { getValidToken, recordWithingsSyncFailure } from "../sync";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

import {
  fetchWithingsHeartList,
  fetchWithingsHeartSignal,
  mapWithingsAfib,
  syncUserEcg,
  type WithingsHeartEntry,
} from "../sync-ecg";

/** A default signal `get` body returned for any `action=get` request. */
const DEFAULT_SIGNAL = {
  signal: [1, 2, 3, 4],
  sampling_frequency: 300,
  heart_rate: 72,
};

/**
 * Install a fetch mock that routes by request body: `action=list` returns the
 * heart-list series, `action=get` returns a signal body. The signal body can
 * be overridden (or set to null-signal) per test.
 */
function installFetchMock(
  entries: WithingsHeartEntry[],
  signal: Record<string, unknown> | null = DEFAULT_SIGNAL,
) {
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    if (init.body.includes("action=get")) {
      return {
        status: 200,
        json: async () => ({ status: 0, body: signal ?? {} }),
      };
    }
    return {
      status: 200,
      json: async () => ({ status: 0, body: { series: entries } }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isReauthRequired).mockResolvedValue(false);
  vi.mocked(getValidToken).mockResolvedValue({
    accessToken: "token",
  } as never);
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
    id: "connection-1",
  } as never);
  vi.mocked(prisma.measurement.upsert).mockResolvedValue({
    id: "m-1",
  } as never);
  vi.mocked(prisma.ecgRecording.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.ecgRecording.upsert).mockResolvedValue({
    id: "ecg-1",
  } as never);
  vi.mocked(prisma.$transaction).mockImplementation(
    (async (fn: (tx: unknown) => unknown) =>
      await fn({ ecgRecording: prisma.ecgRecording })) as never,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mapWithingsAfib", () => {
  it("maps afib 0 → NOT_DETECTED", () => {
    expect(mapWithingsAfib(0)).toBe("NOT_DETECTED");
  });

  it("maps afib 1 → IRREGULAR", () => {
    expect(mapWithingsAfib(1)).toBe("IRREGULAR");
  });

  it("maps any other code → INCONCLUSIVE", () => {
    expect(mapWithingsAfib(2)).toBe("INCONCLUSIVE");
    expect(mapWithingsAfib(3)).toBe("INCONCLUSIVE");
  });

  it("returns null for a missing / non-finite afib code", () => {
    expect(mapWithingsAfib(undefined)).toBeNull();
    expect(mapWithingsAfib(null)).toBeNull();
    expect(mapWithingsAfib(Number.NaN)).toBeNull();
  });
});

describe("fetchWithingsHeartList", () => {
  it("POSTs heart list with unix-seconds window", async () => {
    const fetchMock = installFetchMock([]);
    await fetchWithingsHeartList("token", 1715000000, 1715100000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toContain("/v2/heart");
    expect(init.body).toContain("action=list");
    expect(init.body).toContain("startdate=1715000000");
    expect(init.body).toContain("enddate=1715100000");
  });
});

describe("fetchWithingsHeartSignal", () => {
  it("POSTs action=get with the signalid and returns the signal body", async () => {
    const fetchMock = installFetchMock([]);
    const sig = await fetchWithingsHeartSignal("token", 999);

    const init = fetchMock.mock.calls[0][1] as { body: string };
    expect(init.body).toContain("action=get");
    expect(init.body).toContain("signalid=999");
    expect(sig).toEqual({
      signal: [1, 2, 3, 4],
      sampling_frequency: 300,
      heart_rate: 72,
    });
  });

  it("returns null when the response carries no usable signal array", async () => {
    installFetchMock([], { signal: [], sampling_frequency: 300 });
    expect(await fetchWithingsHeartSignal("token", 999)).toBeNull();
  });
});

describe("syncUserEcg", () => {
  it("writes one IRREGULAR_RHYTHM_NOTIFICATION EVENT row per ECG recording", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: { signalid: 111, afib: 1 } },
      { timestamp: 1715003600, ecg: { signalid: 222, afib: 0 } },
    ]);
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({
      id: "m-1",
    } as never);

    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(2);
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(2);
    const first = vi.mocked(prisma.measurement.upsert).mock.calls[0][0];
    expect(first.create).toMatchObject({
      type: "IRREGULAR_RHYTHM_NOTIFICATION",
      value: 1,
      unit: "event",
      source: "WITHINGS",
      rhythmClassification: "IRREGULAR",
      externalId: "withings:ecg:user-1:111",
    });
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "ecg",
    });
  });

  it("never narrows the broad catch-up to an ordinary webhook window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    const fetchMock = installFetchMock([]);
    const recentStart = Math.floor(
      new Date("2026-07-19T12:00:00.000Z").getTime() / 1000,
    );
    const recentEnd = Math.floor(
      new Date("2026-07-20T12:00:00.000Z").getTime() / 1000,
    );

    await syncUserEcg("user-1", {
      startdate: recentStart,
      enddate: recentEnd,
    });

    const init = fetchMock.mock.calls[0][1] as { body: string };
    const broadStart = Math.floor(
      new Date("2026-06-20T12:00:00.000Z").getTime() / 1000,
    );
    expect(init.body).toContain(`startdate=${broadStart}`);
    expect(init.body).toContain(`enddate=${recentEnd}`);
  });

  it("skips a heart entry that carries no ECG / afib verdict", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: null },
      { timestamp: 1715003600 },
      { timestamp: 1715007200, ecg: { signalid: 333, afib: 0 } },
    ]);
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({
      id: "m-1",
    } as never);

    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(1);
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(1);
  });

  it("falls back to a timestamp externalId when signalid is absent", async () => {
    installFetchMock([{ timestamp: 1715000000, ecg: { afib: 1 } }]);
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({
      id: "m-1",
    } as never);

    await syncUserEcg("user-1");

    const call = vi.mocked(prisma.measurement.upsert).mock.calls[0][0];
    expect(call.create.externalId).toBe("withings:ecg:user-1:ts-1715000000");
  });

  it("short-circuits when the connection is parked at reauth", async () => {
    vi.mocked(isReauthRequired).mockResolvedValue(true);
    const fetchMock = installFetchMock([]);

    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records reauth_required on a 403 from the heart endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ status: 401, error: "invalid_token" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncUserEcg("user-1")).rejects.toThrow();
    // A Withings 401-status body classifies as a hard failure; the generic
    // failure recorder runs (the 403-specific reauth branch keys on HTTP 403).
    expect(recordSyncFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reauth_required", errorCode: "403" }),
    );
  });

  it("captures the full waveform for each recording with a numeric signalid", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: { signalid: 111, afib: 1 } },
    ]);

    await syncUserEcg("user-1");

    // The AFib verdict EVENT row is still written (v1.18.11 behaviour).
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(1);
    // The waveform row is written, keyed for idempotent re-sync and carrying
    // the descriptors + the link back to the EVENT row.
    expect(prisma.ecgRecording.upsert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.ecgRecording.upsert).mock.calls[0][0];
    expect(call.where).toEqual({
      userId_source_externalRecordingId: {
        userId: "user-1",
        source: "WITHINGS",
        externalRecordingId: "111",
      },
    });
    expect(call.create).toMatchObject({
      userId: "user-1",
      source: "WITHINGS",
      externalRecordingId: "111",
      samplingFrequency: 300,
      sampleCount: 4,
      durationSeconds: 4 / 300,
      averageHeartRate: 72,
      rhythmClassification: "IRREGULAR",
      measurementId: "m-1",
    });
    expect(call.create.waveformEncrypted).toBeInstanceOf(Uint8Array);
  });

  it("does not fetch a waveform for a recording without a numeric signalid", async () => {
    installFetchMock([{ timestamp: 1715000000, ecg: { afib: 1 } }]);

    await syncUserEcg("user-1");

    // Verdict still captured, but no signal GET / no waveform row.
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.ecgRecording.upsert).not.toHaveBeenCalled();
  });

  it("upserts the waveform idempotently so a re-sync overwrites in place", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: { signalid: 111, afib: 1 } },
    ]);

    await syncUserEcg("user-1");
    await syncUserEcg("user-1");

    // Two syncs → two upserts, both keyed on the same composite, never a plain
    // create that would duplicate.
    expect(prisma.ecgRecording.upsert).toHaveBeenCalledTimes(2);
    const keys = vi
      .mocked(prisma.ecgRecording.upsert)
      .mock.calls.map((c) => c[0].where);
    expect(keys[0]).toEqual(keys[1]);
  });

  it("retries token acquisition failures while the owned connection still exists", async () => {
    installFetchMock([]);
    vi.mocked(getValidToken).mockResolvedValue(null);

    await expect(syncUserEcg("user-1")).rejects.toThrow(
      "Withings ECG token unavailable",
    );
    expect(prisma.withingsConnection.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { id: true },
    });
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("does not mark the source complete when an ECG event write fails", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: { signalid: 111, afib: 1 } },
    ]);
    vi.mocked(prisma.measurement.upsert).mockRejectedValue(
      new Error("source write failed"),
    );

    await expect(syncUserEcg("user-1")).rejects.toThrow("source write failed");
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(recordWithingsSyncFailure).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ message: "source write failed" }),
      "ecg",
    );
  });

  it("continues later ECG rows before retrying a failed source write", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: { signalid: 111, afib: 1 } },
      { timestamp: 1715003600, ecg: { signalid: 222, afib: 0 } },
    ]);
    const poison = new Error("poison row");
    vi.mocked(prisma.measurement.upsert)
      .mockRejectedValueOnce(poison)
      .mockResolvedValueOnce({ id: "m-2" } as never);

    await expect(syncUserEcg("user-1")).rejects.toThrow("poison row");

    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(2);
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledWith(
      "user-1",
      "IRREGULAR_RHYTHM_NOTIFICATION",
      new Date("2024-05-06T00:00:00.000Z"),
    );
    expect(recordWithingsSyncFailure).toHaveBeenCalledWith(
      "user-1",
      poison,
      "ecg",
    );
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("still captures the AFib verdict when the waveform fetch fails", async () => {
    // List returns an entry, but the signal GET returns a hard-fail body.
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      if (init.body.includes("action=get")) {
        return { status: 200, json: async () => ({ status: 503 }) };
      }
      return {
        status: 200,
        json: async () => ({
          status: 0,
          body: {
            series: [
              { timestamp: 1715000000, ecg: { signalid: 111, afib: 1 } },
            ],
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const imported = await syncUserEcg("user-1");

    // The verdict EVENT row still landed; only the waveform was skipped.
    expect(imported).toBe(1);
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.ecgRecording.upsert).not.toHaveBeenCalled();
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "ecg",
    });
  });
});

describe("syncUserEcg — Withings API plan (status 277)", () => {
  function install277() {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({
        status: 277,
        error:
          "One of the data type requested in this API request is not available in your API plan",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** The leg the plan-state write merged in, read off the raw SQL values. */
  function persistedLeg(): { leg: unknown; value: unknown } | null {
    const call = vi.mocked(prisma.$executeRaw).mock.calls[0];
    if (!call) return null;
    const values = call.slice(1);
    return { leg: values[0], value: JSON.parse(String(values[1])) };
  }

  it("skips quietly on a 277: no failure, no throw, the refusal remembered", async () => {
    install277();
    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(0);
    expect(recordSyncFailure).not.toHaveBeenCalled();
    expect(recordWithingsSyncFailure).not.toHaveBeenCalled();
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "ecg",
    });
    expect(persistedLeg()).toEqual({
      leg: "ecg",
      value: { unavailable: ["heart"], checkedAt: expect.any(String) },
    });
  });

  it("does not ask the Heart endpoint again while the refusal is fresh", async () => {
    const fetchMock = install277();
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      id: "connection-1",
      apiPlanState: {
        version: 1,
        ecg: { unavailable: ["heart"], checkedAt: new Date().toISOString() },
      },
    } as never);

    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSyncFailure).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("re-probes after a week and forgets the refusal when the plan now allows it", async () => {
    const fetchMock = installFetchMock([]);
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      id: "connection-1",
      apiPlanState: {
        version: 1,
        ecg: {
          unavailable: ["heart"],
          checkedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        },
      },
    } as never);

    await syncUserEcg("user-1");

    expect(fetchMock).toHaveBeenCalled();
    expect(persistedLeg()).toEqual({
      leg: "ecg",
      value: { unavailable: [], checkedAt: expect.any(String) },
    });
  });
});
