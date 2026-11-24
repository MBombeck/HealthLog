/**
 * Every renewing credential ends a fixed time after its sign-in.
 *
 * A web session slides with use and a native refresh token slides with every
 * rotation; on their own, both let a credential in daily use live for ever.
 * Against a real database this file pins the absolute end on all three
 * families:
 *   a) a web session past SESSION_MAX_LIFETIME_DAYS from its sign-in is
 *      refused, even when its stored expiry is still ahead;
 *   b) a native refresh family hands its sign-in instant to every rotation,
 *      caps both tokens of the pair at its end, and refuses to rotate past it
 *      (`family_ended`, answered to the app as `auth.refresh.invalid`);
 *   c) an MCP connection refuses to refresh past its end and is stamped
 *      revoked, so it leaves the settings list.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const { issueAccessAndRefresh, rotateRefreshToken } =
  await import("@/lib/auth/refresh-token");
const { validateSessionFromCookieValue } = await import("@/lib/auth/session");
const { hashToken } = await import("@/lib/auth/hmac");
const { createConnection, rotateConnection, listConnectionsForUser } =
  await import("@/lib/mcp/oauth/connections");

const DAY_MS = 24 * 60 * 60 * 1000;

const NATIVE_POLICY = {
  policy: "native" as const,
  accessTokenDays: 1,
  refreshTokenDays: 60,
  tokenLabel: "native",
};

async function seedUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test` },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  delete process.env.REFRESH_TOKEN_MAX_LIFETIME_DAYS;
  delete process.env.SESSION_MAX_LIFETIME_DAYS;
});

describe("web session", () => {
  it("is refused past its absolute lifetime though its expiry is ahead", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("web-lifetime");
    const fresh = `hls_${"1".repeat(64)}`;
    const old = `hls_${"2".repeat(64)}`;
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(fresh),
        createdAt: new Date(Date.now() - 89 * DAY_MS),
        expiresAt: new Date(Date.now() + 5 * DAY_MS),
      },
    });
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(old),
        createdAt: new Date(Date.now() - 91 * DAY_MS),
        expiresAt: new Date(Date.now() + 5 * DAY_MS),
      },
    });

    expect(await validateSessionFromCookieValue(fresh)).not.toBeNull();
    expect(await validateSessionFromCookieValue(old)).toBeNull();

    process.env.SESSION_MAX_LIFETIME_DAYS = "30";
    expect(await validateSessionFromCookieValue(fresh)).toBeNull();
  });
});

describe("native refresh family", () => {
  it("hands its sign-in on through rotation and caps the pair at its end", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("family-carry");
    const familyStartedAt = new Date(Date.now() - 179 * DAY_MS);
    const first = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: "device-carry",
      source: "test",
      familyStartedAt,
    });
    const familyEnd = familyStartedAt.getTime() + 180 * DAY_MS;
    expect(first.refreshTokenExpiresAt.getTime()).toBe(familyEnd);
    expect(first.accessTokenExpiresAt.getTime()).toBe(familyEnd);

    const rotated = await rotateRefreshToken({
      refreshToken: first.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "device-carry",
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.bundle.refreshTokenExpiresAt.getTime()).toBe(familyEnd);

    const successor = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rotated.bundle.refreshToken) },
    });
    expect(successor?.familyStartedAt.getTime()).toBe(
      familyStartedAt.getTime(),
    );
  });

  it("starts a family at sign-in with the full sliding window", async () => {
    const user = await seedUser("family-new");
    const before = Date.now();
    const bundle = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: "device-new",
      source: "test",
    });
    const row = await getPrismaClient().refreshToken.findUnique({
      where: { tokenHash: hashToken(bundle.refreshToken) },
    });
    expect(row!.familyStartedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(
      bundle.refreshTokenExpiresAt.getTime() - row!.familyStartedAt.getTime(),
    ).toBeGreaterThanOrEqual(60 * DAY_MS - 1000);
  });

  it("refuses to rotate a family past its end, also one stored before the limit", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("family-ended");
    const bundle = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: "device-ended",
      source: "test",
    });
    // A row written before the limit: a sliding expiry well ahead, its family
    // dated (by the migration) to a rotation long past the limit.
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(bundle.refreshToken) },
      data: {
        familyStartedAt: new Date(Date.now() - 181 * DAY_MS),
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
      },
    });

    const result = await rotateRefreshToken({
      refreshToken: bundle.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "device-ended",
    });
    expect(result).toEqual({ ok: false, reason: "family_ended" });
  });

  it("answers the app's refresh with auth.refresh.invalid once the family ended", async () => {
    const user = await seedUser("family-route");
    process.env.REFRESH_TOKEN_MAX_LIFETIME_DAYS = "1";
    const bundle = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: "device-route",
      source: "test",
      familyStartedAt: new Date(Date.now() - 2 * DAY_MS),
    });

    const { POST } = await import("@/app/api/auth/refresh/route");
    const response = await POST(
      new Request("https://health.example/api/auth/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "HealthLog-iOS/1.0",
          "x-device-id": "device-route",
          "x-forwarded-for": "203.0.113.7",
        },
        body: JSON.stringify({ refreshToken: bundle.refreshToken }),
      }) as never,
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("auth.refresh.invalid");
  });
});

describe("MCP connection", () => {
  it("refreshes inside its lifetime and ends, revoked, past it", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("mcp-lifetime");
    const connectionId = await createConnection({
      userId: user.id,
      clientId: "https://connector.example/client.json",
      clientName: "Connector",
      scope: "health:read offline_access",
      resource: "https://health.example/mcp",
      jti: "jti-1",
    });

    const live = await prisma.$transaction((tx) =>
      rotateConnection(
        {
          connectionId,
          presentedJti: "jti-1",
          newJti: "jti-2",
          clientId: "https://connector.example/client.json",
          userId: user.id,
        },
        tx,
      ),
    );
    expect(live.ok).toBe(true);
    if (live.ok) {
      const row = await prisma.mcpOAuthConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });
      expect(live.endsAt.getTime()).toBe(
        row.createdAt.getTime() + 180 * DAY_MS,
      );
    }

    await prisma.mcpOAuthConnection.update({
      where: { id: connectionId },
      data: { createdAt: new Date(Date.now() - 181 * DAY_MS) },
    });
    expect(await listConnectionsForUser(user.id)).toEqual([]);

    const ended = await prisma.$transaction((tx) =>
      rotateConnection(
        {
          connectionId,
          presentedJti: "jti-2",
          newJti: "jti-3",
          clientId: "https://connector.example/client.json",
          userId: user.id,
        },
        tx,
      ),
    );
    expect(ended).toEqual({ ok: false, reason: "lifetime_ended" });
    const row = await prisma.mcpOAuthConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(row.revokedAt).not.toBeNull();
  });
});
