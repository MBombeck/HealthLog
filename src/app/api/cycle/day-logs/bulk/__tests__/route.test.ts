/**
 * POST /api/cycle/day-logs/bulk — body-size cap.
 *
 * The bulk drain accepts up to 500 entries; the `safeJson` cap (2 MB)
 * rejects an oversized body with 413 before `JSON.parse` builds an
 * object graph.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/cycle/day-logs/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireCycleEnabled).mockResolvedValue({
    enabled: true,
    profile: { sensitiveCategoryEncryption: false },
  } as never);
  vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue([] as never);
});

describe("POST /api/cycle/day-logs/bulk — body cap", () => {
  it("rejects a body over the 2 MB cap with 413 before parsing", async () => {
    const res = await POST(
      postReq({ entries: [], pad: "x".repeat(2 * 1024 * 1024) }),
    );
    expect(res.status).toBe(413);
    expect(upsertCycleDayLog).not.toHaveBeenCalled();
  });

  it("still rejects an over-cap entries array with 422 below the byte cap", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      date: "2026-01-01",
      externalId: `e${i}`,
    }));
    const res = await POST(postReq({ entries }));
    expect(res.status).toBe(422);
    expect(upsertCycleDayLog).not.toHaveBeenCalled();
  });
});

describe("POST /api/cycle/day-logs/bulk — external-id stability floor", () => {
  /**
   * The bulk drain upserts on `(userId, source, externalId)`. A per-launch
   * id never matches its own earlier row, so every re-post mints another
   * day log. Refused PER ENTRY — the client's other days must still land.
   */
  beforeEach(() => {
    let n = 0;
    vi.mocked(upsertCycleDayLog).mockImplementation(
      async () =>
        ({ id: `day-${++n}`, existed: false, changed: true }) as never,
    );
  });

  it("skips the poisoned entry and still writes the two good ones", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            date: "2026-01-01",
            loggedAt: "2026-01-01T08:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hkcycle:2026-01-01",
          },
          {
            date: "2026-01-02",
            loggedAt: "2026-01-02T08:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
          },
          {
            date: "2026-01-03",
            loggedAt: "2026-01-03T08:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        processed: number;
        inserted: number;
        skipped: number;
        entries: Array<{
          index: number;
          status: string;
          reason?: string;
          externalId?: string;
        }>;
      };
    };
    expect(body.data.processed).toBe(3);
    expect(body.data.inserted).toBe(2);
    expect(body.data.skipped).toBe(1);
    expect(body.data.entries[0].status).toBe("inserted");
    expect(body.data.entries[1]).toMatchObject({
      index: 1,
      status: "skipped",
      reason: "unstable_external_id",
      externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
    });
    expect(body.data.entries[2].status).toBe("inserted");
    // Only the two good entries reached the writer.
    expect(upsertCycleDayLog).toHaveBeenCalledTimes(2);
  });

  it("never turns one poisoned entry into a whole-batch 422", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            date: "2026-01-01",
            loggedAt: "2026-01-01T08:00:00.000Z",
            externalId: "0xdeadbeef",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts the HealthKit cycle-day id shape the mirror really sends", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            date: "2026-01-01",
            loggedAt: "2026-01-01T08:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hkcycle:2026-01-01",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries[0].status).toBe("inserted");
    expect(upsertCycleDayLog).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cycle/day-logs/bulk — refusal codes", () => {
  /**
   * The native client files rows under a permanent-refusal register as soon
   * as it can tell the refusal is permanent. It can only tell from the code,
   * so both whole-batch 422s are pinned here, with the envelope they ride.
   */
  async function refusal(body: unknown) {
    const res = await POST(postReq(body));
    return {
      status: res.status,
      body: (await res.json()) as {
        data: null;
        error: string;
        details?: { issues: unknown[] };
        meta?: { errorCode?: string };
      },
    };
  }

  it("names a malformed batch cycle.bulk.invalid, with every issue listed", async () => {
    const { status, body } = await refusal({
      entries: [{ date: "not-a-day" }, { date: "2026-13-40" }],
    });
    expect(status).toBe(422);
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("cycle.bulk.invalid");
    expect(body.details?.issues.length).toBeGreaterThanOrEqual(2);
    expect(upsertCycleDayLog).not.toHaveBeenCalled();
  });

  it("names a batch with no entries array cycle.bulk.invalid", async () => {
    const { status, body } = await refusal({});
    expect(status).toBe(422);
    expect(body.meta?.errorCode).toBe("cycle.bulk.invalid");
  });

  it("names an over-cap batch cycle.bulk.too_large", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      date: "2026-01-01",
      externalId: `e${i}`,
    }));
    const { status, body } = await refusal({ entries });
    expect(status).toBe(422);
    expect(body.meta?.errorCode).toBe("cycle.bulk.too_large");
  });
});

describe("POST /api/cycle/day-logs/bulk — a failed write is not cached", () => {
  it("marks a response carrying upsert_failed no-store and leaves a clean one alone", async () => {
    vi.mocked(upsertCycleDayLog).mockRejectedValueOnce(new Error("reset"));
    const failed = await POST(
      postReq({
        entries: [{ date: "2026-01-01", loggedAt: "2026-01-01T08:00:00.000Z" }],
      }),
    );
    expect(failed.status).toBe(200);
    const body = (await failed.json()) as {
      data: { entries: Array<{ status: string; reason?: string }> };
    };
    expect(body.data.entries[0]).toMatchObject({
      status: "skipped",
      reason: "upsert_failed",
    });
    expect(failed.headers.get("Cache-Control")).toBe("private, no-store");

    vi.mocked(upsertCycleDayLog).mockResolvedValueOnce({
      id: "d1",
      existed: false,
      changed: true,
    } as never);
    const clean = await POST(
      postReq({
        entries: [{ date: "2026-01-02", loggedAt: "2026-01-02T08:00:00.000Z" }],
      }),
    );
    expect(clean.headers.get("Cache-Control")).not.toBe("private, no-store");
  });
});
