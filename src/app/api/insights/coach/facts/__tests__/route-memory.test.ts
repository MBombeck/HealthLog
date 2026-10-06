/**
 * v1.41 — the memory list's write half: the remember button (POST), editing
 * a fact (PATCH), and a GET that never lists a proposal still waiting for
 * the person's answer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    coachFact: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ai/coach/memory/remember", () => ({
  rememberMessageAsFact: vi.fn(),
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 10,
    resetAt: new Date(),
  })),
  rateLimitHeaders: vi.fn(() => ({})),
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
  decryptFromBytes: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString()),
  encryptToBytes: vi.fn((s: string) => new Uint8Array(Buffer.from(s))),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
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

import { GET, POST } from "../route";
import { PATCH } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { rememberMessageAsFact } from "@/lib/ai/coach/memory/remember";
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

const callGet = GET as unknown as () => Promise<Response>;
const callPost = POST as unknown as (req: NextRequest) => Promise<Response>;
const callPatch = PATCH as unknown as (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

function req(method: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/insights/coach/facts", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
});

describe("GET /api/insights/coach/facts (v1.41)", () => {
  it("never lists a proposal and returns where each fact came from", async () => {
    vi.mocked(prisma.coachFact.findMany).mockResolvedValue([
      {
        id: "f1",
        category: "goal",
        factEncrypted: new Uint8Array(Buffer.from("75 kg by December")),
        confidence: 80,
        source: "coach",
        sourceConversationId: "c1",
        sourceMessageId: "m1",
        lastUsedAt: new Date("2026-10-05T10:00:00Z"),
        createdAt: new Date("2026-10-01T10:00:00Z"),
        updatedAt: new Date("2026-10-01T10:00:00Z"),
      },
    ] as never);
    const res = await callGet();
    const body = (await res.json()) as {
      data: { facts: Array<Record<string, unknown>> };
    };
    expect(body.data.facts[0]).toMatchObject({
      id: "f1",
      text: "75 kg by December",
      source: "coach",
      sourceMessageId: "m1",
      lastUsedAt: "2026-10-05T10:00:00.000Z",
    });
    const where = vi.mocked(prisma.coachFact.findMany).mock.calls[0]?.[0]
      ?.where as Record<string, unknown>;
    expect(where.source).toEqual({ not: "proposed" });
  });
});

describe("POST /api/insights/coach/facts", () => {
  it("remembers the caller's own message by id", async () => {
    vi.mocked(rememberMessageAsFact).mockResolvedValue({
      id: "f9",
      category: "medication",
      text: "I take ramipril",
      source: "user",
      created: true,
    });
    const res = await callPost(req("POST", { messageId: "um1" }));
    expect(res.status).toBe(201);
    expect(rememberMessageAsFact).toHaveBeenCalledWith({
      userId: "user-1",
      messageId: "um1",
    });
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      fact: {
        id: "f9",
        category: "medication",
        text: "I take ramipril",
        source: "user",
      },
      created: true,
    });
  });

  it("never accepts text or a userId in the body", async () => {
    const res = await callPost(
      req("POST", { messageId: "um1", fact: "anything", userId: "x" }),
    );
    expect(res.status).toBe(422);
    expect(rememberMessageAsFact).not.toHaveBeenCalled();
  });

  it("is a 404 for a message the caller does not own", async () => {
    vi.mocked(rememberMessageAsFact).mockResolvedValue(null);
    const res = await callPost(req("POST", { messageId: "foreign" }));
    expect(res.status).toBe(404);
  });

  it("is refused while the Coach module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await callPost(req("POST", { messageId: "um1" }));
    expect(res.status).toBe(403);
    expect(rememberMessageAsFact).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/insights/coach/facts/[id]", () => {
  const ctx = { params: Promise.resolve({ id: "f1" }) };

  it("rewrites the text, re-encrypted, scoped to the caller's live facts", async () => {
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.coachFact.findFirst).mockResolvedValue({
      id: "f1",
      category: "goal",
      source: "coach",
      updatedAt: new Date("2026-10-06T10:00:00Z"),
    } as never);
    const res = await callPatch(
      req("PATCH", { fact: "  Wants 74 kg by December " }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.coachFact.updateMany).mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { factEncrypted: Uint8Array };
    };
    expect(arg.where).toEqual({
      id: "f1",
      userId: "user-1",
      deletedAt: null,
      source: { not: "proposed" },
    });
    expect(Buffer.from(arg.data.factEncrypted).toString()).toBe(
      "Wants 74 kg by December",
    );
    expect(Object.keys(arg.data)).toEqual(["factEncrypted"]);
  });

  it("is a 404 for an unknown, foreign or proposed id", async () => {
    vi.mocked(prisma.coachFact.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callPatch(req("PATCH", { fact: "Something new" }), ctx);
    expect(res.status).toBe(404);
  });

  it("refuses an empty or over-long fact, or extra keys", async () => {
    for (const body of [
      { fact: "" },
      { fact: "x".repeat(161) },
      { fact: "fine text", category: "condition" },
    ]) {
      const res = await callPatch(req("PATCH", body), ctx);
      expect(res.status).toBe(422);
    }
    expect(prisma.coachFact.updateMany).not.toHaveBeenCalled();
  });
});
