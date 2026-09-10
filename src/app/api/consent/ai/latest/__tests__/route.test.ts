import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// v1.16.16 — `createReceipt` + `revokeLatest` run inside a transaction; the
// mock runs the callback against the same proxy.
type TxFn = (tx: unknown) => unknown;

vi.mock("@/lib/db", () => {
  const consentReceipt = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  return {
    prisma: {
      consentReceipt,
      $transaction: vi.fn((fn: TxFn) => fn({ consentReceipt })),
    },
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkConsentRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
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
import { checkConsentRateLimit } from "@/lib/rate-limit";

const RL_OK = {
  allowed: true,
  limit: 20,
  remaining: 19,
  resetAt: Date.now() + 60_000,
};

const $transaction = vi.mocked(prisma.$transaction) as unknown as {
  mockImplementation: (impl: (fn: TxFn) => unknown) => void;
};

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  // `resetAllMocks` clears the top-level `mockResolvedValue(undefined)`
  // on `auditLog`. Re-arm so the route's fire-and-forget `.catch()`
  // chain doesn't NPE on an undefined return.
  vi.mocked(auditLog).mockResolvedValue(undefined);
  // Re-arm rate-limit + transaction pass-throughs cleared by reset.
  vi.mocked(checkConsentRateLimit).mockResolvedValue(RL_OK);
  $transaction.mockImplementation((fn: TxFn) =>
    fn({ consentReceipt: prisma.consentReceipt }),
  );
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

  it("returns 429 when the per-user consent bucket is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkConsentRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await GET(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full"),
    );
    expect(res.status).toBe(429);
    expect(prisma.consentReceipt.findFirst).not.toHaveBeenCalled();
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

  it("returns 429 when the per-user consent bucket is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkConsentRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await DELETE(
      new NextRequest("http://localhost/api/consent/ai/latest?kind=ai_full", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(429);
    expect(prisma.consentReceipt.updateMany).not.toHaveBeenCalled();
  });

  it("marks the latest receipt as revoked and returns it", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const createdAt = new Date("2026-05-18T10:00:01.000Z");
    const revokedAt = new Date("2026-05-18T11:00:00.000Z");
    // v1.16.16 — `revokeLatest` atomically flips `revoked_at` via
    // `updateMany` (count) then re-reads the revoked row for the audit id.
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue({
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
    expect(prisma.consentReceipt.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("is idempotent — returns null receipt without re-reading when nothing to revoke", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 0,
    } as never);

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
    expect(prisma.consentReceipt.findFirst).not.toHaveBeenCalled();
  });

  it("master toggle revokes the latest active row per kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const createdAt = new Date("2026-05-18T10:00:01.000Z");
    const revokedAt = new Date("2026-05-18T11:00:00.000Z");

    // v1.16.16 — `revokeLatest` runs per kind in `consentKindEnum.options`
    // order: ai_full → ai_insights_only → ai_coach. The `updateMany` count
    // gates the follow-up re-read. ai_full + ai_coach revoke a row;
    // ai_insights_only has none (count 0, no re-read).
    vi.mocked(prisma.consentReceipt.updateMany)
      .mockResolvedValueOnce({ count: 1 } as never) // ai_full
      .mockResolvedValueOnce({ count: 0 } as never) // ai_insights_only
      .mockResolvedValueOnce({ count: 1 } as never); // ai_coach
    vi.mocked(prisma.consentReceipt.findFirst)
      .mockResolvedValueOnce({
        id: "rcpt-full",
        userId: "user-1",
        kind: "ai_full",
        artefact: "PDF",
        signedAt,
        revokedAt,
        createdAt,
      } as never)
      .mockResolvedValueOnce({
        id: "rcpt-coach",
        userId: "user-1",
        kind: "ai_coach",
        artefact: "PDF",
        signedAt,
        revokedAt,
        createdAt,
      } as never);

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

    // Step 1: initial grant. `createReceipt` supersedes any active row
    // (none yet → count 0) then inserts.
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 0,
    } as never);
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

    // Step 2: revoke. `revokeLatest` atomically flips `revoked_at` via
    // `updateMany` (count 1) then re-reads the revoked row. The row is
    // NEVER deleted — only marked revoked, so the audit chain survives.
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValueOnce({
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
    // Critical invariant — `delete` was NEVER called on the receipt. The
    // revoke is an in-place `updateMany` setting `revokedAt`.
    expect(prisma.consentReceipt.delete).toBeUndefined();
    expect(prisma.consentReceipt.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
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

  describe("v1.4.43 W6 — multi-issue 400 envelope (consent uses 400)", () => {
    it("GET surfaces multi-issue validation errors (≥ 1)", async () => {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      const res = await GET(
        new NextRequest("http://localhost/api/consent/ai/latest?kind=junk"),
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
      // The latest query only has a single `kind` knob, so the strict
      // 2-issue case can't be reached. The shared helper itself is
      // covered exhaustively by api-response-zod.test.ts; this case
      // pins the route's new envelope on ≥ 1 issue.
      expect(body.details.issues.length).toBeGreaterThanOrEqual(1);
      for (const issue of body.details.issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
      }
    });

    it("DELETE surfaces multi-issue validation errors (≥ 1)", async () => {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      const res = await DELETE(
        new NextRequest("http://localhost/api/consent/ai/latest?kind=junk", {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        details: { issues: Array<unknown> };
      };
      expect(body.details.issues.length).toBeGreaterThanOrEqual(1);
    });
  });
});
