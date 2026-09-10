import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// v1.16.16 — `createReceipt` runs its supersede + insert inside a
// transaction; run the callback against the same mock proxy.
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

// v1.16.16 — rate limit is exercised by its own suite; here we default to
// "allowed" and flip a single test to assert the 429 wiring.
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

import { POST } from "../route";
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
  // Re-arm the rate-limit + transaction pass-throughs cleared by
  // `resetAllMocks`.
  vi.mocked(checkConsentRateLimit).mockResolvedValue(RL_OK);
  $transaction.mockImplementation((fn: TxFn) =>
    fn({ consentReceipt: prisma.consentReceipt }),
  );
  vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
    count: 0,
  } as never);
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

  it("returns 429 when the per-user consent bucket is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkConsentRateLimit).mockResolvedValue({
      allowed: false,
      limit: 20,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      req({
        kind: "ai_full",
        artefact: "PDF",
        signedAt: "2026-05-18T10:00:00.000Z",
      }),
    );
    expect(res.status).toBe(429);
    // The throttle fires before any write touches the receipts table.
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
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
