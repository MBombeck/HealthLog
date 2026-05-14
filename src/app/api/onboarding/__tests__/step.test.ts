/**
 * v1.4.25 W21 Fix-M — concurrency regression for
 * `POST /api/onboarding/step`.
 *
 * The step write was fetch-then-update: two parallel tabs both
 * reading `onboardingStep = 2` and both POSTing `step: 3` would both
 * succeed because the second write didn't re-check the precondition.
 * The route now claims the row via `updateMany` with the precondition
 * embedded in the WHERE clause, so exactly one update lands and the
 * loser sees `count = 0` and returns 409.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
  setOnboardingPendingCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: vi.fn(() => ({})),
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

import { POST } from "../step/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/onboarding/step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  });
});

describe("POST /api/onboarding/step — happy path", () => {
  it("advances 0 → 1 on the first wizard submission", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      onboardingStep: 0,
      onboardingCompletedAt: null,
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      onboardingStep: 1,
      onboardingCompletedAt: null,
    } as never);

    const res = await POST(req({ step: 1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { step: number } };
    expect(body.data.step).toBe(1);
  });

  it("marks completion on step 4 (sets onboardingCompletedAt)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      onboardingStep: 3,
      onboardingCompletedAt: null,
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      onboardingStep: 4,
      onboardingCompletedAt: new Date("2026-05-14T12:00:00Z"),
    } as never);

    const res = await POST(req({ step: 4 }));
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.user.updateMany).mock.calls[0][0];
    expect(updateCall.data).toMatchObject({
      onboardingStep: 4,
    });
    expect(updateCall.data).toHaveProperty("onboardingCompletedAt");
  });
});

describe("POST /api/onboarding/step — guard rails", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(req({ step: 1 }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for an out-of-range step value", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(req({ step: 99 }));
    expect(res.status).toBe(422);
  });

  it("returns 409 when the user has already completed onboarding", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      onboardingStep: 4,
      onboardingCompletedAt: new Date("2026-05-01T12:00:00Z"),
    } as never);

    const res = await POST(req({ step: 1 }));
    expect(res.status).toBe(409);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 when the requested step is out of order", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      onboardingStep: 1,
      onboardingCompletedAt: null,
    } as never);

    // The route sees current = 1; submitting step 3 (skipping 2) must
    // be rejected before the write.
    const res = await POST(req({ step: 3 }));
    expect(res.status).toBe(409);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/step — concurrent write race", () => {
  it("returns 409 when the conditional update affects zero rows", async () => {
    // Regression for Fix-M / code-M7: two parallel tabs both read
    // `onboardingStep = 2`, both POST `step: 3`. The first lands;
    // when the second runs the conditional updateMany, the WHERE
    // clause no longer matches (the column moved to 3) and Prisma
    // returns `count = 0`. The route must surface 409 so the client
    // can refresh and retry instead of double-advancing the wizard.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      onboardingStep: 2,
      onboardingCompletedAt: null,
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await POST(req({ step: 3 }));
    expect(res.status).toBe(409);
    // findUniqueOrThrow must NOT be called when the claim fails —
    // the route returns before re-reading the row.
    expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("includes the precondition in the updateMany WHERE clause", async () => {
    // The whole point of the conditional update is that the WHERE
    // clause re-asserts the precondition we read. Pin the contract
    // so a future refactor can't quietly drop the guard.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      onboardingStep: 2,
      onboardingCompletedAt: null,
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      onboardingStep: 3,
      onboardingCompletedAt: null,
    } as never);

    await POST(req({ step: 3 }));
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0][0]
      .where as Record<string, unknown>;
    expect(whereArg).toMatchObject({
      id: "user-1",
      onboardingCompletedAt: null,
    });
    // Strict-equality precondition — Migration 0060 dropped the
    // legacy nullable path so every advance uses `{ in: [current] }`.
    expect(whereArg.onboardingStep).toEqual({ in: [2] });
  });

  it("advances a step-0 row to step 1 using the strict-equality precondition", async () => {
    // Migration 0060 (v1.4.25 W21 Fix-O) backfilled NULL → 0 and
    // flipped `onboarding_step` to NOT NULL, so the conditional
    // update always uses the strict-equality form — there is no
    // legacy null branch left for the route to widen.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      onboardingStep: 0,
      onboardingCompletedAt: null,
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      onboardingStep: 1,
      onboardingCompletedAt: null,
    } as never);

    const res = await POST(req({ step: 1 }));
    expect(res.status).toBe(200);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0][0]
      .where as Record<string, unknown>;
    expect(whereArg.onboardingStep).toEqual({ in: [0] });
  });
});

describe("POST /api/onboarding/step — rate limit", () => {
  it("returns 429 when the per-user rate limit is exceeded", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(req({ step: 1 }));
    expect(res.status).toBe(429);
  });
});
