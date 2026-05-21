import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    consentReceipt: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/consent/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // `resetAllMocks` clears every mock's implementation, including the
  // top-level `vi.mock(...).mockResolvedValue(undefined)` for audit.
  // Re-arm it here so the fire-and-forget `.catch()` in the route
  // doesn't crash on an undefined return.
  vi.mocked(auditLog).mockResolvedValue(undefined);
});

describe("POST /api/consent/ai", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(
      req({
        kind: "ai_full",
        artefact: "PDF",
        signedAt: "2026-05-18T10:00:00.000Z",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        kind: "ai_total_world_domination",
        artefact: "PDF",
        signedAt: "2026-05-18T10:00:00.000Z",
      }),
    );
    expect(res.status).toBe(400);
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-ISO signedAt", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        kind: "ai_full",
        artefact: "PDF",
        signedAt: "yesterday",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when artefact exceeds the 64 KB cap", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const oversize = "A".repeat(64 * 1024 + 1);
    const res = await POST(
      req({
        kind: "ai_full",
        artefact: oversize,
        signedAt: "2026-05-18T10:00:00.000Z",
      }),
    );
    expect(res.status).toBe(400);
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
  });

  it("inserts a row and returns the receipt id + serialised row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const createdAt = new Date("2026-05-18T10:00:01.000Z");
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue({
      id: "rcpt-1",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF",
      signedAt,
      revokedAt: null,
      createdAt,
    } as never);

    const res = await POST(
      req({
        kind: "ai_full",
        artefact: "PDF",
        signedAt: signedAt.toISOString(),
      }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        id: string;
        receipt: {
          id: string;
          userId: string;
          kind: string;
          signedAt: string;
          revokedAt: string | null;
          createdAt: string;
        };
      };
    };
    expect(body.data.id).toBe("rcpt-1");
    expect(body.data.receipt.kind).toBe("ai_full");
    expect(body.data.receipt.userId).toBe("user-1");
    expect(body.data.receipt.signedAt).toBe(signedAt.toISOString());
    expect(body.data.receipt.revokedAt).toBeNull();
    // `artefact` is intentionally stripped from the response — verify
    // it is not echoed back over the wire.
    expect(body.data.receipt).not.toHaveProperty("artefact");

    expect(prisma.consentReceipt.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        kind: "ai_full",
        artefact: "PDF",
        signedAt,
      },
    });
  });

  describe("v1.4.43 W6 — multi-issue 400 envelope (consent uses 400)", () => {
    it("surfaces TWO simultaneous validation errors", async () => {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      // Bad kind enum + empty artefact.
      const res = await POST(
        req({
          kind: "junk",
          artefact: "",
          signedAt: "2026-05-18T10:00:00.000Z",
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        data: null;
        error: string;
        details: {
          issues: Array<{ path: string; code: string; message: string }>;
        };
      };
      expect(body.data).toBeNull();
      expect(body.error).toBe("Validation failed");
      expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
      for (const issue of body.details.issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
      }
    });

    it("surfaces THREE simultaneous validation errors", async () => {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      const res = await POST(
        req({ kind: "junk", artefact: "", signedAt: "not-iso" }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        details: { issues: Array<unknown> };
      };
      expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    });
  });
});
