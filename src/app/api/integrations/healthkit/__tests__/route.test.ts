import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    // v1.4.43 W6 — audit-ledger breadcrumb for validation-failed paths.
    auditLog: { create: vi.fn() },
    // Per-metric freshness + first-run sync progress for the APPLE_HEALTH
    // source (#778).
    measurement: { aggregate: vi.fn() },
    workout: { groupBy: vi.fn(), aggregate: vi.fn() },
    // v1.42 — the newest sample per live type is one raw probe per type, and
    // the per-type arrival ledger (#1173) is read beside it.
    $queryRaw: vi.fn(),
    healthKitTypeSync: { findMany: vi.fn() },
  },
  toJson: <T>(v: T) => v,
}));

vi.mock("@/lib/measurements/live-types", () => ({
  listLiveMeasurementTypes: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { listLiveMeasurementTypes } from "@/lib/measurements/live-types";
import { APPLE_HEALTH_DATA_STALE_AFTER_MS } from "@/lib/integrations/sync-verdict";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    healthKitConfigJson: null,
    healthKitLastSyncedAt: null,
  } as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(listLiveMeasurementTypes).mockResolvedValue([]);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.healthKitTypeSync.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.workout.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.aggregate).mockResolvedValue({
    _count: { _all: 0 },
    _min: { measuredAt: null },
  } as never);
  vi.mocked(prisma.workout.aggregate).mockResolvedValue({
    _count: { _all: 0 },
    _min: { startedAt: null },
  } as never);
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeGetReq(): NextRequest {
  return new NextRequest("http://localhost/api/integrations/healthkit");
}

describe("GET /api/integrations/healthkit", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(401);
  });

  it("returns the default entries when nothing is stored", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ id: string; direction: string }> };
    };
    expect(body.data.entries.length).toBeGreaterThan(0);
    const bodyMass = body.data.entries.find((e) => e.id === "bodyMass");
    expect(bodyMass?.direction).toBe("bidirectional");
  });
});

describe("PATCH /api/integrations/healthkit", () => {
  function req(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/integrations/healthkit", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await PATCH(req({ entries: [] }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid direction", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      req({ entries: [{ id: "bodyMass", direction: "FOO" }] }),
    );
    expect(res.status).toBe(422);
  });

  it("updates known entries and silently ignores unknown ids", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      req({
        entries: [
          { id: "bodyMass", direction: "readOnly" },
          { id: "totallyUnknown", direction: "bidirectional" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArgs = vi.mocked(prisma.user.update).mock
      .calls[0][0] as unknown as {
      data: { healthKitConfigJson: { entries: Array<{ id: string }> } };
    };
    const ids = updateArgs.data.healthKitConfigJson.entries.map((e) => e.id);
    expect(ids).toContain("bodyMass");
    expect(ids).not.toContain("totallyUnknown");
  });
});

describe("PATCH /api/integrations/healthkit — 422 multi-issue (v1.4.43 W6)", () => {
  function patchReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/integrations/healthkit", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Two bad entries: first with bad direction, second with empty id.
    const res = await PATCH(
      patchReq({
        entries: [
          { id: "bodyMass", direction: "JUNK" },
          { id: "", direction: "readOnly" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      patchReq({
        entries: [
          { id: "bodyMass", direction: "JUNK1" },
          { id: "", direction: "JUNK2" },
          { id: "weight", direction: "JUNK3" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes the audit-ledger row keyed integrations.healthkit.validation-failed", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      patchReq({ entries: [{ id: "bodyMass", direction: "JUNK" }] }),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe("integrations.healthkit.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await PATCH(
      patchReq({ entries: [{ id: "bodyMass", direction: "JUNK" }] }),
    );
    expect(res.status).toBe(422);
  });
});

/**
 * Apple Health is push-based and has no ledger row, so `lastSyncedAt` was the
 * only signal the card had — and its mere presence painted green, whether the
 * data arrived this morning or three weeks ago. These pin the seven-day
 * threshold and the per-metric read that makes a silently revoked HealthKit
 * permission visible inside an otherwise healthy connection.
 */
describe("GET /api/integrations/healthkit — sync health", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms);

  type Body = {
    lastSyncedAt: string | null;
    lastSyncTrigger: string | null;
    lastBackgroundSyncAt: string | null;
    syncHealth: { verdict: string; since: string | null };
    metricFreshness: Array<{
      type: string;
      lastSeenAt: string;
      stale: boolean;
    }>;
    syncProgress: {
      recordsAccepted: number;
      oldestMeasuredAt: string | null;
    } | null;
  };

  async function read(): Promise<Body> {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Body }).data;
  }

  it("calls a recent delivery fresh", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(2 * DAY),
    } as never);
    expect((await read()).syncHealth.verdict).toBe("fresh");
  });

  it("calls a pipe silent for over a week stale", async () => {
    const lastSyncedAt = ago(APPLE_HEALTH_DATA_STALE_AFTER_MS + DAY);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: lastSyncedAt,
    } as never);
    const body = await read();
    expect(body.syncHealth.verdict).toBe("stale");
    expect(body.syncHealth.since).toBe(lastSyncedAt.toISOString());
  });

  it("calls an account that never delivered pending, not disconnected", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: null,
    } as never);
    expect((await read()).syncHealth.verdict).toBe("pending_first_sync");
  });

  it("flags one quiet metric inside an otherwise healthy connection", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(60 * 60 * 1000),
    } as never);
    vi.mocked(listLiveMeasurementTypes).mockResolvedValue([
      "RESPIRATORY_RATE",
      "PULSE",
    ]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { type: "RESPIRATORY_RATE", last_seen: ago(30 * DAY) },
      { type: "PULSE", last_seen: ago(60 * 60 * 1000) },
    ] as never);

    const body = await read();
    // Only the Apple Health source is read.
    expect(vi.mocked(listLiveMeasurementTypes).mock.calls[0]?.[1]).toEqual({
      source: "APPLE_HEALTH",
    });
    const byType = Object.fromEntries(
      body.metricFreshness.map((entry) => [entry.type, entry.stale]),
    );
    expect(byType.RESPIRATORY_RATE).toBe(true);
    expect(byType.PULSE).toBe(false);
  });

  // #586 — the reporter's question is whether the phone delivers on its own or
  // only while the app is open. `lastSyncedAt` reads identically either way, so
  // it cannot answer it; these two fields are what can.
  it("publishes the trigger of the last batch and the last background arrival", async () => {
    const backgroundAt = ago(3 * 60 * 60 * 1000);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(60 * 60 * 1000),
      healthKitLastSyncTrigger: "background",
      healthKitLastBackgroundSyncAt: backgroundAt,
    } as never);

    const body = await read();
    expect(body.lastSyncTrigger).toBe("background");
    expect(body.lastBackgroundSyncAt).toBe(backgroundAt.toISOString());
  });

  it("reports honest absence when the client has never declared a trigger", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(60 * 60 * 1000),
      healthKitLastSyncTrigger: null,
      healthKitLastBackgroundSyncAt: null,
    } as never);

    const body = await read();
    // An older client that reports nothing, and a pipe that has never
    // delivered in the background, both read as null — never as a guess.
    expect(body.lastSyncTrigger).toBeNull();
    expect(body.lastBackgroundSyncAt).toBeNull();
  });

  // #778 — a first-run backfill was invisible from the web: nothing said how
  // many records had arrived or how far back they reached. The GET now carries
  // the two figures the server actually holds.
  it("publishes the accepted-row count and the oldest instant reached", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(60 * 60 * 1000),
    } as never);
    vi.mocked(prisma.measurement.aggregate).mockResolvedValue({
      _count: { _all: 4200 },
      _min: { measuredAt: new Date("2019-05-04T06:00:00.000Z") },
    } as never);
    vi.mocked(prisma.workout.aggregate).mockResolvedValue({
      _count: { _all: 12 },
      _min: { startedAt: new Date("2021-01-01T09:00:00.000Z") },
    } as never);

    const body = await read();
    expect(body.syncProgress).toEqual({
      recordsAccepted: 4212,
      oldestMeasuredAt: "2019-05-04T06:00:00.000Z",
    });
  });

  it("degrades to a null progress summary rather than failing the config read", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(DAY),
    } as never);
    vi.mocked(prisma.measurement.aggregate).mockRejectedValue(
      new Error("aggregate hiccup"),
    );
    const body = await read();
    expect(body.syncProgress).toBeNull();
    expect(body.syncHealth.verdict).toBe("fresh");
  });

  it("degrades to no per-metric data rather than failing the config read", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(DAY),
    } as never);
    vi.mocked(listLiveMeasurementTypes).mockRejectedValue(
      new Error("live-type hiccup"),
    );
    const body = await read();
    expect(body.metricFreshness).toEqual([]);
    expect(body.syncHealth.verdict).toBe("fresh");
  });

  // #1173 — when a type last ARRIVED and under which trigger, beside when its
  // newest sample was taken. A type that only ever comes with "Sync all" is
  // visible as `manual`; a type no live sync carried yet reads null.
  it("lays the per-type arrival facts over the freshness entries", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(60 * 60 * 1000),
    } as never);
    vi.mocked(listLiveMeasurementTypes).mockResolvedValue([
      "RESPIRATORY_RATE",
      "PULSE",
    ]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { type: "RESPIRATORY_RATE", last_seen: ago(2 * DAY) },
      { type: "PULSE", last_seen: ago(60 * 60 * 1000) },
    ] as never);
    vi.mocked(prisma.workout.groupBy).mockResolvedValue([
      { source: "APPLE_HEALTH", _max: { startedAt: ago(DAY) } },
    ] as never);
    const receivedAt = ago(3 * 60 * 60 * 1000);
    vi.mocked(prisma.healthKitTypeSync.findMany).mockResolvedValue([
      {
        type: "RESPIRATORY_RATE",
        lastReceivedAt: receivedAt,
        lastTrigger: "manual",
        lastNewSampleAt: null,
      },
    ] as never);

    const body = await read();
    const byType = Object.fromEntries(
      body.metricFreshness.map((entry) => [entry.type, entry]),
    );
    expect(byType.RESPIRATORY_RATE).toMatchObject({
      lastReceivedAt: receivedAt.toISOString(),
      lastTrigger: "manual",
      lastNewSampleAt: null,
    });
    expect(byType.PULSE).toMatchObject({
      lastReceivedAt: null,
      lastTrigger: null,
      lastNewSampleAt: null,
    });
    // Workouts ride their own batch route, which the ledger does not cover.
    expect(byType.WORKOUTS).not.toHaveProperty("lastReceivedAt");
  });

  it("leaves the arrival facts off when the ledger read fails", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      healthKitConfigJson: null,
      healthKitLastSyncedAt: ago(DAY),
    } as never);
    vi.mocked(listLiveMeasurementTypes).mockResolvedValue(["PULSE"]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { type: "PULSE", last_seen: ago(DAY) },
    ] as never);
    vi.mocked(prisma.healthKitTypeSync.findMany).mockRejectedValue(
      new Error("ledger hiccup"),
    );
    const body = await read();
    expect(body.metricFreshness).toHaveLength(1);
    expect(body.metricFreshness[0]).not.toHaveProperty("lastReceivedAt");
  });
});
