import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationIntakeEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    medication: { update: vi.fn() },
    medicationComplianceRollup: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
    // v1.4.39 QA F-H-01 — coverage probe + atomic upsert use raw SQL.
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => null,
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

import { GET, POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.34 IW-G — reset compliance LRU between tests so each case
  // observes a cold cache.
  __resetAllCachesForTests();
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  // v1.4.39 W-MED — default the coverage probe to "uncovered" so the
  // legacy compliance test still exercises the live-fallback branch
  // and finds the legacy mocked intake events.
  vi.mocked(prisma.medicationComplianceRollup.findFirst).mockResolvedValue(
    null,
  );
  vi.mocked(prisma.medicationComplianceRollup.findMany).mockResolvedValue(
    [] as never,
  );
  // v1.4.39 QA F-H-01 — the coverage probe is now a single `$queryRaw`
  // aggregate returning `{ rolled_days, event_days }`. Default to
  // "zero rollups, zero events" (covered/trivial-empty) so tests that
  // don't care about coverage land on the rollup path.
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { rolled_days: BigInt(0), event_days: BigInt(0) },
  ] as never);
});

describe("GET /api/medications/intake", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=today"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid scope", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=junk"),
    );
    expect(res.status).toBe(422);
  });

  it("returns today's events as a flat array", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        id: "e1",
        medicationId: "m1",
        scheduledFor: new Date(),
        takenAt: null,
        skipped: false,
        medication: { id: "m1", snoozedUntil: null },
      },
    ] as never);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=today"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; status: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe("pending");
  });

  it("returns compliance buckets for the last N days", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        scheduledFor: new Date(),
        takenAt: new Date(),
        skipped: false,
      },
    ] as never);
    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=7",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ date: string; scheduled: number; taken: number }>;
    };
    expect(body.data.length).toBe(7);
  });
});

describe("POST /api/medications/intake", () => {
  function req(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(req({ intakeId: "e1", status: "taken" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the event isn't owned by the user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue({
      id: "e1",
      userId: "someone-else",
      medicationId: "m1",
    } as never);
    const res = await POST(req({ intakeId: "e1", status: "taken" }));
    expect(res.status).toBe(404);
  });

  it("returns 422 for invalid status", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(req({ intakeId: "e1", status: "broken" }));
    expect(res.status).toBe(422);
  });

  it("marks event as skipped", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: new Date("2026-05-18T10:00:00.000Z"),
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
      skipped: true,
      takenAt: null,
    } as never);
    const res = await POST(req({ intakeId: "e1", status: "skipped" }));
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { takenAt: null, skipped: true },
    });
  });
});

describe("v1.4.39 W-MED — compliance rollup read swap", () => {
  it("reads the rollup tier when coverage is present", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // QA F-H-01 (v1.4.39): coverage probe returns
    // `{ rolled_days >= event_days }` so the route lands on the
    // rollup tier. Match the trailing-7-day window.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { rolled_days: BigInt(7), event_days: BigInt(7) },
    ] as never);
    vi.mocked(prisma.medicationComplianceRollup.findMany).mockResolvedValue([
      { day: "2026-05-18", scheduled: 3, taken: 2, skipped: 1 },
    ] as never);

    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=7",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ date: string; scheduled: number; taken: number }>;
    };
    expect(body.data).toHaveLength(7);
    const today = body.data[body.data.length - 1];
    expect(today.scheduled).toBe(3);
    expect(today.taken).toBe(2);
    // The legacy live aggregator must not have run when coverage is hot.
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the live aggregator on coverage miss", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // QA F-H-01 (v1.4.39): partial coverage — events present but
    // rollups missing — forces fall-through to the live aggregator.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { rolled_days: BigInt(0), event_days: BigInt(7) },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        scheduledFor: new Date(),
        takenAt: new Date(),
        skipped: false,
      },
    ] as never);

    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=7",
      ),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.findMany).toHaveBeenCalled();
  });
});
