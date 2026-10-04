import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));

import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { probeRollupCoverage } from "../measurement-coverage";

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
