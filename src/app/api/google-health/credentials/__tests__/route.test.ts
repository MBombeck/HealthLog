import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiHandlerModule from "@/lib/api-handler";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof ApiHandlerModule>("@/lib/api-handler");
  return {
    ...actual,
    requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
  };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    googleHealthConnection: { delete: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({ encrypt: (value: string) => `enc:${value}` }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({ markDisconnected: vi.fn() }));

import { DELETE } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { markDisconnected } from "@/lib/integrations/status";

const connectionDelete = vi.mocked(prisma.googleHealthConnection.delete);
const userUpdate = vi.mocked(prisma.user.update);

beforeEach(() => {
  vi.clearAllMocks();
  userUpdate.mockResolvedValue({} as never);
});

describe("DELETE /api/google-health/credentials", () => {
  it("succeeds when the connection is already missing", async () => {
    connectionDelete.mockRejectedValue({ code: "P2025" });

    const response = await DELETE();
    const envelope = (await response.json()) as {
      data: { deleted: boolean } | null;
      error: string | null;
    };

    expect(response.status).toBe(200);
    expect(envelope).toEqual({ data: { deleted: true }, error: null });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        googleHealthClientIdEncrypted: null,
        googleHealthClientSecretEncrypted: null,
      },
    });
    expect(auditLog).toHaveBeenCalledWith("google_health.credentials.delete", {
      userId: "u1",
    });
    expect(markDisconnected).toHaveBeenCalledWith("u1", "google-health");
  });

  it("returns an opaque error and stops teardown on an operational delete failure", async () => {
    connectionDelete.mockRejectedValue(
      new Error("database host db.internal.example refused the connection"),
    );

    const response = await DELETE();
    const envelope = (await response.json()) as {
      data: unknown;
      error: string;
    };

    expect(response.status).toBe(500);
    expect(envelope.data).toBeNull();
    expect(envelope.error).not.toContain("db.internal.example");
    expect(userUpdate).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(markDisconnected).not.toHaveBeenCalled();
  });
});
