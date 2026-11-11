import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The health status card reads two engines that walk every vital over up to
 * 180 days. The answer is kept in the record's analytics cell: a second open
 * of Insights serves it, and a write that sweeps the record's cells, or a
 * module switch, computes it again.
 */

const computeCoincidentDeviation = vi.fn();
const buildExtendedChangepointSignals = vi.fn();
const resolveModuleMap = vi.fn();

vi.mock("@/lib/insights/derived/coincident-deviation", () => ({
  computeCoincidentDeviation: (...args: unknown[]) =>
    computeCoincidentDeviation(...args),
}));
vi.mock("@/lib/insights/derived/changepoint", () => ({
  buildExtendedChangepointSignals: (...args: unknown[]) =>
    buildExtendedChangepointSignals(...args),
}));
vi.mock("@/lib/insights/derived", () => ({
  loadBaselineProfile: vi.fn().mockResolvedValue({ ageYears: 40 }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  resolveModuleMap: (userId: string) => resolveModuleMap(userId),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAnalyticsReadRateLimit: vi.fn(),
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
import { getSession } from "@/lib/auth/session";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";

const call = () => GET();

beforeEach(() => {
  __resetAllCachesForTests();
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: {
      id: "user-1",
      username: "testuser",
      role: "USER",
      timezone: "Europe/Berlin",
    },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
  vi.mocked(checkAnalyticsReadRateLimit).mockResolvedValue({
    allowed: true,
  } as unknown as Awaited<ReturnType<typeof checkAnalyticsReadRateLimit>>);
  computeCoincidentDeviation
    .mockReset()
    .mockResolvedValue({ status: "insufficient" });
  buildExtendedChangepointSignals.mockReset().mockResolvedValue([]);
  resolveModuleMap.mockReset().mockResolvedValue({});
});

describe("GET /api/insights/health-status — the cached answer", () => {
  it("computes once for two opens", async () => {
    const first = await call();
    const second = await call();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(computeCoincidentDeviation).toHaveBeenCalledTimes(1);
    expect(buildExtendedChangepointSignals).toHaveBeenCalledTimes(1);
    expect((await second.json()).data).toEqual((await first.json()).data);
  });

  it("computes again after a measurement write", async () => {
    await call();
    invalidateUserMeasurements("user-1", { evict: true });
    await call();

    expect(computeCoincidentDeviation).toHaveBeenCalledTimes(2);
  });

  it("computes again when a module is switched off", async () => {
    await call();
    resolveModuleMap.mockResolvedValue({ sleep: false });
    await call();

    expect(buildExtendedChangepointSignals).toHaveBeenCalledTimes(2);
    expect(buildExtendedChangepointSignals).toHaveBeenLastCalledWith(
      "user-1",
      expect.any(Date),
      { sleep: false },
    );
  });
});
