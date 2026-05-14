import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks must be hoisted before importing the module under test. ---

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// --- Imports use the mocked modules above. ---

import { requireAuth, HttpError } from "../api-handler";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/hmac";
import { auditLog } from "@/lib/auth/audit";

const FAKE_HASH = "deadbeefcafef00d";
const RAW_TOKEN = "hlk_" + "a".repeat(64);

const FAKE_USER = {
  id: "user-1",
  role: "USER" as const,
  username: "marc",
  email: "marc@example.com",
};

function setBearerHeader(value: string | null): void {
  headersGet.mockReset();
  headersGet.mockImplementation((name: string) =>
    name.toLowerCase() === "authorization" ? value : null,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hashToken).mockReturnValue(FAKE_HASH);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
});

describe("requireAuth — Bearer token path", () => {
  it("authenticates a valid Bearer token and returns AuthContext", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    const ctx = await requireAuth();

    expect(hashToken).toHaveBeenCalledWith(RAW_TOKEN);
    // V3 audit: pin the where-clause shape — a regression that switches
    // back to raw-token comparison (where: { tokenHash: RAW_TOKEN }) would
    // be a CRITICAL leak of stored hashes. Tests must enforce the hash.
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: FAKE_HASH } }),
    );
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.session.id).toBe("token-1");
    expect(ctx.session.expiresAt).toEqual(expiresAt);

    // lastUsedAt refresh is fire-and-forget but should still have been triggered.
    expect(prisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.success",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("rejects a revoked token with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-2",
      userId: "user-1",
      permissions: [],
      revoked: true,
      expiresAt: null,
    } as never);

    await expect(requireAuth()).rejects.toMatchObject({
      statusCode: 401,
    } satisfies Partial<HttpError>);
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "revoked" }),
      }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an expired token with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-3",
      userId: "user-1",
      permissions: [],
      revoked: false,
      expiresAt: new Date(Date.now() - 60_000),
    } as never);

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "expired" }),
      }),
    );
  });

  it("rejects an unknown token with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(null);

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "unknown_token" }),
      }),
    );
  });

  it("rejects a Bearer token missing the requested permission with 403", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-4",
      userId: "user-1",
      permissions: ["something:else"],
      revoked: false,
      expiresAt: null,
    } as never);

    await expect(requireAuth("medication:ingest")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "insufficient_permissions",
          required: "medication:ingest",
        }),
      }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a scoped Bearer token when the route did not declare a scope", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5",
      userId: "user-1",
      permissions: ["medication:ingest"],
      revoked: false,
      expiresAt: null,
    } as never);

    await expect(requireAuth()).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "scope_required" }),
      }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when neither cookie nor Bearer is present", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(null);

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });
});

describe("requireAuth — cookie path remains intact", () => {
  it("returns the session payload without consulting the Bearer header", async () => {
    const cookieSession = {
      session: { id: "sess-1", expiresAt: new Date(Date.now() + 3600_000) },
      user: { ...FAKE_USER, role: "USER" as const },
    };
    vi.mocked(getSession).mockResolvedValue(cookieSession as never);
    // Even if a Bearer header is present, the cookie wins (existing behaviour).
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    const ctx = await requireAuth("medication:ingest");

    expect(ctx).toEqual(cookieSession);
    // Cookie short-circuits before any token logic runs.
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
    expect(hashToken).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});
