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

import { GET, DELETE } from "../route";
import { POST as POST_GRANT } from "../../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  // `resetAllMocks` clears the top-level `mockResolvedValue(undefined)`
  // on `auditLog`. Re-arm so the route's fire-and-forget `.catch()`
  // chain doesn't NPE on an undefined return.
  vi.mocked(auditLog).mockResolvedValue(undefined);
});

describe("GET /api/consent/ai/latest", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for an unknown kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=invalid"),
    );
    expect(res.status).toBe(400);
  });

  it("returns null receipt when nothing has been granted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { kind: string; receipt: unknown | null };
    };
    expect(body.data.kind).toBe("ai_full");
    expect(body.data.receipt).toBeNull();
  });

  it("returns the latest non-revoked receipt by kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const createdAt = new Date("2026-05-18T10:00:01.000Z");
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue({
      id: "rcpt-1",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF",
      signedAt,
      revokedAt: null,
      createdAt,
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { kind: string; receipt: { id: string; kind: string } | null };
    };
    expect(body.data.receipt?.id).toBe("rcpt-1");
    expect(body.data.receipt?.kind).toBe("ai_full");
    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns the full keyspace when called without ?kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const createdAt = new Date("2026-05-18T10:00:01.000Z");
    vi.mocked(prisma.consentReceipt.findMany).mockResolvedValue([
      {
        id: "rcpt-full",
        userId: "user-1",
        kind: "ai_full",
        artefact: "PDF",
        signedAt,
        revokedAt: null,
        createdAt,
      },
    ] as never);

    const res = await GET(
      new NextRequest("http://localhost/api/consent/ai/latest"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, { id: string } | null>;
    };
    expect(body.data.ai_full?.id).toBe("rcpt-full");
    expect(body.data.ai_coach).toBeNull();
    expect(body.data.ai_insights_only).toBeNull();
  });
});

describe("DELETE /api/consent/ai/latest", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await DELETE(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("marks the latest receipt as revoked and returns it", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const createdAt = new Date("2026-05-18T10:00:01.000Z");
    const revokedAt = new Date("2026-05-18T11:00:00.000Z");
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue({
      id: "rcpt-1",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF",
      signedAt,
      revokedAt: null,
      createdAt,
    } as never);
    vi.mocked(prisma.consentReceipt.update).mockResolvedValue({
      id: "rcpt-1",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF",
      signedAt,
      revokedAt,
      createdAt,
    } as never);

    const res = await DELETE(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { kind: string; receipt: { id: string; revokedAt: string } | null };
    };
    expect(body.data.receipt?.id).toBe("rcpt-1");
    expect(body.data.receipt?.revokedAt).toBe(revokedAt.toISOString());
    expect(prisma.consentReceipt.update).toHaveBeenCalledWith({
      where: { id: "rcpt-1" },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("is idempotent — returns null receipt without writing when nothing to revoke", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);

    const res = await DELETE(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { kind: string; receipt: unknown | null };
    };
    expect(body.data.receipt).toBeNull();
    expect(prisma.consentReceipt.update).not.toHaveBeenCalled();
  });

  it("master toggle revokes the latest active row per kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const createdAt = new Date("2026-05-18T10:00:01.000Z");
    const revokedAt = new Date("2026-05-18T11:00:00.000Z");

    // First call (ai_full) finds a row, second (ai_insights_only)
    // finds none, third (ai_coach) finds a row.
    vi.mocked(prisma.consentReceipt.findFirst)
      .mockResolvedValueOnce({
        id: "rcpt-full",
        userId: "user-1",
        kind: "ai_full",
        artefact: "PDF",
        signedAt,
        revokedAt: null,
        createdAt,
      } as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rcpt-coach",
        userId: "user-1",
        kind: "ai_coach",
        artefact: "PDF",
        signedAt,
        revokedAt: null,
        createdAt,
      } as never);

    vi.mocked(prisma.consentReceipt.update).mockImplementation(
      ((args: { where: { id: string }; data: { revokedAt: Date } }) =>
        Promise.resolve({
          id: args.where.id,
          userId: "user-1",
          kind: args.where.id === "rcpt-full" ? "ai_full" : "ai_coach",
          artefact: "PDF",
          signedAt,
          revokedAt,
          createdAt,
        })) as never,
    );

    const res = await DELETE(
      new NextRequest("http://localhost/api/consent/ai/latest", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { revoked: Array<{ kind: string; receipt: { id: string } }> };
    };
    expect(body.data.revoked).toHaveLength(2);
    expect(body.data.revoked.map((r) => r.kind).sort()).toEqual([
      "ai_coach",
      "ai_full",
    ]);
  });
});

describe("append-only invariant", () => {
  /**
   * v1.4.40 SB-10 — the receipts table is the legal audit trail.
   * Revoking + re-granting must leave the original row in place
   * (just with `revokedAt` set) and mint a fresh row for the new
   * grant. The latest active receipt after the cycle is the newest
   * one, not the original.
   */
  it("revoke + re-grant leaves both rows; latestActive points at the re-grant", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const signedAt1 = new Date("2026-05-18T10:00:00.000Z");
    const createdAt1 = new Date("2026-05-18T10:00:01.000Z");
    const revokedAt = new Date("2026-05-18T11:00:00.000Z");
    const signedAt2 = new Date("2026-05-18T12:00:00.000Z");
    const createdAt2 = new Date("2026-05-18T12:00:01.000Z");

    // Step 1: initial grant.
    vi.mocked(prisma.consentReceipt.create).mockResolvedValueOnce({
      id: "rcpt-1",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF-v1",
      signedAt: signedAt1,
      revokedAt: null,
      createdAt: createdAt1,
    } as never);

    const grant1 = await POST_GRANT(
      new NextRequest("http://localhost/api/consent/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "ai_full",
          artefact: "PDF-v1",
          signedAt: signedAt1.toISOString(),
        }),
      }),
    );
    expect(grant1.status).toBe(200);

    // Step 2: revoke. The DELETE handler reads + updates.
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValueOnce({
      id: "rcpt-1",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF-v1",
      signedAt: signedAt1,
      revokedAt: null,
      createdAt: createdAt1,
    } as never);
    vi.mocked(prisma.consentReceipt.update).mockResolvedValueOnce({
      id: "rcpt-1",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF-v1",
      signedAt: signedAt1,
      revokedAt,
      createdAt: createdAt1,
    } as never);

    const revokeRes = await DELETE(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full", {
        method: "DELETE",
      }),
    );
    expect(revokeRes.status).toBe(200);
    expect(prisma.consentReceipt.update).toHaveBeenCalledTimes(1);
    // Critical invariant — `delete` was NEVER called on the receipt.
    // Only an update setting `revokedAt`. The old row stays in place.
    const updateCall = vi.mocked(prisma.consentReceipt.update).mock.calls[0][0];
    expect(updateCall).toMatchObject({
      where: { id: "rcpt-1" },
      data: { revokedAt: expect.any(Date) },
    });

    // Step 3: re-grant mints a fresh row.
    vi.mocked(prisma.consentReceipt.create).mockResolvedValueOnce({
      id: "rcpt-2",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF-v2",
      signedAt: signedAt2,
      revokedAt: null,
      createdAt: createdAt2,
    } as never);

    const grant2 = await POST_GRANT(
      new NextRequest("http://localhost/api/consent/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "ai_full",
          artefact: "PDF-v2",
          signedAt: signedAt2.toISOString(),
        }),
      }),
    );
    expect(grant2.status).toBe(200);
    expect(prisma.consentReceipt.create).toHaveBeenCalledTimes(2);

    // Step 4: GET latest now points at the re-grant.
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValueOnce({
      id: "rcpt-2",
      userId: "user-1",
      kind: "ai_full",
      artefact: "PDF-v2",
      signedAt: signedAt2,
      revokedAt: null,
      createdAt: createdAt2,
    } as never);

    const latest = await GET(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full"),
    );
    const body = (await latest.json()) as {
      data: { receipt: { id: string } | null };
    };
    expect(body.data.receipt?.id).toBe("rcpt-2");
  });
});
