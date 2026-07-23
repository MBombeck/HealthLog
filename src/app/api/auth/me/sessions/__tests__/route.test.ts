import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The handle is an HMAC, so the route needs the key the real helper reads.
process.env.API_TOKEN_HMAC_KEY ??= "a".repeat(64);

vi.mock("@/lib/db", () => ({
  prisma: { session: { findMany: vi.fn() } },
}));

// `sessionHandle` stays REAL: the point of the handle test is that the route
// emits the actual derivation, and a stubbed one would let the route return
// row ids while the assertion still passed.
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    getSession: vi.fn(),
    destroyOtherSessions: vi.fn(),
    destroySessionById: vi.fn(),
    sessionHandle: actual.sessionHandle,
  };
});

vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(async () => "Berlin, DE"),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

import { GET, DELETE } from "../route";
import { DELETE as DELETE_ONE } from "../[id]/route";
import { prisma } from "@/lib/db";
import {
  getSession,
  destroyOtherSessions,
  destroySessionById,
  sessionHandle,
} from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-current", expiresAt: new Date(Date.now() + 3.6e6) },
  user: { id: "user-1", username: "u", role: "USER" as const },
};

function del(): NextRequest {
  return new NextRequest("http://localhost/api/auth/me/sessions", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/auth/me/sessions", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists sessions with masked IP, location, and the current marker", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.session.findMany).mockResolvedValue([
      {
        id: "sess-current",
        ipAddress: "203.0.113.7",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "sess-other",
        ipAddress: "198.51.100.4",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0) Chrome/119.0.0.0 Safari/537.36",
        lastActiveAt: null,
        createdAt: new Date(),
      },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const list = body.data.sessions;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      device: "Firefox on macOS",
      ipMasked: "203.0.x.x",
      location: "Berlin, DE",
      isCurrent: true,
    });
    expect(list[1].isCurrent).toBe(false);
    // The full IP never appears in the response body.
    expect(JSON.stringify(body)).not.toContain("203.0.113.7");
  });

  it("never puts a session row id in the response body", async () => {
    // A row id created before the secret cookie landed IS that session's
    // cookie value, so listing it hands the client working logins for the
    // account's other devices. The list carries an opaque handle instead;
    // it is what the revoke route accepts.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.session.findMany).mockResolvedValue([
      {
        id: "sess-current",
        ipAddress: "203.0.113.7",
        userAgent: "Mozilla/5.0 (Macintosh) Firefox/120.0",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "sess-other",
        ipAddress: "198.51.100.4",
        userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/119.0.0.0",
        lastActiveAt: null,
        createdAt: new Date(),
      },
    ] as never);

    const res = await GET();
    const body = await res.json();
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain("sess-current");
    expect(serialised).not.toContain("sess-other");
    // Still identified well enough to act on: distinct, stable handles.
    const [a, b] = body.data.sessions.map((s: { id: string }) => s.id);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    expect(a).toBe(sessionHandle("sess-current"));
  });
});

describe("DELETE /api/auth/me/sessions (sign out everywhere)", () => {
  it("revokes other sessions and reports the count", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(destroyOtherSessions).mockResolvedValue({ sessionsRevoked: 3 });

    const res = await DELETE(del());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sessionsRevoked).toBe(3);
    expect(destroyOtherSessions).toHaveBeenCalledWith("user-1", {
      kind: "session",
      sessionId: "sess-current",
    });
  });
});

describe("DELETE /api/auth/me/sessions/[id]", () => {
  function ctx(id: string) {
    return { params: Promise.resolve({ id }) };
  }
  function delReq(id: string): NextRequest {
    return new NextRequest(`http://localhost/api/auth/me/sessions/${id}`, {
      method: "DELETE",
    });
  }

  it("revokes a single owned session", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(destroySessionById).mockResolvedValue(true);
    const res = await DELETE_ONE(delReq("sess-other"), ctx("sess-other"));
    expect(res.status).toBe(200);
    expect(destroySessionById).toHaveBeenCalledWith("user-1", "sess-other");
  });

  it("404 for a non-existent or not-owned id", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(destroySessionById).mockResolvedValue(false);
    const res = await DELETE_ONE(delReq("nope"), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
