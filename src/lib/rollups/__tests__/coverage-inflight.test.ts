import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));

import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { probeRollupCoverage } from "../measurement-coverage";

function inRequest<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const event = new WideEventBuilder();
  event.setHttp({ method, path: "/api/x", route: "/api/x", status: 200 });
  return eventStorage.run(event, fn);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  queryRaw.mockReset();
});

describe("probeRollupCoverage single-flight", () => {
  it("shares one query between concurrent probes of an account", async () => {
    const rows = deferred<Array<{ type: string; has_buckets: boolean }>>();
    queryRaw.mockReturnValueOnce(rows.promise);

    const a = probeRollupCoverage("u1");
    const b = probeRollupCoverage("u1");
    rows.resolve([
      { type: "PULSE", has_buckets: true },
      { type: "WEIGHT", has_buckets: false },
    ]);
    const [ma, mb] = await Promise.all([a, b]);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(ma)).toEqual({ PULSE: true, WEIGHT: false });
    expect(mb).toEqual(ma);
    // Each caller owns its map.
    expect(mb).not.toBe(ma);
    ma.set("PULSE", false);
    expect(mb.get("PULSE")).toBe(true);
  });

  it("keeps nothing once the query settles, and never joins across accounts", async () => {
    queryRaw.mockResolvedValue([{ type: "PULSE", has_buckets: true }]);
    await probeRollupCoverage("u1");
    await probeRollupCoverage("u1");
    await Promise.all([probeRollupCoverage("u1"), probeRollupCoverage("u2")]);
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });

  it("starts afresh after a measurement write", async () => {
    const first = deferred<Array<{ type: string; has_buckets: boolean }>>();
    queryRaw
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }]);

    const before = probeRollupCoverage("u1");
    invalidateUserMeasurements("u1");
    const after = probeRollupCoverage("u1");
    first.resolve([]);

    expect((await before).size).toBe(0);
    expect(Object.fromEntries(await after)).toEqual({ WEIGHT: false });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("passes a failure to every joined caller and does not keep it", async () => {
    const failing = deferred<Array<{ type: string; has_buckets: boolean }>>();
    queryRaw
      .mockReturnValueOnce(failing.promise)
      .mockResolvedValueOnce([{ type: "PULSE", has_buckets: true }]);

    const a = probeRollupCoverage("u1");
    const b = probeRollupCoverage("u1");
    failing.reject(new Error("db down"));
    await expect(a).rejects.toThrow("db down");
    await expect(b).rejects.toThrow("db down");

    expect((await probeRollupCoverage("u1")).get("PULSE")).toBe(true);
  });
});

/**
 * In a GET request the first answer holds for every later probe, so the
 * number of statements a request sends does not depend on whether its
 * readers' probes happened to overlap. The budgets of the hot routes saw the
 * digest send one more statement in one run in eight on the same fixture.
 */
describe("probeRollupCoverage within one GET request", () => {
  it("answers probes that start after the first one settled from it", async () => {
    queryRaw.mockResolvedValue([{ type: "PULSE", has_buckets: true }]);
    await inRequest("GET", async () => {
      const first = await probeRollupCoverage("u1");
      const later = await probeRollupCoverage("u1");
      await Promise.all([probeRollupCoverage("u1"), probeRollupCoverage("u1")]);
      expect(later).toEqual(first);
      // Still a copy per caller.
      expect(later).not.toBe(first);
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("probes again in the next request, for another account, and outside a GET", async () => {
    queryRaw.mockResolvedValue([{ type: "PULSE", has_buckets: true }]);
    await inRequest("GET", () => probeRollupCoverage("u1"));
    await inRequest("GET", async () => {
      await probeRollupCoverage("u1");
      await probeRollupCoverage("u2");
    });
    await inRequest("POST", async () => {
      await probeRollupCoverage("u1");
      await probeRollupCoverage("u1");
    });
    expect(queryRaw).toHaveBeenCalledTimes(5);
  });

  it("never answers from before a measurement write in the same request", async () => {
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }]);
    await inRequest("GET", async () => {
      expect((await probeRollupCoverage("u1")).size).toBe(0);
      invalidateUserMeasurements("u1");
      expect(Object.fromEntries(await probeRollupCoverage("u1"))).toEqual({
        WEIGHT: false,
      });
      // The fresh answer is the one held from here on.
      await probeRollupCoverage("u1");
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("does not hold a failed probe", async () => {
    queryRaw
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce([{ type: "PULSE", has_buckets: true }]);
    await inRequest("GET", async () => {
      await expect(probeRollupCoverage("u1")).rejects.toThrow("db down");
      expect((await probeRollupCoverage("u1")).get("PULSE")).toBe(true);
      await probeRollupCoverage("u1");
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
