import { describe, it, expect, vi, beforeEach } from "vitest";

// v1.4.23 (HIGH 6) — verify the device-revoke cascade wraps every
// write inside `prisma.$transaction` so a partial failure doesn't
// leave the device row alive with all its tokens revoked. Also pins
// the cross-user 404 path (returns null) and the no-access-token
// short-circuit (no apiToken.updateMany call when there are no live
// tokens).

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    refreshToken: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    apiToken: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/db";
import { revokeDeviceCascade } from "../revoke";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("revokeDeviceCascade", () => {
  it("returns null and runs no writes when the device id is unknown", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue(null);

    const result = await revokeDeviceCascade("user-1", "missing-id");

    expect(result).toBeNull();
    expect(vi.mocked(prisma.$transaction)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.refreshToken.updateMany)).not.toHaveBeenCalled();
  });

  it("returns null on cross-user attempts (caller is not the owner)", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "other-user",
      model: "iPhone 15",
      bundleId: "io.healthlog.ios",
    } as never);

    const result = await revokeDeviceCascade("user-1", "dev-1");

    expect(result).toBeNull();
    expect(vi.mocked(prisma.$transaction)).not.toHaveBeenCalled();
  });

  it("wraps the cascade in a single $transaction and reports counts", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "user-1",
      token: "install-1",
      model: "iPhone 15",
      bundleId: "io.healthlog.ios",
    } as never);
    vi.mocked(prisma.refreshToken.findMany).mockResolvedValue([
      { accessTokenHash: "hash-a" },
      { accessTokenHash: "hash-b" },
      { accessTokenHash: null },
    ] as never);

    // Track which prisma method calls the helper queues into the
    // transaction array. We don't actually execute them; the helper
    // hands the array to `$transaction` and the contract is "all of
    // these commit atomically or none do".
    vi.mocked(prisma.refreshToken.updateMany).mockReturnValue(
      "REFRESH_UPDATE" as never,
    );
    vi.mocked(prisma.apiToken.updateMany).mockReturnValue(
      "API_TOKEN_UPDATE" as never,
    );
    vi.mocked(prisma.device.delete).mockReturnValue("DEVICE_DELETE" as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const result = await revokeDeviceCascade("user-1", "dev-1");

    expect(result).toEqual({
      id: "dev-1",
      label: "iPhone 15",
      refreshTokensRevoked: 3,
      accessTokensRevoked: 2,
    });
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);
    const txArg = vi.mocked(prisma.$transaction).mock.calls[0]?.[0];
    expect(Array.isArray(txArg)).toBe(true);
    expect(txArg).toEqual([
      "REFRESH_UPDATE",
      "API_TOKEN_UPDATE",
      "DEVICE_DELETE",
    ]);
    // Sign-ins are keyed on the device's token (`X-Device-Id`), not its id.
    expect(vi.mocked(prisma.refreshToken.updateMany)).toHaveBeenCalledWith({
      where: { userId: "user-1", deviceId: "install-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("omits the apiToken.updateMany write when no access-token hashes exist", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-2",
      userId: "user-1",
      model: null,
      bundleId: "io.healthlog.ios",
    } as never);
    vi.mocked(prisma.refreshToken.findMany).mockResolvedValue([
      { accessTokenHash: null },
    ] as never);

    vi.mocked(prisma.refreshToken.updateMany).mockReturnValue(
      "REFRESH_UPDATE" as never,
    );
    vi.mocked(prisma.device.delete).mockReturnValue("DEVICE_DELETE" as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const result = await revokeDeviceCascade("user-1", "dev-2");

    expect(result?.accessTokensRevoked).toBe(0);
    expect(vi.mocked(prisma.apiToken.updateMany)).not.toHaveBeenCalled();
    const txArg = vi.mocked(prisma.$transaction).mock.calls[0]?.[0];
    expect(txArg).toEqual(["REFRESH_UPDATE", "DEVICE_DELETE"]);
  });

  it("propagates transaction failure (rollback path) — no swallowed error", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-3",
      userId: "user-1",
      model: "iPad",
      bundleId: null,
    } as never);
    vi.mocked(prisma.refreshToken.findMany).mockResolvedValue([
      { accessTokenHash: "hash-c" },
    ] as never);
    vi.mocked(prisma.refreshToken.updateMany).mockReturnValue("R" as never);
    vi.mocked(prisma.apiToken.updateMany).mockReturnValue("A" as never);
    vi.mocked(prisma.device.delete).mockReturnValue("D" as never);
    vi.mocked(prisma.$transaction).mockRejectedValue(
      new Error("postgres-blip"),
    );

    await expect(revokeDeviceCascade("user-1", "dev-3")).rejects.toThrow(
      "postgres-blip",
    );
  });
});
