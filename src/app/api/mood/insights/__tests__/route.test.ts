/**
 * `GET /api/mood/insights?days=N` serves the stability score for the period
 * a client shows. The aggregate is cached once per user with every window in
 * it; the route picks one, names it, and keeps the per-window map off the
 * wire.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("@/lib/cache/server-cache", () => ({
  cachedSwr: vi.fn(),
  caches: { moodInsights: {} },
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
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
import { cachedSwr } from "@/lib/cache/server-cache";
import { requireModuleEnabled } from "@/lib/modules/gate";

const year = { score: 40, stdDev: 0.9, band: "variable", days: 300 };
const month = { score: 90, stdDev: 0.2, band: "verySteady", days: 28 };

const AGGREGATE = {
  summary: { totalEntries: 300 },
  heatmap: { windowDays: 365, cells: [] },
  tags: [],
  stability: year,
  stabilityByWindow: { 30: month, 90: null, 180: year, 365: year },
};

const call = (query = "") =>
  (GET as (req: Request) => Promise<Response>)(
    new Request(`http://localhost/api/mood/insights${query}`),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "s", expiresAt: new Date(Date.now() + 3_600_000) },
    user: { id: "user-1", username: "u", role: "USER", timezone: "UTC" },
  } as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(cachedSwr).mockResolvedValue(AGGREGATE as never);
});

describe("GET /api/mood/insights — stability per period", () => {
  it("serves the whole year by default and names the window", async () => {
    const body = await (await call()).json();
    expect(body.data.stability).toEqual(year);
    expect(body.data.stabilityWindowDays).toBe(365);
    expect(body.data).not.toHaveProperty("stabilityByWindow");
  });

  it("serves the chosen window as stability on ?days=30", async () => {
    const body = await (await call("?days=30")).json();
    expect(body.data.stability).toEqual(month);
    expect(body.data.stabilityWindowDays).toBe(30);
  });

  it("answers null, not the year's score, when the window has too few days", async () => {
    const body = await (await call("?days=90")).json();
    expect(body.data.stability).toBeNull();
    expect(body.data.stabilityWindowDays).toBe(90);
  });

  it("refuses a window it does not offer", async () => {
    const res = await call("?days=45");
    expect(res.status).toBe(422);
    expect(cachedSwr).not.toHaveBeenCalled();
  });
});
