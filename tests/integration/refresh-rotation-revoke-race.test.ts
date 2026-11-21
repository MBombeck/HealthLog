/**
 * Refresh rotation versus a revocation that lands mid-flight.
 *
 * `rotateRefreshToken` reads the presented row as live, mints a new pair, and
 * only then marks the old row consumed with a conditional update. Until
 * v1.38.11 that condition checked `usedAt: null` alone, so a revocation
 * landing between the read and the write — "sign out everywhere" from another
 * device, a credential rotation — was overtaken: the update still matched, the
 * caller walked away with a fresh pair minted a moment AFTER the family had
 * been ended, and it was the one live login left.
 *
 * The race is made deterministic by hooking the lookup the rotation performs
 * between minting and marking (the `findUnique` that fetches the new row's id)
 * and revoking the family inside it. Real Postgres; the conditional update is
 * the thing under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const { issueAccessAndRefresh, rotateRefreshToken } =
  await import("@/lib/auth/refresh-token");
const { destroyOtherSessions } = await import("@/lib/auth/session");
const { resolveBearerToken, BearerAuthError } =
  await import("@/lib/auth/bearer");
const { prisma } = await import("@/lib/db");

const NATIVE_POLICY = {
  policy: "native" as const,
  accessTokenDays: 1,
  refreshTokenDays: 30,
  tokenLabel: "native",
};
const DEVICE_ID = "race-device-1";

async function seedUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test` },
  });
}

async function bearerVerdict(rawToken: string): Promise<string> {
  try {
    await resolveBearerToken(rawToken, { kind: "wildcard-only" });
  } catch (error) {
    if (error instanceof BearerAuthError) return error.reason;
    throw error;
  }
  return "accepted";
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.restoreAllMocks();
});

describe("refresh rotation — revocation landing between read and consume", () => {
  it("does not hand out a live pair on a family revoked mid-rotation", async () => {
    const user = await seedUser("race-owner");
    const phone = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });
    // A second, web session is the one pressing "sign out everywhere".
    const browser = await getPrismaClient().session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });

    // Hook the lookup between "mint" and "mark consumed", and end the family
    // from the browser session inside it — after the rotation has read the
    // old row as live and after the new pair exists, before the old row is
    // marked. Exactly the window the old `usedAt: null` guard did not cover.
    const original = prisma.refreshToken.findUnique.bind(prisma.refreshToken);
    let revokedInsideTheWindow = false;
    // Prisma's delegate returns a lazy thenable rather than a Promise; the
    // spy's implementation type is widened for that alone.
    const spy = vi
      .spyOn(prisma.refreshToken, "findUnique")
      .mockImplementation((async (args: unknown) => {
        if (!revokedInsideTheWindow) {
          revokedInsideTheWindow = true;
          await destroyOtherSessions(
            user.id,
            { kind: "session", sessionId: browser.id },
            { reach: "everything" },
          );
        }
        return original(args as never);
      }) as never);

    const result = await rotateRefreshToken({
      refreshToken: phone.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
    });
    spy.mockRestore();

    expect(revokedInsideTheWindow).toBe(true);
    // The rotation must lose, and must say why in the word the client acts on.
    expect(result).toEqual({ ok: false, reason: "revoked" });

    // No live refresh token on the family, and nothing minted survives.
    const live = await getPrismaClient().refreshToken.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    expect(live).toHaveLength(0);
    const liveAccess = await getPrismaClient().apiToken.findMany({
      where: { userId: user.id, revoked: false },
    });
    expect(liveAccess).toHaveLength(0);
    expect(await bearerVerdict(phone.accessToken)).toBe("revoked");
  });

  it("POSITIVE CONTROL: the same rotation without a revocation succeeds", async () => {
    const user = await seedUser("race-control");
    const phone = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });
    const result = await rotateRefreshToken({
      refreshToken: phone.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await bearerVerdict(result.bundle.accessToken)).toBe("accepted");
  });

  it("answers the loser of two concurrent rotations as superseded and keeps the winner live", async () => {
    const user = await seedUser("race-sibling");
    const phone = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });

    // Inside the loser's window (after it read the row as live and minted its
    // pair, before it marks the row consumed), a sibling rotation with the
    // same token runs to completion and wins. The second lookup the loser
    // makes is the one that fetches its new row's id, exactly that window.
    const original = prisma.refreshToken.findUnique.bind(prisma.refreshToken);
    let winner: Awaited<ReturnType<typeof rotateRefreshToken>> | null = null;
    let raced = false;
    let lookups = 0;
    const hook = vi
      .spyOn(prisma.refreshToken, "findUnique")
      .mockImplementation((async (args: unknown) => {
        lookups++;
        if (lookups === 2 && !raced) {
          raced = true;
          hook.mockImplementation(original as never);
          winner = await rotateRefreshToken({
            refreshToken: phone.refreshToken,
            policy: NATIVE_POLICY,
            deviceId: DEVICE_ID,
          });
        }
        return original(args as never);
      }) as never);

    const loser = await rotateRefreshToken({
      refreshToken: phone.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
    });
    hook.mockRestore();

    expect(raced).toBe(true);
    expect(loser).toEqual({ ok: false, reason: "superseded" });
    const won = winner as Awaited<ReturnType<typeof rotateRefreshToken>> | null;
    expect(won?.ok).toBe(true);
    if (!won?.ok) return;
    // Nothing was revoked: the winner's pair is the live login.
    expect(await bearerVerdict(won.bundle.accessToken)).toBe("accepted");
    const live = await getPrismaClient().refreshToken.findMany({
      where: { userId: user.id, revokedAt: null, usedAt: null },
    });
    expect(live).toHaveLength(1);
  });

  it("still reports a plain double-consume as already_used", async () => {
    const user = await seedUser("race-double");
    const phone = await issueAccessAndRefresh({
      userId: user.id,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
      source: "test",
    });
    const first = await rotateRefreshToken({
      refreshToken: phone.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
    });
    expect(first.ok).toBe(true);
    const replay = await rotateRefreshToken({
      refreshToken: phone.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: DEVICE_ID,
    });
    expect(replay).toEqual({ ok: false, reason: "already_used" });
  });
});
