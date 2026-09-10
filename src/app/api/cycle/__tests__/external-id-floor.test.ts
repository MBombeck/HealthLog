/**
 * The two single-entry cycle writes — `POST /api/cycle/day-logs` and
 * `POST /api/cycle/period` — against the external-id stability floor.
 *
 * Both upsert on `(userId, source, externalId)`, so an id that changes
 * between two launches of the same client never matches its own earlier
 * row: the mirror mints a fresh day log (or a fresh period marker) on
 * every sweep. Unlike their bulk twin these are single-entry, so the
 * refusal is the standard 422 multi-issue envelope and nothing is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    cycleDayLog: {
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
    menstrualCycle: {
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
  // The shared single-record write ceiling. Allowed here: this file is about
  // what the handler does with a body it accepted, not about the bucket.
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 300,
    remaining: 299,
    resetAt: Date.now() + 60_000,
  })),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/cycle/gate", () => ({
  requireCycleEnabled: vi.fn(),
}));
vi.mock("@/lib/cycle/day-log-write", () => ({
  upsertCycleDayLog: vi.fn(),
}));
vi.mock("@/lib/cycle/cycle-attribution", () => ({
  findOwningCycleId: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/cycle/dto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cycle/dto")>()),
  toCycleDayLogDTO: vi.fn(() => ({ id: "day-1" })),
  toMenstrualCycleDTO: vi.fn(() => ({ id: "cycle-1" })),
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

import { POST as postDayLog } from "../day-logs/route";
import { POST as postPeriod } from "../period/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function req(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const POISONED = "<HKHealthConceptIdentifier: 0x12568db80>";
/** What the HealthKit cycle mirror really writes (`import-accumulator.ts`). */
const REAL_ID = "hkcycle:2026-01-01";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireCycleEnabled).mockResolvedValue({
    enabled: true,
    profile: { sensitiveCategoryEncryption: false },
  } as never);
  vi.mocked(upsertCycleDayLog).mockResolvedValue({
    id: "day-1",
    existed: false,
    changed: true,
  } as never);
  vi.mocked(prisma.cycleDayLog.findUniqueOrThrow).mockResolvedValue({
    id: "day-1",
    symptoms: [],
  } as never);
  vi.mocked(prisma.cycleDayLog.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.cycleDayLog.findFirstOrThrow).mockResolvedValue({
    id: "day-1",
    symptoms: [],
  } as never);
  vi.mocked(prisma.menstrualCycle.findUniqueOrThrow).mockResolvedValue({
    id: "cycle-1",
    startDate: "2026-01-01",
  } as never);
});

describe("POST /api/cycle/day-logs — external-id stability floor", () => {
  it("422s on an object-description externalId and writes nothing", async () => {
    const res = await postDayLog(
      req("/api/cycle/day-logs", {
        date: "2026-01-01",
        loggedAt: "2026-01-01T08:00:00.000Z",
        source: "APPLE_HEALTH",
        externalId: POISONED,
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
      meta?: { errorCode?: string };
    };
    const issue = body.details.issues.find((i) => i.path === "externalId");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("stable across app restarts");
    expect(body.meta?.errorCode).toBe("cycle.day-log.invalid");
    expect(upsertCycleDayLog).not.toHaveBeenCalled();
  });

  it("422s on a bare memory-address externalId", async () => {
    const res = await postDayLog(
      req("/api/cycle/day-logs", {
        date: "2026-01-01",
        loggedAt: "2026-01-01T08:00:00.000Z",
        externalId: "0x126b25160",
      }),
    );
    expect(res.status).toBe(422);
    expect(upsertCycleDayLog).not.toHaveBeenCalled();
  });

  it("accepts the HealthKit cycle-day id the mirror really sends", async () => {
    const res = await postDayLog(
      req("/api/cycle/day-logs", {
        date: "2026-01-01",
        loggedAt: "2026-01-01T08:00:00.000Z",
        source: "APPLE_HEALTH",
        externalId: REAL_ID,
      }),
    );
    expect(res.status).toBe(201);
    expect(upsertCycleDayLog).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cycle/period — external-id stability floor", () => {
  it("422s on an object-description externalId and opens no cycle", async () => {
    const res = await postPeriod(
      req("/api/cycle/period", {
        action: "start",
        date: "2026-01-01",
        loggedAt: "2026-01-01T08:00:00.000Z",
        externalId: POISONED,
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
      meta?: { errorCode?: string };
    };
    expect(
      body.details.issues.some(
        (i) =>
          i.path === "externalId" &&
          i.message.includes("stable across app restarts"),
      ),
    ).toBe(true);
    expect(body.meta?.errorCode).toBe("cycle.period.invalid");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts the real HealthKit id and reaches the write transaction", async () => {
    // v1.37.0 — the boundary transaction reports the anchors it moved so the
    // audit row can name them (C4); an empty set is the no-neighbour case.
    vi.mocked(prisma.$transaction).mockResolvedValue({
      cycleId: "cycle-1",
      moved: {},
    } as never);
    const res = await postPeriod(
      req("/api/cycle/period", {
        action: "start",
        date: "2026-01-01",
        loggedAt: "2026-01-01T08:00:00.000Z",
        externalId: REAL_ID,
      }),
    );
    expect(res.status).toBeLessThan(400);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
