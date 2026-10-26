/**
 * Oura's refresh tokens are single-use. Overlapping syncs that all meet an
 * expired access token must refresh it once between them, against real
 * Postgres: spending the same refresh token twice is refused, and the
 * authorization server may revoke the grant behind it.
 *
 * Also pinned: a reconnect that stores a new grant while a refresh of the old
 * one is in flight keeps the new grant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OuraClientModule from "@/lib/oura/client";

import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
delete process.env.ENCRYPTION_KEYS;
delete process.env.ENCRYPTION_ACTIVE_KEY_ID;

const { ouraRefresh, collection } = vi.hoisted(() => ({
  ouraRefresh: vi.fn(),
  collection: vi.fn(),
}));

vi.mock("@/lib/oura/client", async (importOriginal) => {
  const actual = await importOriginal<typeof OuraClientModule>();
  return {
    ...actual,
    fetchReadiness: collection,
    fetchSleep: collection,
    fetchDailyActivity: collection,
    fetchDailySleep: collection,
    fetchDailySpo2: collection,
    fetchVo2Max: collection,
    fetchCardiovascularAge: collection,
    fetchResilience: collection,
    fetchDailyCyclePhases: collection,
  };
});
vi.mock("@/lib/oura/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/oura/oauth")>();
  return {
    ...actual,
    ouraOAuth: { ...actual.ouraOAuth, refresh: ouraRefresh },
  };
});

import { decrypt, encrypt } from "@/lib/crypto";
import { OuraApiError } from "@/lib/oura/response-classifier";
import { refreshOuraAfterRefusal } from "@/lib/oura/oauth-descriptor";
import { syncUserOura } from "@/lib/oura/sync";

const USER = "user-oura-refresh";
const CONTENDERS = 12;

function expired() {
  return new OuraApiError({
    verb: "fetchReadiness",
    classification: "reauth_required",
    httpStatus: 401,
    reason: "http_401",
  });
}

async function seed() {
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "oura-refresh",
      email: "oura-refresh@example.test",
      ouraClientIdEncrypted: encrypt("oura-client"),
      ouraClientSecretEncrypted: encrypt("oura-secret"),
      ouraAccessTokenEncrypted: encrypt("stale-access"),
      ouraRefreshTokenEncrypted: encrypt("stale-refresh"),
    },
  });
}

async function storedTokens() {
  const row = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: USER },
    select: {
      ouraAccessTokenEncrypted: true,
      ouraRefreshTokenEncrypted: true,
    },
  });
  return {
    access: decrypt(row.ouraAccessTokenEncrypted!),
    refresh: decrypt(row.ouraRefreshTokenEncrypted!),
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.clearAllMocks();
  await seed();
  // Every collection refuses the stale token and serves the fresh one.
  collection.mockImplementation(async (token: string) => {
    if (token === "stale-access") throw expired();
    return [];
  });
});

describe("Oura token refresh (real Postgres)", () => {
  it("refreshes once for any number of overlapping syncs", async () => {
    ouraRefresh.mockImplementation(async (refreshToken: string) => {
      expect(refreshToken).toBe("stale-refresh");
      await new Promise((r) => setTimeout(r, 100));
      return {
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 86400,
      };
    });

    const results = await Promise.all(
      Array.from({ length: CONTENDERS }, () => syncUserOura(USER)),
    );

    expect(ouraRefresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.failed === false)).toBe(true);
    expect(await storedTokens()).toEqual({
      access: "fresh-access",
      refresh: "fresh-refresh",
    });
  });

  it("keeps a grant a reconnect stored while a refresh of the old one ran", async () => {
    const prisma = getPrismaClient();
    const spent = (await prisma.user.findUniqueOrThrow({
      where: { id: USER },
      select: { ouraRefreshTokenEncrypted: true },
    }))!.ouraRefreshTokenEncrypted!;

    ouraRefresh.mockImplementation(async () => {
      // The callback writes a new grant without taking the refresh lock.
      await prisma.user.update({
        where: { id: USER },
        data: {
          ouraAccessTokenEncrypted: encrypt("reconnect-access"),
          ouraRefreshTokenEncrypted: encrypt("reconnect-refresh"),
        },
      });
      return {
        access_token: "old-grant-access",
        refresh_token: "old-grant-refresh",
        expires_in: 86400,
      };
    });

    const token = await refreshOuraAfterRefusal(USER, spent);

    expect(token).toBe("reconnect-access");
    expect(await storedTokens()).toEqual({
      access: "reconnect-access",
      refresh: "reconnect-refresh",
    });
  });
});
