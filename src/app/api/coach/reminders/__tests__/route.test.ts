/**
 * v1.22 — `/api/coach/reminders` (+ `/[id]`) routes.
 *
 * Covers:
 *   - GET lists the caller's reminders decrypted, scoped to the user; an
 *     undecryptable row is skipped rather than 500ing the list.
 *   - POST creates a reminder field-by-field (source manual, active), resolving
 *     the closed `when` grammar server-side; an invalid `when` 422s.
 *   - PATCH confirms proposed → active field-by-field; a 0-count match 404s
 *     (no-IDOR: the cross-user / unknown id never leaks existence).
 *   - DELETE soft-deletes the caller's reminder; a cross-user id is a 0-count
 *     no-op returning `{ deleted: false }`.
 *   - the coach module gate runs on every verb.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    coachReminder: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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
    if (tag === "__bad__") throw new Error("unknown key id");
    return `dec:${tag}`;
  }),
  encryptToBytes: vi.fn((s: string) => new Uint8Array(Buffer.from(`enc:${s}`))),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
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

import { GET, POST } from "../route";
import { PATCH, DELETE as DELETE_ONE } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "t",
    role: "USER" as const,
    displayName: null,
  },
};

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

const callGet = (url = "http://localhost/api/coach/reminders") =>
  (GET as unknown as (req: Request) => Promise<Response>)(new Request(url));

function jsonReq(body: unknown, method = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/coach/reminders", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const callPost = (body: unknown) =>
  (POST as unknown as (req: Request) => Promise<Response>)(jsonReq(body));

const callPatch = (body: unknown, id = "r1") =>
  (
    PATCH as unknown as (
      req: NextRequest,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>
  )(
    new NextRequest("http://localhost/api/coach/reminders/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const callDelete = (id = "r1") =>
  (
    DELETE_ONE as unknown as (
      req: NextRequest,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>
  )(
    new NextRequest("http://localhost/api/coach/reminders/x", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );

/** The Coach module gate refuses: operator switch, module off or Hide Coach. */
function coachOff() {
  vi.mocked(requireModuleEnabled).mockResolvedValue({
    enabled: false,
    response: new Response(null, { status: 403 }),
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
});

describe("GET /api/coach/reminders", () => {
  it("lists the caller's reminders decrypted, scoped to the user", async () => {
    vi.mocked(prisma.coachReminder.findMany).mockResolvedValue([
      {
        id: "r1",
        metric: "SLEEP",
        noteEncrypted: bytes("revisit sleep"),
        triggerKind: "date",
        dueAt: new Date("2026-07-11T09:00:00Z"),
        contextCue: null,
        status: "active",
        source: "sentinel",
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-02T00:00:00Z"),
      },
    ] as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { reminders: Array<Record<string, unknown>> };
    };
    expect(body.data.reminders[0]).toMatchObject({
      id: "r1",
      note: "dec:revisit sleep",
      status: "active",
    });
    const where = vi.mocked(prisma.coachReminder.findMany).mock.calls[0]?.[0]
      ?.where as { userId: string; deletedAt: null };
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
  });

  it("lists stored reminders with the Coach unavailable (they are the person's record)", async () => {
    coachOff();
    vi.mocked(prisma.coachReminder.findMany).mockResolvedValue([] as never);
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(requireModuleEnabled).not.toHaveBeenCalled();
  });

  it("skips an undecryptable row rather than 500ing", async () => {
    vi.mocked(prisma.coachReminder.findMany).mockResolvedValue([
      {
        id: "r1",
        metric: null,
        noteEncrypted: bytes("__bad__"),
        triggerKind: "date",
        dueAt: null,
        contextCue: null,
        status: "active",
        source: "manual",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "r2",
        metric: null,
        noteEncrypted: bytes("ok"),
        triggerKind: "date",
        dueAt: null,
        contextCue: null,
        status: "active",
        source: "manual",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    const res = await callGet();
    const body = (await res.json()) as {
      data: { reminders: Array<{ id: string }> };
    };
    expect(body.data.reminders).toHaveLength(1);
    expect(body.data.reminders[0]?.id).toBe("r2");
  });
});

describe("POST /api/coach/reminders", () => {
  it("stays Coach use: refused with the Coach unavailable", async () => {
    coachOff();
    const res = await callPost({ note: "check my sleep" });
    expect(res.status).toBe(403);
    expect(prisma.coachReminder.create).not.toHaveBeenCalled();
  });

  it("creates a reminder field-by-field, resolving the when grammar", async () => {
    vi.mocked(prisma.coachReminder.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.coachReminder.create).mockResolvedValue({
      id: "r9",
      metric: "SLEEP",
      noteEncrypted: bytes("x"),
      triggerKind: "date",
      dueAt: new Date(),
      contextCue: null,
      status: "active",
      source: "manual",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const res = await callPost({
      note: "revisit sleep",
      when: "+7d",
      metric: "SLEEP",
    });
    expect(res.status).toBe(201);
    const data = vi.mocked(prisma.coachReminder.create).mock.calls[0]?.[0]
      ?.data as {
      userId: string;
      status: string;
      source: string;
    };
    expect(data.userId).toBe("user-1");
    expect(data.status).toBe("active");
    expect(data.source).toBe("manual");
  });

  it("422s on an invalid when token", async () => {
    vi.mocked(prisma.coachReminder.count).mockResolvedValue(0 as never);
    const res = await callPost({ note: "x", when: "someday" });
    expect(res.status).toBe(422);
    expect(prisma.coachReminder.create).not.toHaveBeenCalled();
  });

  it("422s on an unknown key (strict)", async () => {
    const res = await callPost({ note: "x", userId: "evil" });
    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/coach/reminders/[id]", () => {
  it("stays Coach use: refused with the Coach unavailable", async () => {
    coachOff();
    const res = await callPatch({ status: "active" });
    expect(res.status).toBe(403);
    expect(requireModuleEnabled).toHaveBeenCalledWith("user-1", "coach");
    expect(prisma.coachReminder.updateMany).not.toHaveBeenCalled();
  });

  it("confirms proposed → active field-by-field, owner-scoped", async () => {
    vi.mocked(prisma.coachReminder.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.coachReminder.findFirst).mockResolvedValue({
      id: "r1",
      metric: null,
      noteEncrypted: bytes("x"),
      triggerKind: "date",
      dueAt: null,
      contextCue: null,
      status: "active",
      source: "sentinel",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const res = await callPatch({ status: "active" });
    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.coachReminder.updateMany).mock
      .calls[0]?.[0] as {
      where: { id: string; userId: string; deletedAt: null };
      data: Record<string, unknown>;
    };
    expect(arg.where.userId).toBe("user-1");
    expect(Object.keys(arg.data)).toEqual(["status"]);
  });

  it("404s on a 0-count (cross-user / unknown) match — no IDOR leak", async () => {
    vi.mocked(prisma.coachReminder.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callPatch({ status: "done" }, "someone-elses");
    expect(res.status).toBe(404);
    expect(prisma.coachReminder.findFirst).not.toHaveBeenCalled();
  });

  it("422s on an empty body", async () => {
    const res = await callPatch({});
    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/coach/reminders/[id]", () => {
  it("soft-deletes the caller's reminder", async () => {
    vi.mocked(prisma.coachReminder.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);
  });

  it("returns deleted:false for a cross-user id (0-count no-op)", async () => {
    vi.mocked(prisma.coachReminder.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await callDelete("someone-elses");
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(false);
  });

  it("erases a stored reminder with the Coach unavailable", async () => {
    coachOff();
    vi.mocked(prisma.coachReminder.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);
    expect(requireModuleEnabled).not.toHaveBeenCalled();
  });
});
