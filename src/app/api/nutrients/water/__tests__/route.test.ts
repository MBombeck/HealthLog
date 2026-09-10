/**
 * v1.29 — `POST /api/nutrients/water` contract tests.
 *
 * Pins the manual quick-add posture: module gate first, rate limit,
 * `add` vs `set` upsert shape, the MANUAL-only key (never touches the
 * APPLE_HEALTH row), the local-day default, and the dashboard-snapshot
 * hard-evict on success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: {
      // v1.37.0 — the route reads the day total before the upsert so the
      // audit row can name what a `set` replaced (C4).
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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
import { invalidateUserDashboardSnapshot } from "@/lib/cache/invalidate";
import { NUTRIENT_CATALOG } from "@/lib/nutrients/catalog";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    timezone: "Europe/Berlin",
    gender: "FEMALE",
  },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/nutrients/water", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface WaterResponse {
  data: {
    day: string;
    nutrient: string;
    source: string;
    amount: number;
    unit: string;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  });
  // No stored row unless a test says otherwise; the pre-image read is
  // best-effort and a missing day is the ordinary first write.
  vi.mocked(prisma.nutrientIntakeDay.findUnique).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.nutrientIntakeDay.upsert).mockResolvedValue({
    day: "2026-07-16",
    nutrient: "water",
    source: "MANUAL",
    amount: 500,
    unit: "ml",
  } as never);
});

describe("POST /api/nutrients/water", () => {
  it("refuses with the 403 module.disabled envelope when the module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "nutrients" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "nutrients",
      }),
    } as never);
    const res = await POST(postReq({ amountMl: 200, mode: "add" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(postReq({ amountMl: 200, mode: "add" }));
    expect(res.status).toBe(429);
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range or missing amountMl with 422", async () => {
    for (const bad of [
      { amountMl: 0, mode: "add" },
      { amountMl: -5, mode: "add" },
      { amountMl: 30000, mode: "add" },
      { mode: "add" },
    ]) {
      const res = await POST(postReq(bad));
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it("rejects an unknown mode with 422", async () => {
    const res = await POST(postReq({ amountMl: 200, mode: "double" }));
    expect(res.status).toBe(422);
  });

  it("rejects a malformed day with 422 (calendar-invalid)", async () => {
    const res = await POST(
      postReq({ amountMl: 200, mode: "add", day: "2026-02-31" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("nutrient.water.invalid_day");
  });

  it("add mode upserts the MANUAL row with an atomic increment — never the APPLE_HEALTH row", async () => {
    const res = await POST(
      postReq({ amountMl: 250, mode: "add", day: "2026-07-16" }),
    );
    expect(res.status).toBe(200);
    expect(prisma.nutrientIntakeDay.upsert).toHaveBeenCalledWith({
      where: {
        userId_day_nutrient_source: {
          userId: "user-1",
          day: "2026-07-16",
          nutrient: "water",
          source: "MANUAL",
        },
      },
      create: {
        userId: "user-1",
        day: "2026-07-16",
        nutrient: "water",
        amount: 250,
        unit: "ml",
        source: "MANUAL",
      },
      update: { amount: { increment: 250 } },
    });
    expect(invalidateUserDashboardSnapshot).toHaveBeenCalledWith("user-1");
  });

  it("set mode overwrites the MANUAL row's amount instead of incrementing", async () => {
    await POST(postReq({ amountMl: 1800, mode: "set", day: "2026-07-16" }));
    expect(prisma.nutrientIntakeDay.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { amount: 1800 } }),
    );
  });

  it("defaults `day` to the caller's current local day when omitted", async () => {
    await POST(postReq({ amountMl: 200, mode: "add" }));
    const call = vi.mocked(prisma.nutrientIntakeDay.upsert).mock
      .calls[0][0] as {
      where: { userId_day_nutrient_source: { day: string } };
    };
    expect(call.where.userId_day_nutrient_source.day).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("returns the MANUAL row shape on success", async () => {
    const res = await POST(
      postReq({ amountMl: 250, mode: "add", day: "2026-07-16" }),
    );
    const body = (await res.json()) as WaterResponse;
    expect(body.data).toEqual({
      day: "2026-07-16",
      nutrient: "water",
      source: "MANUAL",
      amount: 500,
      unit: "ml",
    });
  });

  // A health-data write earns a durable row. This one reached only the wide
  // event, which expires, so months later nothing could answer who put a
  // day's total there — a question with two possible answers once a delegate
  // can act on a shared record.
  it("writes an audit row naming the day, the mode and the amount", async () => {
    await POST(postReq({ amountMl: 250, mode: "add", day: "2026-07-16" }));

    expect(auditLog).toHaveBeenCalledTimes(1);
    const [action, payload] = vi.mocked(auditLog).mock.calls[0] as [
      string,
      { userId: string; details: Record<string, unknown> },
    ];
    expect(action).toBe("nutrient.water.write");
    expect(payload.userId).toBe("user-1");
    expect(payload.details).toMatchObject({
      day: "2026-07-16",
      mode: "add",
      amountMl: 250,
      resultingAmount: 500,
    });
  });

  it("writes no audit row when the module gate refuses", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError("Module disabled", 403),
    } as never);
    await POST(postReq({ amountMl: 250, mode: "add", day: "2026-07-16" }));
    expect(auditLog).not.toHaveBeenCalled();
  });
});

describe("POST /api/nutrients/water — day bound and increment cap", () => {
  // The batch route bounded `day` with UTC+14 slack; this route validated
  // calendar realism only. Every read filters `day: { gte: since }` with no
  // upper bound, so a far-future row became the permanent `latestDay` on the
  // settings card and the permanent `lastSeenAt` on the dashboard water tile.
  it("rejects a far-future day with 422", async () => {
    const res = await POST(
      postReq({ amountMl: 500, mode: "set", day: "2999-01-01" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("still accepts a day two days ahead — the UTC+14 slack the batch route allows", async () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const res = await POST(postReq({ amountMl: 500, mode: "set", day: soon }));
    expect(res.status).toBe(200);
  });

  it("accepts a past day", async () => {
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const res = await POST(postReq({ amountMl: 500, mode: "set", day: past }));
    expect(res.status).toBe(200);
  });

  // `mode: "add"` was unbounded across requests: the schema caps a SINGLE
  // write, so repeated quick-adds drove the stored day total arbitrarily high
  // while the batch route enforced the same cap strictly on the Apple row.
  it("clamps an incremented total back to the catalog's plausible daily max", async () => {
    vi.mocked(prisma.nutrientIntakeDay.upsert).mockResolvedValue({
      day: "2026-07-16",
      nutrient: "water",
      source: "MANUAL",
      amount: 99_000,
      unit: "ml",
    } as never);
    vi.mocked(prisma.nutrientIntakeDay.update).mockResolvedValue({
      day: "2026-07-16",
      nutrient: "water",
      source: "MANUAL",
      amount: NUTRIENT_CATALOG.water.plausibleDailyMax,
      unit: "ml",
    } as never);

    const res = await POST(postReq({ amountMl: 500, mode: "add" }));
    expect(res.status).toBe(200);
    expect(prisma.nutrientIntakeDay.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { amount: NUTRIENT_CATALOG.water.plausibleDailyMax },
      }),
    );
    const body = (await res.json()) as WaterResponse;
    expect(body.data.amount).toBe(NUTRIENT_CATALOG.water.plausibleDailyMax);
  });

  it("leaves a total under the cap untouched", async () => {
    const res = await POST(postReq({ amountMl: 500, mode: "add" }));
    expect(res.status).toBe(200);
    expect(prisma.nutrientIntakeDay.update).not.toHaveBeenCalled();
  });
});
