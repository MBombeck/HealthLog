/**
 * v1.11.1 — `/api/insights/coach/facts` (+ `/[id]`) routes.
 *
 * The GDPR / "forget what you know about me" management surface for the
 * durable Coach facts. Covers:
 *   - GET lists only ACTIVE facts (deletedAt: null), decrypted, scoped to
 *     the caller, highest-confidence-then-newest ordered.
 *   - GET skips an undecryptable row rather than 500ing the whole list.
 *   - bulk DELETE soft-deletes all active facts (sets deletedAt) and
 *     returns the count.
 *   - [id] DELETE soft-deletes the caller's own fact, and a cross-user /
 *     unknown id is a 0-count no-op that returns `{ deleted: false }`.
 *   - no verb asks for the `coach` capability: the facts are the person's
 *     data, readable and erasable while the Coach is unavailable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    coachFact: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

// The capability gate answers "unavailable" throughout: every verb must
// still work, and must not even ask.
vi.mock("@/lib/ai/capabilities/gate", () => ({
  requireAiCapability: vi.fn(async () => {
    throw new Error("the coach capability was consulted");
  }),
  getAiCapability: vi.fn(async () => ({
    available: false,
    reason: "operator_disabled",
    onDeviceAllowed: false,
  })),
}));

// Mock the codec so the test never needs an encryption key. The "row"
// carries a tagged Uint8Array and the mock maps it back to a string;
// a sentinel buffer triggers a throw to exercise the fail-closed skip.
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn((buf: Uint8Array) => {
    const tag = Buffer.from(buf).toString("utf8");
    if (tag === "__undecryptable__") {
      throw new Error("unknown key id");
    }
    return `decrypted:${tag}`;
  }),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, DELETE } from "../route";
import { DELETE as DELETE_ONE } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import {
  getAiCapability,
  requireAiCapability,
} from "@/lib/ai/capabilities/gate";
import { annotate } from "@/lib/logging/context";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
  },
};

const callGet = GET as unknown as () => Promise<Response>;
const callDeleteAll = DELETE as unknown as () => Promise<Response>;
const callDeleteOne = DELETE_ONE as unknown as (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

function deleteReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/coach/facts/x", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/insights/coach/facts", () => {
  it("lists the caller's active facts, decrypted, scoped to the user", async () => {
    vi.mocked(prisma.coachFact.findMany).mockResolvedValue([
      {
        id: "f1",
        category: "goal",
        factEncrypted: bytes("lose 5kg"),
        confidence: 90,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
      {
        id: "f2",
        category: "preference",
        factEncrypted: bytes("morning workouts"),
        confidence: 70,
        createdAt: new Date("2026-06-02T00:00:00Z"),
      },
    ] as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        facts: Array<{
          id: string;
          category: string;
          text: string;
          confidence: number;
        }>;
      };
    };
    expect(body.data.facts).toHaveLength(2);
    expect(body.data.facts[0]).toMatchObject({
      id: "f1",
      category: "goal",
      text: "decrypted:lose 5kg",
      confidence: 90,
    });
    expect(body.data.facts[1]?.text).toBe("decrypted:morning workouts");

    // Ownership-scoped + active-only query.
    const where = vi.mocked(prisma.coachFact.findMany).mock.calls[0]?.[0]
      ?.where as { userId: string; deletedAt: null };
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
  });

  it("orders highest-confidence then newest", async () => {
    vi.mocked(prisma.coachFact.findMany).mockResolvedValue([] as never);
    await callGet();
    const orderBy = vi.mocked(prisma.coachFact.findMany).mock.calls[0]?.[0]
      ?.orderBy;
    expect(orderBy).toEqual([{ confidence: "desc" }, { createdAt: "desc" }]);
  });

  it("skips an undecryptable row rather than 500ing the whole list", async () => {
    vi.mocked(prisma.coachFact.findMany).mockResolvedValue([
      {
        id: "f1",
        category: "goal",
        factEncrypted: bytes("__undecryptable__"),
        confidence: 90,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
      {
        id: "f2",
        category: "context",
        factEncrypted: bytes("works night shifts"),
        confidence: 60,
        createdAt: new Date("2026-06-02T00:00:00Z"),
      },
    ] as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { facts: Array<{ id: string; text: string }> };
    };
    // The undecryptable row is dropped; the good one survives.
    expect(body.data.facts).toHaveLength(1);
    expect(body.data.facts[0]?.id).toBe("f2");
    expect(body.data.facts[0]?.text).toBe("decrypted:works night shifts");
  });

  it("annotates coach.facts.listed with the count only", async () => {
    vi.mocked(prisma.coachFact.findMany).mockResolvedValue([
      {
        id: "f1",
        category: "goal",
        factEncrypted: bytes("a"),
        confidence: 50,
        createdAt: new Date(),
      },
    ] as never);

    await callGet();
    const call = vi
      .mocked(annotate)
      .mock.calls.find(
        (c) =>
          (c[0] as { action?: { name?: string } })?.action?.name ===
          "coach.facts.listed",
      );
    expect(call).toBeTruthy();
    expect((call![0] as { meta?: { count?: number } }).meta).toEqual({
      count: 1,
    });
  });

  it("lists facts while the Coach is unavailable, without asking", async () => {
    vi.mocked(prisma.coachFact.findMany).mockResolvedValue([] as never);
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(requireAiCapability).not.toHaveBeenCalled();
    expect(getAiCapability).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/insights/coach/facts — forget all", () => {
  it("soft-deletes all active facts and returns the count", async () => {
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 3,
    } as never);

    const res = await callDeleteAll();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cleared: number } };
    expect(body.data.cleared).toBe(3);

    const arg = vi.mocked(prisma.coachFact.updateMany).mock.calls[0]?.[0] as {
      where: { userId: string; deletedAt: null };
      data: { deletedAt: Date };
    };
    expect(arg.where.userId).toBe("user-1");
    expect(arg.where.deletedAt).toBeNull();
    // Soft-delete sets a deletedAt timestamp; the row is not removed.
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — a second clear returns 0", async () => {
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callDeleteAll();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cleared: number } };
    expect(body.data.cleared).toBe(0);
  });

  it("forgets everything while the Coach is unavailable, without asking", async () => {
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callDeleteAll();
    expect(res.status).toBe(200);
    expect(requireAiCapability).not.toHaveBeenCalled();
    expect(getAiCapability).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/insights/coach/facts/[id] — forget one", () => {
  it("soft-deletes the caller's own fact and returns deleted:true", async () => {
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 1,
    } as never);

    const res = await callDeleteOne(deleteReq(), {
      params: Promise.resolve({ id: "f1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);

    const arg = vi.mocked(prisma.coachFact.updateMany).mock.calls[0]?.[0] as {
      where: { id: string; userId: string; deletedAt: null };
      data: { deletedAt: Date };
    };
    // Scoped by BOTH id and userId, active-only.
    expect(arg.where.id).toBe("f1");
    expect(arg.where.userId).toBe("user-1");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
  });

  it("returns deleted:false for an unknown / cross-user id (0-count no-op)", async () => {
    // updateMany scoped to { id, userId } matches no row owned by the
    // caller → count 0 → no other user's row is ever touched.
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await callDeleteOne(deleteReq(), {
      params: Promise.resolve({ id: "someone-elses-fact" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(false);

    // The where clause pins userId so the query can never reach a
    // foreign row regardless of the id supplied.
    const arg = vi.mocked(prisma.coachFact.updateMany).mock.calls[0]?.[0] as {
      where: { userId: string };
    };
    expect(arg.where.userId).toBe("user-1");
  });

  it("forgets one fact while the Coach is unavailable, without asking", async () => {
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callDeleteOne(deleteReq(), {
      params: Promise.resolve({ id: "f1" }),
    });
    expect(res.status).toBe(200);
    expect(requireAiCapability).not.toHaveBeenCalled();
    expect(getAiCapability).not.toHaveBeenCalled();
  });
});
