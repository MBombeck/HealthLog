/**
 * v1.28 — `POST /api/nutrients/batch` contract tests.
 *
 * Pins the ingest posture: module gate first (403 `module.disabled`),
 * per-entry skip guards (unit mismatch / plausibility / day key), the
 * insert-vs-update statuses off a single bulk existence probe, and the
 * batch envelope errors (`too_large`, multi-issue `invalid`).
 *
 * v1.29 perf fix — the probe-then-upsert-per-entry pattern (up to 1000
 * sequential round trips) was replaced by one indexed `findMany` existence
 * read + a bulk `createMany` for new pairs + a `$transaction` of per-row
 * `update` calls for existing pairs. `$transaction` is mocked to actually
 * run the array of promises it's handed so the update path executes for
 * real in these tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
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
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserDashboardSnapshot } from "@/lib/cache/invalidate";
import { nutrientEntryResultSchema } from "@/lib/validations/nutrients";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/nutrients/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Yesterday's UTC day key — always a valid, in-window day. */
function recentDay(offsetDays = 1): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

interface BatchResponse {
  data: {
    processed: number;
    inserted: number;
    updated: number;
    skipped: Array<{ index: number; reason: string }>;
    entries: Array<{ index: number; status: string; reason?: string }>;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  // No existing (day, nutrient) pairs by default — every valid entry
  // takes the insert path unless a test overrides this.
  vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([]);
  vi.mocked(prisma.nutrientIntakeDay.createMany).mockImplementation(
    (async (args: { data: unknown[] }) => ({
      count: args.data.length,
    })) as never,
  );
  vi.mocked(prisma.nutrientIntakeDay.update).mockResolvedValue({} as never);
  // Real Prisma resolves every promise in the `$transaction([...])` array;
  // the mock does the same so the update path actually runs in these tests.
  vi.mocked(prisma.$transaction).mockImplementation((async (ops: unknown[]) =>
    Promise.all(ops)) as never);
});

describe("POST /api/nutrients/batch — module gate", () => {
  it("refuses ingest with the 403 module.disabled envelope when the module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "nutrients" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "nutrients",
      }),
    });

    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "vitamin_d", unit: "ug", amount: 20 },
        ],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      data: null;
      meta?: { errorCode?: string; module?: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(body.meta?.module).toBe("nutrients");
    expect(prisma.nutrientIntakeDay.createMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/nutrients/batch — envelope errors", () => {
  it("rejects a 501-entry batch with 422 nutrient.batch.too_large before Zod", async () => {
    const entries = Array.from({ length: 501 }, () => ({
      day: recentDay(),
      nutrient: "vitamin_c",
      unit: "mg",
      amount: 100,
    }));
    const res = await POST(postReq({ entries }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("nutrient.batch.too_large");
  });

  it("surfaces multiple simultaneous Zod issues as one 422 nutrient.batch.invalid", async () => {
    const res = await POST(
      postReq({
        entries: [
          { day: "not-a-day", nutrient: "vitamin_d", unit: "ug", amount: 20 },
          { day: recentDay(), nutrient: "kryptonite", unit: "mg", amount: 1 },
          { day: recentDay(), nutrient: "iron", unit: "mg", amount: -5 },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: unknown[] };
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("nutrient.batch.invalid");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 429 when the per-user rate bucket is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "water", unit: "ml", amount: 1500 },
        ],
      }),
    );
    expect(res.status).toBe(429);
  });
});

describe("POST /api/nutrients/batch — per-entry skip guards", () => {
  it("skips a unit mismatch (µg posted as mg) without touching the store", async () => {
    const res = await POST(
      postReq({
        entries: [
          // vitamin_d is canonically µg; posting mg is the 1000× hazard.
          { day: recentDay(), nutrient: "vitamin_d", unit: "mg", amount: 20 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries[0]).toEqual({
      index: 0,
      status: "skipped",
      reason: "unit_mismatch",
    });
    expect(body.data.skipped).toEqual([{ index: 0, reason: "unit_mismatch" }]);
    expect(prisma.nutrientIntakeDay.findMany).not.toHaveBeenCalled();
    expect(prisma.nutrientIntakeDay.createMany).not.toHaveBeenCalled();
  });

  it("skips a value above the plausibility cap", async () => {
    const res = await POST(
      postReq({
        entries: [
          // caffeine cap is 2000 mg.
          { day: recentDay(), nutrient: "caffeine", unit: "mg", amount: 2001 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries[0].status).toBe("skipped");
    expect(body.data.entries[0].reason).toBe("value_out_of_range");
    expect(prisma.nutrientIntakeDay.createMany).not.toHaveBeenCalled();
  });

  it("skips an impossible calendar day and a far-future day as day_invalid", async () => {
    const res = await POST(
      postReq({
        entries: [
          // Regex-shaped but not a real date.
          { day: "2026-02-31", nutrient: "iron", unit: "mg", amount: 10 },
          // Beyond tomorrow in every IANA timezone.
          { day: "2999-01-01", nutrient: "iron", unit: "mg", amount: 10 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries.map((e) => e.reason)).toEqual([
      "day_invalid",
      "day_invalid",
    ]);
    expect(prisma.nutrientIntakeDay.createMany).not.toHaveBeenCalled();
  });

  it("a skipped entry never fails the batch — siblings still land", async () => {
    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "vitamin_d", unit: "mg", amount: 20 },
          { day: recentDay(), nutrient: "magnesium", unit: "mg", amount: 300 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.processed).toBe(2);
    expect(body.data.inserted).toBe(1);
    expect(body.data.skipped).toHaveLength(1);
    // One bulk createMany call carries the single valid entry.
    expect(prisma.nutrientIntakeDay.createMany).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/nutrients/batch — write semantics", () => {
  it("reports inserted for a fresh (day, nutrient), reads existence once, and writes the catalog's canonical unit", async () => {
    const day = recentDay();
    const res = await POST(
      postReq({
        entries: [
          {
            day,
            nutrient: "vitamin_d",
            unit: "ug",
            amount: 22.5,
            externalSourceVersion: "yazio-9.9",
          },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.inserted).toBe(1);
    expect(body.data.updated).toBe(0);
    expect(body.data.entries[0].status).toBe("inserted");

    // Single indexed existence read, not a per-entry probe.
    expect(prisma.nutrientIntakeDay.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.nutrientIntakeDay.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        source: "APPLE_HEALTH",
        OR: [{ day, nutrient: "vitamin_d" }],
      },
      select: { day: true, nutrient: true },
    });

    expect(prisma.nutrientIntakeDay.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-1",
          day,
          nutrient: "vitamin_d",
          amount: 22.5,
          unit: "ug",
          source: "APPLE_HEALTH",
          externalSourceVersion: "yazio-9.9",
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.nutrientIntakeDay.update).not.toHaveBeenCalled();
  });

  // v1.30.3 (QA F9) — a landed row must evict the dashboard snapshot so
  // the water/nutrient tile reflects the new total on the very next read,
  // matching the manual water POST's own posture (`nutrients/water/route.ts`).
  it("evicts the dashboard snapshot when a row lands", async () => {
    const day = recentDay();
    const res = await POST(
      postReq({
        entries: [{ day, nutrient: "vitamin_d", unit: "ug", amount: 22.5 }],
      }),
    );
    expect(res.status).toBe(200);
    expect(invalidateUserDashboardSnapshot).toHaveBeenCalledTimes(1);
    expect(invalidateUserDashboardSnapshot).toHaveBeenCalledWith("user-1");
  });

  it("does NOT evict the dashboard snapshot when nothing lands (every entry skipped)", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            day: recentDay(),
            nutrient: "vitamin_d",
            unit: "mg", // wrong unit vs the catalog's canonical "ug" — skipped
            amount: 22.5,
          },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.inserted).toBe(0);
    expect(body.data.updated).toBe(0);
    expect(invalidateUserDashboardSnapshot).not.toHaveBeenCalled();
  });

  it("reports updated (never duplicate) when the composite key already exists", async () => {
    const day = recentDay();
    vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([
      { day, nutrient: "caffeine" },
    ] as never);

    const res = await POST(
      postReq({
        entries: [{ day, nutrient: "caffeine", unit: "mg", amount: 310 }],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.inserted).toBe(0);
    expect(body.data.updated).toBe(1);
    expect(body.data.entries[0].status).toBe("updated");
    expect(
      body.data.entries.some((e) => e.status === ("duplicate" as string)),
    ).toBe(false);

    expect(prisma.nutrientIntakeDay.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.nutrientIntakeDay.update).toHaveBeenCalledWith({
      where: {
        userId_day_nutrient_source: {
          userId: "user-1",
          day,
          nutrient: "caffeine",
          source: "APPLE_HEALTH",
        },
      },
      data: { amount: 310, unit: "mg", externalSourceVersion: null },
    });
  });

  it("writes the audit-ledger breadcrumb on every call, landed rows or not", async () => {
    // This used to fire only when `inserted + updated > 0`, which made the one
    // durable trace of an ingest conditional on its success. A batch where every
    // entry was rejected then looked exactly like a batch that never arrived,
    // and on an empty table the two were indistinguishable from the record —
    // which is what made "does the client even post?" unanswerable.
    await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "vitamin_d", unit: "mg", amount: 20 },
        ],
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "nutrient.batch.ingest",
      expect.objectContaining({ userId: "user-1" }),
    );

    await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "water", unit: "ml", amount: 1800 },
        ],
      }),
    );
    expect(auditLog).toHaveBeenCalledTimes(2);
  });

  it("a failed bulk insert marks only the insert group skipped, without touching the update group", async () => {
    // The exception message must never reach the client — the per-entry
    // `reason` is a closed set.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const day = recentDay();
    // `zinc` is new (insert path); `iron` already exists (update path).
    vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([
      { day, nutrient: "iron" },
    ] as never);
    vi.mocked(prisma.nutrientIntakeDay.createMany).mockRejectedValue(
      new Error("boom: sensitive db detail"),
    );

    const res = await POST(
      postReq({
        entries: [
          { day, nutrient: "zinc", unit: "mg", amount: 10 },
          { day, nutrient: "iron", unit: "mg", amount: 12 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries[0].status).toBe("skipped");
    expect(body.data.entries[0].reason).toBe("upsert_failed");
    expect(body.data.skipped[0].reason).toBe("upsert_failed");
    // The raw exception text is logged server-side only, never echoed.
    expect(JSON.stringify(body)).not.toContain("sensitive db detail");
    expect(spy).toHaveBeenCalled();
    // The independent update group still lands.
    expect(body.data.entries[1].status).toBe("updated");
    expect(body.data.updated).toBe(1);
    spy.mockRestore();
  });

  it("marks a response carrying upsert_failed no-store, so a retry with the same Idempotency-Key writes again", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.nutrientIntakeDay.createMany).mockRejectedValue(
      new Error("connection reset"),
    );
    const failed = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "zinc", unit: "mg", amount: 10 },
        ],
      }),
    );
    expect(failed.status).toBe(200);
    expect(failed.headers.get("Cache-Control")).toBe("private, no-store");
    spy.mockRestore();

    vi.mocked(prisma.nutrientIntakeDay.createMany).mockResolvedValue({
      count: 1,
    } as never);
    const clean = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "zinc", unit: "mg", amount: 10 },
        ],
      }),
    );
    expect(clean.headers.get("Cache-Control")).not.toBe("private, no-store");
  });

  it("documents upsert_failed as a transient write failure to retry, and the validation skips as terminal", () => {
    const description = String(
      (nutrientEntryResultSchema.meta() as { description?: string })
        .description,
    );
    expect(description).toMatch(/`upsert_failed` is a write failure/);
    expect(description).toMatch(/sent again on a later sync/);
    expect(description).not.toMatch(/log and drop a skipped entry/i);
    expect(description).toMatch(/unit_mismatch/);
  });

  it("a race that drops one createMany row still counts consistently and is observable", async () => {
    vi.mocked(prisma.nutrientIntakeDay.createMany).mockResolvedValue({
      count: 1,
    } as never);

    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "zinc", unit: "mg", amount: 10 },
          { day: recentDay(2), nutrient: "iron", unit: "mg", amount: 12 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    // Both entries are still labelled inserted (count-only trade-off,
    // documented at the call site) — the response never fails.
    expect(body.data.inserted).toBe(1);
    expect(res.status).toBe(200);
  });
});
