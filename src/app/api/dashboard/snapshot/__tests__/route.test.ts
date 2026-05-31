/**
 * v1.7.0 W6 — route tests for GET /api/dashboard/snapshot.
 *
 *   - 401 envelope when unauthenticated;
 *   - 200 `{ data, error }` envelope with the snapshot body when
 *     authenticated;
 *   - second call within the 60 s TTL hits the cache (builder runs once).
 *
 * The builder is mocked — its own assembly contract is covered by
 * `src/lib/dashboard/__tests__/snapshot.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {},
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));
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

const buildDashboardSnapshot = vi.fn();
vi.mock("@/lib/dashboard/snapshot", () => ({
  buildDashboardSnapshot: (...a: unknown[]) => buildDashboardSnapshot(...a),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
    timezone: "Europe/Berlin",
    heightCm: 180,
    dateOfBirth: null,
    gender: "MALE",
    glucoseUnit: "mg/dL",
    onboardingTourCompleted: true,
    disableCoach: false,
    insightsCachedText: null,
    insightsCachedAt: null,
    dashboardWidgetsJson: null,
  },
};

const SNAPSHOT_BODY = {
  user: {
    username: "tester",
    timezone: "Europe/Berlin",
    heightCm: 180,
    dateOfBirth: null,
    gender: "MALE",
    glucoseUnit: "mg/dL",
    onboardingTourCompleted: true,
    greetingHour: 9,
  },
  layout: { version: 1, widgets: [] },
  tiles: {
    summaries: {},
    lastSeenByType: {},
    mood: { summary: null, entries: [] },
  },
  extras: null,
  briefing: null,
  briefingState: "preparing",
  briefingUpdatedAt: null,
  generatedAt: new Date().toISOString(),
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/snapshot");
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllCachesForTests();
  buildDashboardSnapshot.mockResolvedValue(SNAPSHOT_BODY);
});

describe("GET /api/dashboard/snapshot", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.data).toBeNull();
    expect(typeof json.error).toBe("string");
  });

  it("returns the snapshot envelope when authenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.error).toBeNull();
    expect(json.data.briefingState).toBe("preparing");
    expect(json.data.tiles).toBeDefined();
    expect(json.data.extras).toBeNull();
    expect(json.data.user.greetingHour).toBe(9);
    // bfcache-friendly directive present.
    expect(res.headers.get("Cache-Control")).toContain("private");
  });

  it("serves the second call from cache (builder runs once)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq());
    await callGet(makeReq());
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);
  });
});
