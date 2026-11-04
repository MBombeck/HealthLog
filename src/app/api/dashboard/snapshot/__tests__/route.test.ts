/**
 * v1.7.0 — route tests for GET /api/dashboard/snapshot.
 *
 *   - 401 envelope when unauthenticated;
 *   - 200 `{ data, error }` envelope with the snapshot body when
 *     authenticated;
 *   - a repeat call hits the cache (builder runs once);
 *   - the snapshot key carries a per-key TTL longer than the 120 s
 *     client refetch interval so a scheduled poll stays a cache hit
 *     (the entry outlives the analytics bucket's 60 s default), while a
 *     measurement-write invalidation still evicts it.
 *
 * The builder is mocked — its own assembly contract is covered by
 * `src/lib/dashboard/__tests__/snapshot.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  // The cached briefing text is read off its own row, not the session user.
  prisma: { user: { findUnique: async () => null } },
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
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
vi.mock("@/lib/dashboard/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/snapshot")>()),
  buildDashboardSnapshot: (...a: unknown[]) => buildDashboardSnapshot(...a),
}));
// The per-read briefing capability; its own behaviour is pinned in
// `snapshot-read-briefing-capability.test.ts`.
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityToServe: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests, caches } from "@/lib/cache/server-cache";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";

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
    // Inverted 2026-09: the payload no longer carries a wall-clock hour.
    // The body is served stale for up to an hour, so a baked-in hour could
    // name a salutation the clock had long left behind. Clients read the
    // resolved `timezone` and their own live clock instead.
    expect(json.data.user).not.toHaveProperty("greetingHour");
    expect(json.data.user.timezone).toBe("Europe/Berlin");
    // bfcache-friendly directive present.
    expect(res.headers.get("Cache-Control")).toContain("private");
  });

  it("serves the second call from cache (builder runs once)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq());
    await callGet(makeReq());
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);
  });

  it("stays cached past the 120 s client refetch interval (per-key TTL)", async () => {
    vi.useFakeTimers();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq());
    // The analytics bucket default is 60 s; the snapshot key carries a
    // longer per-key TTL so the 120 s scheduled refetch is a hit.
    vi.advanceTimersByTime(120_000);
    await callGet(makeReq());
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("rebuilds after a measurement write once the stale entry is gone", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq());
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);
    // v1.12.7 — a measurement write now marks the `${userId}|` prefix
    // stale rather than hard-evicting. A plain `get()` treats a
    // marked-stale entry (expiresAt === now) as a miss and removes it.
    invalidateUserMeasurements("user-1");
    expect(caches.analytics.get("user-1|dashboard-snapshot")).toBeNull();
    await callGet(makeReq());
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(2);
  });

  it("serves the prior snapshot stale + warms a background rebuild on a measurement write (A4)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Warm the snapshot.
    const first = await callGet(makeReq());
    expect((await first.json()).data.briefingState).toBe("preparing");
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);

    // The next rebuild would produce a different body.
    const FRESH_BODY = { ...SNAPSHOT_BODY, briefingState: "ready" };
    buildDashboardSnapshot.mockResolvedValue(FRESH_BODY);

    // A measurement write marks the bucket stale (no hard evict, no
    // intervening get()). The entry stays servable inside the SWR window.
    invalidateUserMeasurements("user-1");

    // The next read serves the PRIOR (stale) body immediately and kicks
    // off a single background recompute — the foreground request does not
    // pay the cold rebuild.
    const stale = await callGet(makeReq());
    expect((await stale.json()).data.briefingState).toBe("preparing");

    // Let the detached background rebuild settle, then a follow-up read
    // sees the freshly-warmed body.
    await new Promise((r) => setTimeout(r, 0));
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(2);
    const fresh = await callGet(makeReq());
    expect((await fresh.json()).data.briefingState).toBe("ready");
  });
});
