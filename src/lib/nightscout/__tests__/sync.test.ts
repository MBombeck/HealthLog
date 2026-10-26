import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchSgvEntriesMock,
  getCredsMock,
  upsertMock,
  findManyMock,
  emitArrivalsMock,
  recordSuccessMock,
  recordFailureMock,
  recomputeMock,
  invalidateMock,
} = vi.hoisted(() => ({
  fetchSgvEntriesMock: vi.fn(),
  getCredsMock: vi.fn(),
  upsertMock: vi.fn(),
  findManyMock: vi.fn(),
  emitArrivalsMock: vi.fn(),
  recordSuccessMock: vi.fn(),
  recordFailureMock: vi.fn(),
  recomputeMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getUserNightscoutCredentials: getCredsMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { upsert: upsertMock, findMany: findManyMock } },
}));

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: emitArrivalsMock,
}));

vi.mock("@/lib/integrations/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/status")>()),
  recordSyncSuccess: recordSuccessMock,
  recordSyncFailure: recordFailureMock,
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
  recomputeBucketsForKeys: async (
    userId: string,
    keys: Array<{ type: string; measuredAt: Date }>,
  ) => {
    for (const k of keys) await recomputeMock(userId, k.type, k.measuredAt);
  },
}));

vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: invalidateMock,
}));

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return { ...actual, fetchSgvEntries: fetchSgvEntriesMock };
});

import { syncUserNightscout } from "../sync";
import { NightscoutApiError } from "../client";

const CREDS = {
  baseUrl: "https://ns.example.com",
  token: "tok",
  allowPrivateHost: false,
};

const ENTRY_A = { id: "abc", sgv: 112, date: 1718000000000 };
const ENTRY_B = { id: "def", sgv: 98, date: 1718000300000 };

beforeEach(() => {
  fetchSgvEntriesMock.mockReset();
  getCredsMock.mockReset();
  upsertMock.mockReset();
  findManyMock.mockReset();
  emitArrivalsMock.mockReset();
  recordSuccessMock.mockReset();
  recordFailureMock.mockReset();
  recomputeMock.mockReset();
  invalidateMock.mockReset();
  getCredsMock.mockResolvedValue(CREDS);
  upsertMock.mockResolvedValue({ id: "row" });
  // Default: no rows pre-exist → every entry is a fresh insert.
  findManyMock.mockResolvedValue([]);
  emitArrivalsMock.mockResolvedValue(undefined);
  invalidateMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncUserNightscout", () => {
  it("returns an empty result and records nothing when the user is not configured", async () => {
    getCredsMock.mockResolvedValue(null);
    const result = await syncUserNightscout("u1");
    expect(result).toEqual({ imported: 0, failed: false });
    expect(fetchSgvEntriesMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("writes each SGV entry as a BLOOD_GLUCOSE mg/dL measurement", async () => {
    fetchSgvEntriesMock.mockResolvedValue([ENTRY_A, ENTRY_B]);
    const result = await syncUserNightscout("u1");
    expect(result).toEqual({ imported: 2, failed: false });
    expect(upsertMock).toHaveBeenCalledTimes(2);
    const first = upsertMock.mock.calls[0]![0];
    expect(first.create.type).toBe("BLOOD_GLUCOSE");
    expect(first.create.unit).toBe("mg/dL");
    expect(first.create.source).toBe("NIGHTSCOUT");
    expect(first.create.value).toBe(112);
  });

  it("keys the upsert on (userId,type,source,externalId) for idempotency", async () => {
    fetchSgvEntriesMock.mockResolvedValue([ENTRY_A]);
    await syncUserNightscout("u1");
    const where =
      upsertMock.mock.calls[0]![0].where.userId_type_source_externalId;
    expect(where).toEqual({
      userId: "u1",
      type: "BLOOD_GLUCOSE",
      source: "NIGHTSCOUT",
      externalId: "ns:abc",
    });
  });

  it("is first-write-wins — the update branch never overwrites value", async () => {
    fetchSgvEntriesMock.mockResolvedValue([ENTRY_A]);
    await syncUserNightscout("u1");
    const arg = upsertMock.mock.calls[0]![0];
    // An immutable sample: update must not carry a new value/measuredAt.
    expect(arg.update).not.toHaveProperty("value");
    expect(arg.update).not.toHaveProperty("measuredAt");
    // But it DOES carry the resurrection — Nightscout owns its rows, so a
    // re-synced reading clears a tombstone (no-op on a live row).
    expect(arg.update).toEqual({ deletedAt: null });
  });

  it("records sync success after a clean pass", async () => {
    fetchSgvEntriesMock.mockResolvedValue([ENTRY_A]);
    await syncUserNightscout("u1");
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "nightscout");
  });

  it("does not forward a legacy stored boolean as private-egress authority", async () => {
    getCredsMock.mockResolvedValue({
      baseUrl: "http://10.0.0.4:1337",
      token: "tok",
      allowPrivateHost: true,
    });
    fetchSgvEntriesMock.mockResolvedValue([]);

    await syncUserNightscout("u1");

    expect(fetchSgvEntriesMock).toHaveBeenCalledTimes(1);
    expect(fetchSgvEntriesMock.mock.calls[0]![0]).not.toHaveProperty(
      "allowPrivateHost",
    );
  });

  it("records a stable operator-action reason when a legacy private row is no longer approved", async () => {
    getCredsMock.mockResolvedValue({
      baseUrl: "http://10.0.0.4:1337",
      token: "tok",
      allowPrivateHost: true,
    });
    fetchSgvEntriesMock.mockRejectedValue(
      Object.assign(
        new Error(
          "GET http://10.0.0.4:1337/api/v1/entries.json?token=tok refused",
        ),
        { reasonCode: "private_origin_not_approved" },
      ),
    );

    await expect(syncUserNightscout("u1")).rejects.toThrow();

    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "nightscout",
        kind: "persistent",
        message: "private_origin_not_approved",
      }),
    );
    const recorded = JSON.stringify(recordFailureMock.mock.calls[0]![0]);
    expect(recorded).not.toContain("10.0.0.4");
    expect(recorded).not.toContain("tok");
  });

  it("N-1 — counts only fresh inserts and emits ONLY the newly-inserted rows", async () => {
    fetchSgvEntriesMock.mockResolvedValue([ENTRY_A, ENTRY_B]);
    // ENTRY_A already exists (a re-confirm); ENTRY_B is genuinely new.
    findManyMock.mockResolvedValue([{ externalId: "ns:abc" }]);

    const result = await syncUserNightscout("u1");

    // The inflated insert+reconfirm count used to fire the reminder-satisfy
    // trigger every tick; the honest count is the single fresh insert.
    expect(result).toEqual({ imported: 1, failed: false });
    // Both rows are still written (idempotent), but only the fresh one emits.
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(emitArrivalsMock).toHaveBeenCalledTimes(1);
    const [uid, rows, source] = emitArrivalsMock.mock.calls[0]!;
    expect(uid).toBe("u1");
    expect(source).toBe("nightscout");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "BLOOD_GLUCOSE",
      measuredAt: new Date(1718000300000),
    });
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "nightscout");
  });

  it("N-2 — a partial row failure records a transient failure and SKIPS success", async () => {
    fetchSgvEntriesMock.mockResolvedValue([ENTRY_A, ENTRY_B]);
    findManyMock.mockResolvedValue([]);
    upsertMock
      .mockResolvedValueOnce({ id: "r1" })
      .mockRejectedValueOnce(new Error("bad row"));

    const result = await syncUserNightscout("u1");

    // The one good row still landed; the tick is honest about the failed row —
    // the count alone used to narrow that away, so the card called a window in
    // which nothing wrote a success.
    expect(result).toEqual({ imported: 1, failed: true });
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "nightscout",
        kind: "transient",
        message: "1 of 2 SGV rows failed to write",
      }),
    );
  });

  it("records a failure and rethrows when the instance is unreachable", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new NightscoutApiError("Nightscout responded 401", 401),
    );
    await expect(syncUserNightscout("u1")).rejects.toThrow();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    const arg = recordFailureMock.mock.calls[0]![0];
    expect(arg.integration).toBe("nightscout");
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("classifies a 401/403 as reauth_required", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new NightscoutApiError("Nightscout responded 403", 403),
    );
    await expect(syncUserNightscout("u1")).rejects.toThrow();
    expect(recordFailureMock.mock.calls[0]![0].kind).toBe("reauth_required");
  });

  it("classifies a network error as transient", async () => {
    fetchSgvEntriesMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(syncUserNightscout("u1")).rejects.toThrow();
    expect(recordFailureMock.mock.calls[0]![0].kind).toBe("transient");
  });

  it("redacts the token from the recorded lastError message", async () => {
    // A SafeFetchError embeds the full target URL — including `?token=<secret>`
    // — in its message; the recorded lastError must never leak it.
    fetchSgvEntriesMock.mockRejectedValue(
      new Error(
        "safeFetch network error: https://ns.example.com/api/v1/entries.json?count=576&type=sgv&token=ns-secret-abc123",
      ),
    );
    await expect(syncUserNightscout("u1")).rejects.toThrow();
    const message = recordFailureMock.mock.calls[0]![0].message as string;
    expect(message).not.toContain("ns-secret-abc123");
    expect(message).toContain("token=REDACTED");
    // The rest of the diagnostic is preserved.
    expect(message).toContain("ns.example.com");
  });

  it("also redacts a classic api-secret query param", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new Error(
        "safeFetch refused private or non-public host: https://ns.lan/api/v1/entries.json?api-secret=deadbeef",
      ),
    );
    await expect(syncUserNightscout("u1")).rejects.toThrow();
    const message = recordFailureMock.mock.calls[0]![0].message as string;
    expect(message).not.toContain("deadbeef");
    expect(message).toContain("api-secret=REDACTED");
  });

  it("recomputes rollup buckets for the imported readings", async () => {
    fetchSgvEntriesMock.mockResolvedValue([ENTRY_A, ENTRY_B]);
    await syncUserNightscout("u1");
    expect(recomputeMock).toHaveBeenCalled();
    expect(invalidateMock).toHaveBeenCalled();
  });
});
