/**
 * v1.21.3 — `/api/coach/plans` (+ `/[id]`) routes.
 *
 * The management + confirm surface for the durable Coach goal / if-then plans.
 * Covers:
 *   - GET lists the caller's plans decrypted, scoped to the user, newest first;
 *     the default (no `?status=`) returns the non-terminal set.
 *   - GET skips an undecryptable row rather than 500ing the whole list.
 *   - PATCH confirms proposed → active field-by-field; a 0-count match 404s;
 *     the body never carries the metric or encrypted text.
 *   - [id] DELETE soft-deletes the caller's plan; a cross-user / unknown id is
 *     a 0-count no-op returning `{ deleted: false }`.
 *   - the `requireModuleEnabled(userId, "coach")` gate runs on every verb.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    coachPlan: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 39,
    resetAt: Date.now() + 60_000,
  })),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn((buf: Uint8Array) => {
    const tag = Buffer.from(buf).toString("utf8");
    if (tag === "__undecryptable__") throw new Error("unknown key id");
    return `decrypted:${tag}`;
  }),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { PATCH, DELETE as DELETE_ONE } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
  },
};

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

const callGet = (url = "http://localhost/api/coach/plans") =>
  (GET as unknown as (req: Request) => Promise<Response>)(new Request(url));

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/coach/plans/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const callPatch = (body: unknown, id = "p1") =>
  (
    PATCH as unknown as (
      req: NextRequest,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>
  )(patchReq(body), { params: Promise.resolve({ id }) });

const callDeleteOne = (id = "p1") =>
  (
    DELETE_ONE as unknown as (
      req: NextRequest,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>
  )(
    new NextRequest("http://localhost/api/coach/plans/x", { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
});

describe("GET /api/coach/plans", () => {
  it("lists the caller's plans, decrypted, scoped to the user", async () => {
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([
      {
        id: "p1",
        metric: "WEIGHT",
        ifCueEncrypted: bytes("every morning"),
        thenActionEncrypted: bytes("weigh in"),
        targetEncrypted: bytes("70 kg"),
        status: "active",
        reviewDate: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-02T00:00:00Z"),
      },
    ] as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { plans: Array<Record<string, unknown>> };
    };
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]).toMatchObject({
      id: "p1",
      metric: "WEIGHT",
      ifCue: "decrypted:every morning",
      thenAction: "decrypted:weigh in",
      target: "decrypted:70 kg",
      status: "active",
    });

    const where = vi.mocked(prisma.coachPlan.findMany).mock.calls[0]?.[0]
      ?.where as { userId: string; deletedAt: null; status: unknown };
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
    // Default = the non-terminal set.
    expect(where.status).toEqual({ in: ["proposed", "active"] });
  });

  it("filters by an explicit ?status=", async () => {
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([] as never);
    await callGet("http://localhost/api/coach/plans?status=proposed");
    const where = vi.mocked(prisma.coachPlan.findMany).mock.calls[0]?.[0]
      ?.where as { status: unknown };
    expect(where.status).toBe("proposed");
  });

  it("maps ?scope=open to the standing set incl. review_due", async () => {
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([] as never);
    await callGet("http://localhost/api/coach/plans?scope=open");
    const where = vi.mocked(prisma.coachPlan.findMany).mock.calls[0]?.[0]
      ?.where as { status: unknown };
    expect(where.status).toEqual({
      in: ["proposed", "active", "review_due"],
    });
  });

  it("maps ?scope=past to the settled set", async () => {
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([] as never);
    await callGet("http://localhost/api/coach/plans?scope=past");
    const where = vi.mocked(prisma.coachPlan.findMany).mock.calls[0]?.[0]
      ?.where as { status: unknown };
    expect(where.status).toEqual({ in: ["met", "abandoned", "reviewed"] });
  });

  it("drops the status clause entirely for ?scope=all", async () => {
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([] as never);
    await callGet("http://localhost/api/coach/plans?scope=all");
    const where = vi.mocked(prisma.coachPlan.findMany).mock.calls[0]?.[0]
      ?.where as Record<string, unknown>;
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
    expect("status" in where).toBe(false);
  });

  it("422s when both ?status= and ?scope= are given", async () => {
    const res = await callGet(
      "http://localhost/api/coach/plans?status=active&scope=all",
    );
    expect(res.status).toBe(422);
  });

  it("422s on an invalid ?status=", async () => {
    const res = await callGet("http://localhost/api/coach/plans?status=bogus");
    expect(res.status).toBe(422);
  });

  it("422s on an invalid ?scope=", async () => {
    const res = await callGet("http://localhost/api/coach/plans?scope=bogus");
    expect(res.status).toBe(422);
  });

  it("carries the source conversation id through to the item", async () => {
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([
      {
        id: "p1",
        metric: "WEIGHT",
        ifCueEncrypted: bytes("every morning"),
        thenActionEncrypted: bytes("weigh in"),
        targetEncrypted: null,
        status: "proposed",
        reviewDate: null,
        sourceConversationId: "conv-9",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    const res = await callGet();
    const body = (await res.json()) as {
      data: { plans: Array<{ sourceConversationId: string | null }> };
    };
    expect(body.data.plans[0]?.sourceConversationId).toBe("conv-9");
  });

  it("skips an undecryptable row rather than 500ing", async () => {
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([
      {
        id: "p1",
        metric: "SLEEP",
        ifCueEncrypted: bytes("__undecryptable__"),
        thenActionEncrypted: bytes("lights out"),
        targetEncrypted: null,
        status: "active",
        reviewDate: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "p2",
        metric: "STEPS",
        ifCueEncrypted: bytes("after lunch"),
        thenActionEncrypted: bytes("walk"),
        targetEncrypted: null,
        status: "active",
        reviewDate: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const res = await callGet();
    const body = (await res.json()) as {
      data: { plans: Array<{ id: string }> };
    };
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]?.id).toBe("p2");
  });

  it("lists stored plans with the Coach unavailable (they are the person's record)", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    } as never);
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([] as never);
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(requireModuleEnabled).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/coach/plans/[id]", () => {
  it("confirms proposed → active, scoped to the caller, field-by-field", async () => {
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.coachPlan.findFirst).mockResolvedValue({
      id: "p1",
      metric: "WEIGHT",
      ifCueEncrypted: bytes("every morning"),
      thenActionEncrypted: bytes("weigh in"),
      targetEncrypted: null,
      status: "active",
      reviewDate: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-03T00:00:00Z"),
    } as never);

    const res = await callPatch({ status: "active" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { plan: { status: string; ifCue: string } };
    };
    expect(body.data.plan.status).toBe("active");
    expect(body.data.plan.ifCue).toBe("decrypted:every morning");

    const arg = vi.mocked(prisma.coachPlan.updateMany).mock.calls[0]?.[0] as {
      where: { id: string; userId: string; deletedAt: null };
      data: Record<string, unknown>;
    };
    expect(arg.where.id).toBe("p1");
    expect(arg.where.userId).toBe("user-1");
    expect(arg.where.deletedAt).toBeNull();
    // S3 (§2.3.1): activating a plan the coach never dated defaults a review
    // checkpoint ~7d out. Only lifecycle fields are written (status +
    // reviewDate) — never metric / encrypted text (no mass assignment).
    expect(new Set(Object.keys(arg.data))).toEqual(
      new Set(["status", "reviewDate"]),
    );
    expect(arg.data.status).toBe("active");
    expect(arg.data.reviewDate).toBeInstanceOf(Date);
    const days =
      ((arg.data.reviewDate as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(7.5);
  });

  it("does NOT clobber a review date the caller pinned on activate", async () => {
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.coachPlan.findFirst).mockResolvedValue({
      id: "p1",
      metric: "WEIGHT",
      ifCueEncrypted: bytes("every morning"),
      thenActionEncrypted: bytes("weigh in"),
      targetEncrypted: null,
      status: "active",
      reviewDate: new Date("2026-08-01T00:00:00Z"),
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-03T00:00:00Z"),
    } as never);

    const res = await callPatch({
      status: "active",
      reviewDate: "2026-08-01T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.coachPlan.updateMany).mock.calls[0]?.[0] as {
      data: { reviewDate: Date };
    };
    // The pinned date is honoured verbatim, not the +7d default.
    expect(arg.data.reviewDate.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("does NOT default a review date when marking a plan met", async () => {
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.coachPlan.findFirst).mockResolvedValue({
      id: "p1",
      metric: "WEIGHT",
      ifCueEncrypted: bytes("every morning"),
      thenActionEncrypted: bytes("weigh in"),
      targetEncrypted: null,
      status: "met",
      reviewDate: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-03T00:00:00Z"),
    } as never);

    await callPatch({ status: "met" });
    const arg = vi.mocked(prisma.coachPlan.updateMany).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(arg.data)).toEqual(["status"]);
  });

  it("404s on a 0-count (unknown / cross-user) match", async () => {
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callPatch({ status: "met" }, "someone-elses");
    expect(res.status).toBe(404);
    expect(prisma.coachPlan.findFirst).not.toHaveBeenCalled();
  });

  it("422s on an empty body (no mutable field)", async () => {
    const res = await callPatch({});
    expect(res.status).toBe(422);
  });

  it("422s on an unknown key (strict)", async () => {
    const res = await callPatch({ status: "active", metric: "WEIGHT" });
    expect(res.status).toBe(422);
  });

  it("invokes the coach module gate", async () => {
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    await callPatch({ status: "met" });
    expect(requireModuleEnabled).toHaveBeenCalledWith("user-1", "coach");
  });
});

describe("DELETE /api/coach/plans/[id]", () => {
  it("soft-deletes the caller's own plan and returns deleted:true", async () => {
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await callDeleteOne();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);

    const arg = vi.mocked(prisma.coachPlan.updateMany).mock.calls[0]?.[0] as {
      where: { id: string; userId: string; deletedAt: null };
      data: { deletedAt: Date };
    };
    expect(arg.where.id).toBe("p1");
    expect(arg.where.userId).toBe("user-1");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
  });

  it("returns deleted:false for an unknown / cross-user id (0-count no-op)", async () => {
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callDeleteOne("someone-elses");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(false);
  });

  it("erases a stored plan with the Coach unavailable", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    } as never);
    vi.mocked(prisma.coachPlan.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await callDeleteOne();
    expect(res.status).toBe(200);
    expect(requireModuleEnabled).not.toHaveBeenCalled();
  });
});
