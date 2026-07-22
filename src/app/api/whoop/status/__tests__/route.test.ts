import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    whoopConnection: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null }),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const connFind = prisma.whoopConnection.findUnique as ReturnType<typeof vi.fn>;

describe("GET /api/whoop/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports not-connected, not-configured when nothing is set", async () => {
    userFind.mockResolvedValue(null);
    connFind.mockResolvedValue(null);
    const res = (await (GET as unknown as () => Promise<{ data: unknown }>)())
      .data as { connected: boolean; configured: boolean };
    expect(res.connected).toBe(false);
    expect(res.configured).toBe(false);
  });

  it("reports configured when credentials exist but no connection", async () => {
    userFind.mockResolvedValue({
      whoopClientIdEncrypted: "x",
      whoopClientSecretEncrypted: "y",
    });
    connFind.mockResolvedValue(null);
    const res = (await (GET as unknown as () => Promise<{ data: unknown }>)())
      .data as { connected: boolean; configured: boolean };
    expect(res.connected).toBe(false);
    expect(res.configured).toBe(true);
  });

  it("reports an identity-cleared duplicate row as disconnected", async () => {
    userFind.mockResolvedValue({
      whoopClientIdEncrypted: "x",
      whoopClientSecretEncrypted: "y",
    });
    connFind.mockResolvedValue({
      whoopUserId: null,
      lastSyncedAt: new Date("2026-06-03T00:00:00Z"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      backfillCompletedAt: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      scope: "offline read:recovery",
    });

    const res = (await (GET as unknown as () => Promise<{ data: unknown }>)())
      .data as { connected: boolean; configured: boolean };

    expect(res.connected).toBe(false);
    expect(res.configured).toBe(true);
  });

  it("reports connection state with token expiry and backfill flag", async () => {
    userFind.mockResolvedValue({
      whoopClientIdEncrypted: "x",
      whoopClientSecretEncrypted: "y",
    });
    connFind.mockResolvedValue({
      whoopUserId: "w1",
      lastSyncedAt: new Date("2026-06-03T00:00:00Z"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      backfillCompletedAt: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      scope: "offline read:recovery",
    });
    const res = (await (GET as unknown as () => Promise<{ data: unknown }>)())
      .data as {
      connected: boolean;
      tokenExpired: boolean;
      backfillCompleted: boolean;
    };
    expect(res.connected).toBe(true);
    expect(res.tokenExpired).toBe(false);
    expect(res.backfillCompleted).toBe(false);
  });
});
