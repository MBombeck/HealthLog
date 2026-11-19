import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/jobs/offhost-purge", () => ({
  requestOffhostPurge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ai/antigravity-auth-session", () => ({
  cancelAntigravityLogin: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-capability-cache", () => ({
  forgetAntigravityCapabilities: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  rm: vi.fn(),
}));

import { rm } from "node:fs/promises";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { cancelAntigravityLogin } from "@/lib/ai/antigravity-auth-session";
import { forgetAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";
import { cleanAntigravityProfileOnLock } from "@/lib/ai/antigravity-profile-cleanup";
import { eraseAccount } from "../lifecycle";

const USER_ID = "user-123";
const PROFILE_ID = "0123456789abcdef0123456789abcdef";

describe("Antigravity account deletion lifecycle", () => {
  const originalRoot = process.env.ANTIGRAVITY_PROFILE_ROOT;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTIGRAVITY_PROFILE_ROOT = "/var/lib/healthlog/antigravity";
  });

  afterEach(() => {
    if (originalRoot === undefined) {
      delete process.env.ANTIGRAVITY_PROFILE_ROOT;
    } else {
      process.env.ANTIGRAVITY_PROFILE_ROOT = originalRoot;
    }
  });

  describe("cleanAntigravityProfileOnLock", () => {
    it("cleans profile directory and clears DB pointer when removal succeeds", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        antigravityProfileId: PROFILE_ID,
      } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
      vi.mocked(rm).mockResolvedValue(undefined);
      vi.mocked(prisma.user.updateMany).mockResolvedValue({
        count: 1,
      } as Prisma.BatchPayload);

      const result = await cleanAntigravityProfileOnLock(USER_ID);

      expect(result).toBe(true);
      expect(rm).toHaveBeenCalledWith(
        `/var/lib/healthlog/antigravity/${PROFILE_ID}`,
        { recursive: true, force: true },
      );
      expect(cancelAntigravityLogin).toHaveBeenCalledWith(USER_ID);
      expect(forgetAntigravityCapabilities).toHaveBeenCalledWith(USER_ID);
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER_ID, antigravityProfileId: PROFILE_ID },
        data: expect.objectContaining({
          antigravityProfileId: null,
          antigravityConnectionStatus: "disconnected",
        }),
      });
    });

    it("preserves profile ID in DB and disables profile use when removal fails so purgeAccount can retry", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        antigravityProfileId: PROFILE_ID,
      } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
      vi.mocked(rm).mockRejectedValue(new Error("EACCES: permission denied"));

      const result = await cleanAntigravityProfileOnLock(USER_ID);

      expect(result).toBe(false);
      expect(rm).toHaveBeenCalledWith(
        `/var/lib/healthlog/antigravity/${PROFILE_ID}`,
        { recursive: true, force: true },
      );
      // Disables profile use while preserving antigravityProfileId
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER_ID, antigravityProfileId: PROFILE_ID },
        data: expect.objectContaining({
          antigravityConnectionStatus: "error",
          antigravityModel: null,
        }),
      });
      const updateData = vi.mocked(prisma.user.updateMany).mock.calls[0][0]
        .data;
      expect(updateData).not.toHaveProperty("antigravityProfileId");
    });

    it("returns true and takes no action when user has no profile", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        antigravityProfileId: null,
      } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

      const result = await cleanAntigravityProfileOnLock(USER_ID);

      expect(result).toBe(true);
      expect(rm).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("eraseAccount", () => {
    it("removes profile directory and deletes user row on success", async () => {
      const tx = {
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        user: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ antigravityProfileId: PROFILE_ID }),
          delete: vi.fn().mockResolvedValue({ id: USER_ID }),
        },
      } as unknown as Prisma.TransactionClient;

      vi.mocked(rm).mockResolvedValue(undefined);

      await eraseAccount(tx, USER_ID, "account_deleted");

      expect(rm).toHaveBeenCalledWith(
        `/var/lib/healthlog/antigravity/${PROFILE_ID}`,
        { recursive: true, force: true },
      );
      expect(cancelAntigravityLogin).toHaveBeenCalledWith(USER_ID);
      expect(forgetAntigravityCapabilities).toHaveBeenCalledWith(USER_ID);
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
    });

    it("throws and aborts transaction without deleting user row if removal fails, preserving DB reference for durable retry", async () => {
      const tx = {
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        user: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ antigravityProfileId: PROFILE_ID }),
          delete: vi.fn().mockResolvedValue({ id: USER_ID }),
        },
      } as unknown as Prisma.TransactionClient;

      vi.mocked(rm).mockRejectedValue(
        new Error("EPERM: operation not permitted"),
      );

      await expect(
        eraseAccount(tx, USER_ID, "account_deleted"),
      ).rejects.toThrow(/Failed to remove Antigravity profile directory/);

      // Crucial: tx.user.delete must never be called on cleanup failure
      expect(tx.user.delete).not.toHaveBeenCalled();
    });

    it("does not pretend missing/invalid root means token gone: aborts transaction and preserves user row", async () => {
      delete process.env.ANTIGRAVITY_PROFILE_ROOT;

      const tx = {
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        user: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ antigravityProfileId: PROFILE_ID }),
          delete: vi.fn().mockResolvedValue({ id: USER_ID }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        eraseAccount(tx, USER_ID, "account_deleted"),
      ).rejects.toThrow(/Failed to remove Antigravity profile directory/);

      expect(tx.user.delete).not.toHaveBeenCalled();
    });

    it("supports safe previously allowed legacy IDs", async () => {
      const tx = {
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        user: {
          findUnique: vi.fn().mockResolvedValue({
            antigravityProfileId: "legacy_user-123_profile",
          }),
          delete: vi.fn().mockResolvedValue({ id: USER_ID }),
        },
      } as unknown as Prisma.TransactionClient;

      vi.mocked(rm).mockResolvedValue(undefined);

      await eraseAccount(tx, USER_ID, "account_deleted");

      expect(rm).toHaveBeenCalledWith(
        "/var/lib/healthlog/antigravity/legacy_user-123_profile",
        { recursive: true, force: true },
      );
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
    });

    it("does not pretend invalid profile ID means token gone: aborts transaction and preserves user row", async () => {
      const tx = {
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        user: {
          findUnique: vi.fn().mockResolvedValue({
            antigravityProfileId: "../traversal/malformed!id",
          }),
          delete: vi.fn().mockResolvedValue({ id: USER_ID }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        eraseAccount(tx, USER_ID, "account_deleted"),
      ).rejects.toThrow(/Failed to remove Antigravity profile directory/);

      expect(tx.user.delete).not.toHaveBeenCalled();
    });

    it("covers old pending accounts and accounts without profile cleanly", async () => {
      const tx = {
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        user: {
          findUnique: vi.fn().mockResolvedValue({ antigravityProfileId: null }),
          delete: vi.fn().mockResolvedValue({ id: USER_ID }),
        },
      } as unknown as Prisma.TransactionClient;

      await eraseAccount(tx, USER_ID, "account_deleted");

      expect(rm).not.toHaveBeenCalled();
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
    });
  });
});
