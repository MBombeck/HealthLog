/**
 * v1.18.9 — POST /api/labs/ocr/commit.
 *
 * Focus: dedup correctness. A row that duplicates a live reading is skipped,
 * and — the regression this guards — two identical rows inside ONE confirmed
 * document collapse to a single write even though neither is yet visible to a
 * live query. The in-memory seen-set makes in-batch dedup independent of DB
 * visibility, rather than relying on the prior row autocommitting first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    // v1.43 — the account's markers and aliases, loaded once per commit.
    biomarker: { findMany: vi.fn() },
    biomarkerAlias: { findMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
const rateLimitMock = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: rateLimitMock.allowed,
    remaining: rateLimitMock.allowed ? 299 : 0,
    resetAt: new Date(Date.now() + 60_000),
  })),
}));
// The real meter, so the ceiling is proven on the path it now takes: the route
// resolves its caller, the resolver charges the bucket. The unit setup stubs
// the meter for every other route test.
vi.mock("@/lib/auth/write-meter", async (importOriginal) =>
  importOriginal<typeof import("@/lib/auth/write-meter")>(),
);
const tzMock = vi.hoisted(() => ({ zone: "UTC" }));
vi.mock("@/lib/tz/resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tz/resolver")>()),
  resolveUserTimezone: vi.fn(async () => tzMock.zone),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/labs/biomarker-store", () => ({
  resolveOrMintBiomarker: vi.fn(),
}));
vi.mock("@/lib/labs/serialise", () => ({
  serialiseLabResult: (created: { id: string }) => ({ id: created.id }),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const TAKEN_AT = "2026-06-10T08:00:00.000Z";

function numericRow(value: number) {
  return {
    analyte: "Glucose",
    value,
    unit: "mg/dL",
    takenAt: TAKEN_AT,
  };
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/labs/ocr/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  tzMock.zone = "UTC";
  rateLimitMock.allowed = true;
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(enqueueReminderSatisfy).mockResolvedValue(undefined as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // No live reading collides at commit time — the in-batch path is what's
  // under test, so the DB-visibility check returns empty for every row.
  vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.biomarker.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.biomarkerAlias.findMany).mockResolvedValue([] as never);
  let nextId = 0;
  vi.mocked(prisma.labResult.create).mockImplementation((() =>
    Promise.resolve({ id: `lr-${++nextId}` })) as never);
  vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
    id: "bm-1",
    name: "Glucose",
    unit: "mg/dL",
    panel: null,
    lowerBound: null,
    upperBound: null,
  } as never);
});

describe("POST /api/labs/ocr/commit dedup", () => {
  it("collapses identical in-document rows to a single write", async () => {
    const res = await POST(postReq({ rows: [numericRow(95), numericRow(95)] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { inserted: unknown[]; skipped: Array<{ reason: string }> };
    };

    // Only the first row writes; the second is skipped as an in-batch
    // duplicate even though the first never became visible to a live query.
    expect(prisma.labResult.create).toHaveBeenCalledTimes(1);
    expect(body.data.inserted).toHaveLength(1);
    expect(body.data.skipped).toEqual([
      { analyte: "Glucose", reason: "duplicate" },
    ]);
  });

  it("writes distinct values for the same analyte and day", async () => {
    const res = await POST(
      postReq({ rows: [numericRow(95), numericRow(110)] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { inserted: unknown[]; skipped: unknown[] };
    };
    expect(prisma.labResult.create).toHaveBeenCalledTimes(2);
    expect(body.data.inserted).toHaveLength(2);
    expect(body.data.skipped).toHaveLength(0);
  });
});

describe("POST /api/labs/ocr/commit dedup across the user's day", () => {
  /**
   * A database stand-in that honours the `takenAt` range the route asks for,
   * so the test sees what the real query would return.
   */
  function liveReadings(rows: Array<{ value: number; takenAt: Date }>) {
    vi.mocked(prisma.labResult.findMany).mockImplementation(((args: {
      where: { takenAt: { gte?: Date; lt?: Date; lte?: Date } };
    }) => {
      const { gte, lt, lte } = args.where.takenAt;
      return Promise.resolve(
        rows
          .filter(
            (r) =>
              (!gte || r.takenAt >= gte) &&
              (!lt || r.takenAt < lt) &&
              (!lte || r.takenAt <= lte),
          )
          .map((r) => ({ ...r, valueText: null })),
      );
    }) as never);
  }

  it("skips a scanned reading already entered by hand on the same local day east of UTC", async () => {
    tzMock.zone = "Asia/Tokyo";
    // Entered by hand: 2026-06-10 08:00 in Tokyo, the 9th in UTC.
    liveReadings([
      { value: 95, takenAt: new Date("2026-06-09T23:00:00.000Z") },
    ]);
    // The scan of the same report states the 10th (stored at noon UTC).
    const res = await POST(
      postReq({
        rows: [{ ...numericRow(95), takenAt: "2026-06-10T12:00:00.000Z" }],
      }),
    );
    const body = (await res.json()) as {
      data: { skipped: Array<{ reason: string }> };
    };
    expect(body.data.skipped).toEqual([
      { analyte: "Glucose", reason: "duplicate" },
    ]);
    expect(prisma.labResult.create).not.toHaveBeenCalled();
  });

  it("writes a reading from the neighbouring local day", async () => {
    tzMock.zone = "Asia/Tokyo";
    // 2026-06-09 08:00 in Tokyo: a different day from the scanned 10th.
    liveReadings([
      { value: 95, takenAt: new Date("2026-06-08T23:00:00.000Z") },
    ]);
    await POST(
      postReq({
        rows: [{ ...numericRow(95), takenAt: "2026-06-10T12:00:00.000Z" }],
      }),
    );
    expect(prisma.labResult.create).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/labs/ocr/commit write ceiling", () => {
  it("charges the shared per-account record-write bucket where the caller is resolved", async () => {
    const res = await POST(postReq({ rows: [numericRow(95)] }));
    expect(res.status).toBe(200);
    expect(checkRecordWriteRateLimit).toHaveBeenCalledWith("user-1");
  });

  it("answers 429 record_write.rate_limited and writes nothing once exhausted", async () => {
    rateLimitMock.allowed = false;
    const res = await POST(postReq({ rows: [numericRow(95)] }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("record_write.rate_limited");
    expect(prisma.labResult.create).not.toHaveBeenCalled();
    expect(resolveOrMintBiomarker).not.toHaveBeenCalled();
  });
});
