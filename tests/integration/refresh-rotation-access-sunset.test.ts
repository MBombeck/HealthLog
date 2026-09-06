/**
 * Refresh rotation must not kill the outgoing access token mid-flight.
 *
 * A native client keeps several requests in flight across the access-token
 * boundary. Some of them leave the device with the old access token a few
 * hundred milliseconds before the rotation commits and land after it. While
 * rotation revoked the paired access token instantly, those requests came back
 * 401 `revoked`, the client read that as "re-authenticate", rotated again with
 * the refresh token it had just consumed, tripped reuse detection, and the
 * whole family died: signed out for having been busy.
 *
 * The contract this file pins:
 *   a) the outgoing access token still authenticates inside the sunset window,
 *      and outside it fails as `expired` — never `revoked`;
 *   b) reuse detection is untouched: a replayed refresh token revokes the
 *      family and its access tokens instantly, with no window;
 *   c) the sunset only ever SHORTENS — a token expiring sooner than the window
 *      keeps its own expiry;
 *   d) logout still revokes instantly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const {
  ACCESS_TOKEN_SUNSET_MS,
  issueAccessAndRefresh,
  rotateRefreshToken,
  revokeBearerAccessToken,
} = await import("@/lib/auth/refresh-token");
const { resolveBearerToken, BearerAuthError } =
  await import("@/lib/auth/bearer");
const { hashToken } = await import("@/lib/auth/hmac");

const NATIVE_POLICY = {
  policy: "native" as const,
  accessTokenDays: 1,
  refreshTokenDays: 30,
  tokenLabel: "native",
};

const DEVICE_ID = "sunset-device-1";

async function seedUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test` },
  });
}

/** The bearer verdict as a plain string, so a failure reads as a diff. */
async function bearerVerdict(rawToken: string): Promise<string> {
  try {
    await resolveBearerToken(rawToken, { kind: "wildcard-only" });
  } catch (error) {
    if (error instanceof BearerAuthError) return error.reason;
    throw error;
  }
  return "accepted";
}

async function rotate(refreshToken: string) {
  const result = await rotateRefreshToken({
    refreshToken,
    policy: NATIVE_POLICY,
    deviceId: DEVICE_ID,
  });
  return result;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.useRealTimers();
});

describe("refresh rotation — paired access-token sunset", () => {
  it("keeps the outgoing access token alive inside the window and expires it after", async () => {
    const user = await seedUser("sunset-inflight");
    const first = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });

    const rotated = await rotate(first.refreshToken);
    if (!rotated.ok) throw new Error(`rotation failed: ${rotated.reason}`);

    // The in-flight request that left the device before the rotation
    // committed: it must still be served.
    expect(await bearerVerdict(first.accessToken)).toBe("accepted");

    // Past the window the token is dead — but as an expiry, not a revoke, so
    // the client treats it as "refresh", not "re-authenticate".
    const afterWindow = Date.now() + ACCESS_TOKEN_SUNSET_MS + 1_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(afterWindow));
    try {
      expect(await bearerVerdict(first.accessToken)).toBe("expired");
    } finally {
      vi.useRealTimers();
    }

    // The replacement pair is untouched by the sunset.
    expect(await bearerVerdict(rotated.bundle.accessToken)).toBe("accepted");
  });

  it("revokes the family and its access tokens instantly on refresh-token reuse", async () => {
    const user = await seedUser("sunset-reuse");
    const first = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });

    const rotated = await rotate(first.refreshToken);
    if (!rotated.ok) throw new Error(`rotation failed: ${rotated.reason}`);

    // Replay of the consumed refresh token: the stolen-token defence.
    const replay = await rotate(first.refreshToken);
    expect(replay).toEqual({ ok: false, reason: "already_used" });

    // No window here: the live pair's access token is revoked, not sunset.
    expect(await bearerVerdict(rotated.bundle.accessToken)).toBe("revoked");
    const revokedRow = await getPrismaClient().apiToken.findUnique({
      where: { tokenHash: hashToken(rotated.bundle.accessToken) },
      select: { revoked: true },
    });
    expect(revokedRow?.revoked).toBe(true);

    const liveRefresh = await getPrismaClient().refreshToken.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    expect(liveRefresh).toHaveLength(0);
  });

  it("never extends an access token whose own expiry is sooner than the window", async () => {
    const user = await seedUser("sunset-min-guard");
    const first = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });

    // This token has 5 seconds left of its own — less than the sunset window.
    const ownExpiry = new Date(Date.now() + 5_000);
    const accessHash = hashToken(first.accessToken);
    await getPrismaClient().apiToken.updateMany({
      where: { tokenHash: accessHash },
      data: { expiresAt: ownExpiry },
    });

    const rotated = await rotate(first.refreshToken);
    if (!rotated.ok) throw new Error(`rotation failed: ${rotated.reason}`);

    const row = await getPrismaClient().apiToken.findUnique({
      where: { tokenHash: accessHash },
      select: { expiresAt: true, revoked: true },
    });
    expect(row?.revoked).toBe(false);
    expect(row?.expiresAt?.getTime()).toBe(ownExpiry.getTime());
  });

  it("revokes instantly at logout", async () => {
    const user = await seedUser("sunset-logout");
    const pair = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });

    expect(await revokeBearerAccessToken(pair.accessToken)).toBe(true);

    expect(await bearerVerdict(pair.accessToken)).toBe("revoked");
    const refreshRow = await getPrismaClient().refreshToken.findUnique({
      where: { tokenHash: hashToken(pair.refreshToken) },
      select: { revokedAt: true },
    });
    expect(refreshRow?.revokedAt).not.toBeNull();
  });
});
