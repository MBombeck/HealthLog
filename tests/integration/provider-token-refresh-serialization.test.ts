import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WhoopClientModule from "@/lib/whoop/client";
import type * as WithingsClientModule from "@/lib/withings/client";

import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
delete process.env.ENCRYPTION_KEYS;
delete process.env.ENCRYPTION_ACTIVE_KEY_ID;

const { whoopRefresh, withingsRefresh, whoopRecoveries } = vi.hoisted(() => ({
  whoopRefresh: vi.fn(),
  withingsRefresh: vi.fn(),
  whoopRecoveries: vi.fn(),
}));

vi.mock("@/lib/whoop/client", async (importOriginal) => ({
  ...(await importOriginal<typeof WhoopClientModule>()),
  refreshAccessToken: whoopRefresh,
  fetchRecoveries: whoopRecoveries,
}));

vi.mock("@/lib/withings/client", async (importOriginal) => ({
  ...(await importOriginal<typeof WithingsClientModule>()),
  refreshAccessToken: withingsRefresh,
}));

import { encrypt, decrypt } from "@/lib/crypto";
import { getValidToken as getValidWhoopToken } from "@/lib/whoop/sync-core";
import { syncUserRecovery } from "@/lib/whoop/sync-recovery";
import { getValidToken as getValidWithingsToken } from "@/lib/withings/sync";

const CONTENDERS = 75;
const EXPIRED_AT = new Date("2026-01-01T00:00:00.000Z");

async function seedProviderUser(provider: "whoop" | "withings") {
  const prisma = getPrismaClient();
  const userId = `refresh-${provider}`;
  await prisma.user.create({
    data: {
      id: userId,
      username: `refresh-${provider}`,
      email: `refresh-${provider}@example.test`,
      ...(provider === "whoop"
        ? {
            whoopClientIdEncrypted: encrypt("whoop-client"),
            whoopClientSecretEncrypted: encrypt("whoop-secret"),
          }
        : {
            withingsClientIdEncrypted: encrypt("withings-client"),
            withingsClientSecretEncrypted: encrypt("withings-secret"),
          }),
    },
  });

  if (provider === "whoop") {
    await prisma.whoopConnection.create({
      data: {
        userId,
        whoopUserId: "whoop-user",
        accessToken: encrypt("stale-access"),
        refreshToken: encrypt("stale-refresh"),
        tokenExpiresAt: EXPIRED_AT,
      },
    });
  } else {
    await prisma.withingsConnection.create({
      data: {
        userId,
        withingsUserId: "withings-user",
        accessToken: encrypt("stale-access"),
        refreshToken: encrypt("stale-refresh"),
        tokenExpiresAt: EXPIRED_AT,
      },
    });
  }

  return userId;
}

async function runContenders(provider: "whoop" | "withings", userId: string) {
  const getToken =
    provider === "whoop" ? getValidWhoopToken : getValidWithingsToken;
  return Promise.all(
    Array.from({ length: CONTENDERS }, () => getToken(userId)),
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.clearAllMocks();
});

describe.each([
  ["whoop", whoopRefresh],
  ["withings", withingsRefresh],
] as const)(
  "%s rotating token refresh serialization (real Postgres)",
  (provider, refresh) => {
    it("lets exactly one contender refresh a stale token and shares the winner", async () => {
      const userId = await seedProviderUser(provider);
      refresh.mockImplementation(async (refreshToken: string) => {
        expect(refreshToken).toBe("stale-refresh");
        return {
          access_token: "winner-access",
          refresh_token: "winner-refresh",
          expires_in: 3600,
        };
      });

      const results = await runContenders(provider, userId);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(CONTENDERS);
      expect(
        results.every((result) => result?.accessToken === "winner-access"),
      ).toBe(true);

      const prisma = getPrismaClient();
      const row =
        provider === "whoop"
          ? await prisma.whoopConnection.findUniqueOrThrow({
              where: { userId },
            })
          : await prisma.withingsConnection.findUniqueOrThrow({
              where: { userId },
            });
      expect(decrypt(row.accessToken)).toBe("winner-access");
      expect(decrypt(row.refreshToken)).toBe("winner-refresh");
    });

    it("rolls back a failed winner so a later contender can retry", async () => {
      const userId = await seedProviderUser(provider);
      refresh
        .mockRejectedValueOnce(new Error("injected refresh failure"))
        .mockResolvedValue({
          access_token: "retry-access",
          refresh_token: "retry-refresh",
          expires_in: 3600,
        });

      const results = await runContenders(provider, userId);

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect(
        results.filter((result) => result?.accessToken === "retry-access"),
      ).toHaveLength(CONTENDERS - 1);

      const prisma = getPrismaClient();
      const row =
        provider === "whoop"
          ? await prisma.whoopConnection.findUniqueOrThrow({
              where: { userId },
            })
          : await prisma.withingsConnection.findUniqueOrThrow({
              where: { userId },
            });
      expect(decrypt(row.accessToken)).toBe("retry-access");
      expect(decrypt(row.refreshToken)).toBe("retry-refresh");
    });
  },
);

describe("WHOOP recovery cursor durability (real Postgres)", () => {
  const oldCursor = "2026-06-01T00:00:00.000Z";
  const recovery = {
    cycle_id: 1,
    sleep_id: "sleep-real",
    user_id: 42,
    created_at: "2026-06-01T06:00:00.000Z",
    updated_at: "2026-06-01T07:00:00.000Z",
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 66,
      resting_heart_rate: 52,
      hrv_rmssd_milli: 48.7,
      spo2_percentage: 97,
      skin_temp_celsius: 33.4,
    },
  };

  it("holds the cursor on a durable write failure, then advances idempotently", async () => {
    const userId = await seedProviderUser("whoop");
    const prisma = getPrismaClient();
    await prisma.whoopConnection.update({
      where: { userId },
      data: {
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        lastSyncedAt: new Date(oldCursor),
        resourceCursors: { recovery: oldCursor },
      },
    });
    whoopRecoveries.mockResolvedValue([recovery]);

    await prisma.$executeRaw`
      ALTER TABLE "measurements"
      ADD CONSTRAINT "test_whoop_recovery_write_failure"
      CHECK ("external_id" <> 'sleep-real:hrv_rmssd')
    `;

    try {
      await expect(syncUserRecovery(userId)).rejects.toThrow();
      const failed = await prisma.whoopConnection.findUniqueOrThrow({
        where: { userId },
      });
      expect(failed.resourceCursors).toEqual({ recovery: oldCursor });
      expect(await prisma.measurement.count({ where: { userId } })).toBe(0);
    } finally {
      await prisma.$executeRaw`
        ALTER TABLE "measurements"
        DROP CONSTRAINT IF EXISTS "test_whoop_recovery_write_failure"
      `;
    }

    expect(await syncUserRecovery(userId)).toBe(5);
    const succeeded = await prisma.whoopConnection.findUniqueOrThrow({
      where: { userId },
    });
    expect(succeeded.resourceCursors).not.toEqual({ recovery: oldCursor });
    expect(await prisma.measurement.count({ where: { userId } })).toBe(5);

    expect(await syncUserRecovery(userId)).toBe(5);
    expect(await prisma.measurement.count({ where: { userId } })).toBe(5);
  });
});
