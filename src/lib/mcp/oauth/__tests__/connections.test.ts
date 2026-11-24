/**
 * MCP OAuth connection anchor — H2 revocation + reuse-detection.
 *
 * These pin the security contract the stateless refresh artifact alone cannot
 * provide: a revoked connection stops every future refresh, a replayed
 * (already-rotated) jti revokes the whole connection, and a settings revoke
 * terminates the chain and kills the connection's access tokens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    mcpOAuthConnection: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    apiToken: {
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import {
  createConnection,
  rotateConnection,
  revokeConnectionForUser,
} from "../connections";

const CONN = {
  id: "conn-1",
  userId: "user-1",
  clientId: "https://app.example/client.json",
  currentJti: "jti-current",
  createdAt: new Date(),
  revokedAt: null as Date | null,
};

const TX = {
  mcpOAuthConnection: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
  apiToken: {
    updateMany: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.apiToken.updateMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.mcpOAuthConnection.updateMany).mockResolvedValue({
    count: 1,
  } as never);
  TX.mcpOAuthConnection.updateMany.mockResolvedValue({ count: 1 });
  TX.apiToken.updateMany.mockResolvedValue({ count: 0 });
});

describe("createConnection", () => {
  it("seeds currentJti with the first refresh jti", async () => {
    vi.mocked(prisma.mcpOAuthConnection.create).mockResolvedValue({
      id: "conn-1",
    } as never);
    const id = await createConnection({
      userId: "user-1",
      clientId: CONN.clientId,
      clientName: "Claude",
      scope: "health:read offline_access",
      resource: "https://health.example/mcp",
      jti: "jti-1",
    });
    expect(id).toBe("conn-1");
    expect(prisma.mcpOAuthConnection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentJti: "jti-1" }),
      }),
    );
  });
});

describe("rotateConnection — happy path", () => {
  it("advances currentJti and revokes prior access tokens (L4)", async () => {
    vi.mocked(prisma.mcpOAuthConnection.findUnique).mockResolvedValue({
      ...CONN,
    } as never);
    const out = await rotateConnection({
      connectionId: "conn-1",
      presentedJti: "jti-current",
      newJti: "jti-next",
      clientId: CONN.clientId,
      userId: "user-1",
    });
    expect(out.ok).toBe(true);
    expect(prisma.mcpOAuthConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ currentJti: "jti-current" }),
        data: expect.objectContaining({ currentJti: "jti-next" }),
      }),
    );
    // L4 — prior access tokens revoked on rotation.
    expect(prisma.apiToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mcpConnectionId: "conn-1", revoked: false },
        data: { revoked: true },
      }),
    );
  });

  it("uses the supplied transaction client for the entire rotation", async () => {
    TX.mcpOAuthConnection.findUnique.mockResolvedValue({ ...CONN });

    const out = await rotateConnection(
      {
        connectionId: "conn-1",
        presentedJti: "jti-current",
        newJti: "jti-next",
        clientId: CONN.clientId,
        userId: "user-1",
      },
      TX as never,
    );

    expect(out.ok).toBe(true);
    expect(TX.mcpOAuthConnection.findUnique).toHaveBeenCalledTimes(1);
    expect(TX.mcpOAuthConnection.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.apiToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mcpConnectionId: "conn-1", revoked: false },
      }),
    );
    expect(prisma.mcpOAuthConnection.findUnique).not.toHaveBeenCalled();
    expect(prisma.mcpOAuthConnection.updateMany).not.toHaveBeenCalled();
    expect(prisma.apiToken.updateMany).not.toHaveBeenCalled();
  });
});

describe("rotateConnection — revoked connection stops refresh", () => {
  it("rejects when the connection is revoked", async () => {
    vi.mocked(prisma.mcpOAuthConnection.findUnique).mockResolvedValue({
      ...CONN,
      revokedAt: new Date(),
    } as never);
    const out = await rotateConnection({
      connectionId: "conn-1",
      presentedJti: "jti-current",
      newJti: "jti-next",
      clientId: CONN.clientId,
      userId: "user-1",
    });
    expect(out).toEqual({ ok: false, reason: "revoked" });
    expect(prisma.mcpOAuthConnection.updateMany).not.toHaveBeenCalled();
  });
});

describe("rotateConnection — reuse detection revokes the family", () => {
  it("revokes the connection when a stale jti is presented", async () => {
    vi.mocked(prisma.mcpOAuthConnection.findUnique).mockResolvedValue({
      ...CONN,
      currentJti: "jti-rotated-already",
    } as never);
    const out = await rotateConnection({
      connectionId: "conn-1",
      presentedJti: "jti-old", // not the current jti → replay
      newJti: "jti-next",
      clientId: CONN.clientId,
      userId: "user-1",
    });
    expect(out).toEqual({ ok: false, reason: "reuse_detected" });
    // The whole connection is revoked + its access tokens killed.
    expect(prisma.mcpOAuthConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn-1", revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(prisma.apiToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mcpConnectionId: "conn-1", revoked: false },
      }),
    );
  });

  it("rejects a connection owned by another user", async () => {
    vi.mocked(prisma.mcpOAuthConnection.findUnique).mockResolvedValue({
      ...CONN,
      userId: "someone-else",
    } as never);
    const out = await rotateConnection({
      connectionId: "conn-1",
      presentedJti: "jti-current",
      newJti: "jti-next",
      clientId: CONN.clientId,
      userId: "user-1",
    });
    expect(out).toEqual({ ok: false, reason: "not_found" });
  });

  it("revokes the family and linked access tokens when the CAS contender loses", async () => {
    vi.mocked(prisma.mcpOAuthConnection.findUnique).mockResolvedValue({
      ...CONN,
    } as never);
    vi.mocked(prisma.mcpOAuthConnection.updateMany)
      .mockResolvedValueOnce({ count: 0 } as never)
      .mockResolvedValueOnce({ count: 1 } as never);

    const out = await rotateConnection({
      connectionId: "conn-1",
      presentedJti: "jti-current",
      newJti: "jti-loser",
      clientId: CONN.clientId,
      userId: "user-1",
    });

    expect(out).toEqual({ ok: false, reason: "reuse_detected" });
    expect(prisma.mcpOAuthConnection.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "conn-1", revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(prisma.apiToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mcpConnectionId: "conn-1", revoked: false },
        data: { revoked: true },
      }),
    );
  });
});

describe("revokeConnectionForUser — settings revoke kills the chain", () => {
  it("revokes a connection owned by the user and its access tokens", async () => {
    vi.mocked(prisma.mcpOAuthConnection.findUnique).mockResolvedValue({
      id: "conn-1",
      userId: "user-1",
      revokedAt: null,
    } as never);
    const ok = await revokeConnectionForUser("user-1", "conn-1");
    expect(ok).toBe(true);
    expect(prisma.mcpOAuthConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(prisma.apiToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mcpConnectionId: "conn-1", revoked: false },
        data: { revoked: true },
      }),
    );
  });

  it("refuses to revoke another user's connection", async () => {
    vi.mocked(prisma.mcpOAuthConnection.findUnique).mockResolvedValue({
      id: "conn-1",
      userId: "someone-else",
      revokedAt: null,
    } as never);
    const ok = await revokeConnectionForUser("user-1", "conn-1");
    expect(ok).toBe(false);
    expect(prisma.mcpOAuthConnection.updateMany).not.toHaveBeenCalled();
  });
});
