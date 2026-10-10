/**
 * #1194 — a Google Health history backfill that meets Google's per-minute
 * quota and an access token that runs out part-way, against Postgres.
 *
 * What went wrong. After a reconnect the backfill walked the account's whole
 * history while the hourly sync ran beside it, and the two together went over
 * Google's per-user, per-minute quota: every request in that minute answered
 * 429. The backfill resolved one access token at the start of each resource
 * and carried it to the end, and the heart-rate walk outlived it: an hour
 * after the reconnect every request answered 401, a 401 classifies as a
 * revoked grant, and the account was parked at `error_reauth` with a refresh
 * token that was still good. Every later run skipped the parked account, so
 * nothing synced until it was reconnected by hand, and the next backfill
 * parked it again.
 *
 * What this pins, each against the real sync, ledger and lock:
 *   - a 429 is waited out and the request repeated; it never parks anything;
 *   - a token that reaches its expiry mid-walk is renewed before the next
 *     request, and one Google refuses mid-walk is renewed once and the
 *     request repeated, so the walk finishes and the ledger stays connected;
 *   - an account held at `error_reauth` by a data request's 401 recovers on
 *     the next run, while one whose grant the token endpoint refused stays
 *     parked;
 *   - a backfill that stops part-way resumes with the collections it did not
 *     finish, and finishes;
 *   - while one run of an account holds it, the hourly poll and a manual sync
 *     do nothing for that account.
 *
 * Google is replaced at the `safeFetch` seam by a small fake that issues
 * tokens, answers the data reads, and can be told to throttle, revoke or
 * hold a request.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "gh-rate-limit-owner";

const fake = vi.hoisted(() => ({
  /** Heart-rate points in the account's history; 10 per page. */
  heartRatePoints: 60,
  /** The access token Google currently accepts; others answer 401. */
  validToken: "access-0",
  /** Tokens issued so far by the token endpoint. */
  issued: 0,
  /** `expires_in` the token endpoint answers with. */
  expiresIn: 3600,
  /**
   * How many data requests one token serves before Google treats it as
   * expired (the stand-in for an hour passing). Unlimited when 0.
   */
  requestsPerToken: 0,
  servedByCurrentToken: 0,
  /** Answer the token endpoint with `invalid_grant`. */
  refuseGrant: false,
  /** Heart-rate page indexes that answer 429 (once each) before succeeding. */
  throttledPages: new Set<number>(),
  /** Revoke the current access token when this heart-rate page is asked. */
  revokeAtPage: -1,
  /** Hold the request for this heart-rate page until `release` is called. */
  holdAtPage: -1,
  release: null as null | (() => void),
  held: null as null | Promise<void>,
  /** Counters. */
  requestsByPath: new Map<string, number>(),
  status429: 0,
  status401: 0,
  now: Date.parse("2026-10-09T12:00:00.000Z"),
}));

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com") {
        if (fake.refuseGrant) {
          return json({ error: "invalid_grant" }, 400);
        }
        fake.issued += 1;
        fake.validToken = `access-${fake.issued}`;
        fake.servedByCurrentToken = 0;
        return json({
          access_token: fake.validToken,
          expires_in: fake.expiresIn,
          token_type: "Bearer",
        });
      }

      const path = u.pathname.replace(/^\/v4\/users\/me\/dataTypes\//, "");
      fake.requestsByPath.set(path, (fake.requestsByPath.get(path) ?? 0) + 1);
      const auth = new Headers(init?.headers).get("authorization");
      if (
        fake.requestsPerToken > 0 &&
        fake.servedByCurrentToken >= fake.requestsPerToken
      ) {
        fake.validToken = "expired";
      }
      fake.servedByCurrentToken += 1;
      if (auth !== `Bearer ${fake.validToken}`) {
        fake.status401 += 1;
        return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
      }

      if (path === "heart-rate/dataPoints") {
        const page = Number(u.searchParams.get("pageToken") ?? 0);
        if (page === fake.revokeAtPage) {
          fake.revokeAtPage = -1;
          fake.validToken = "revoked";
          fake.status401 += 1;
          return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
        }
        if (fake.throttledPages.has(page)) {
          fake.throttledPages.delete(page);
          fake.status429 += 1;
          return json(
            {
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message:
                  "Quota exceeded for quota metric 'Requests per minute per user'",
              },
            },
            429,
            { "retry-after": "0" },
          );
        }
        if (page === fake.holdAtPage) {
          fake.holdAtPage = -1;
          await fake.held;
        }
        const end = Math.min(fake.heartRatePoints, (page + 1) * 10);
        const dataPoints = [];
        for (let g = page * 10; g < end; g++) {
          dataPoints.push({
            name: `users/me/dataTypes/heart-rate/dataPoints/${1_000_000 + g}`,
            heartRate: {
              beatsPerMinute: String(60 + (g % 20)),
              sampleTime: {
                physicalTime: new Date(fake.now - g * 60_000).toISOString(),
              },
            },
          });
        }
        return json({
          dataPoints,
          ...(end < fake.heartRatePoints
            ? { nextPageToken: String(page + 1) }
            : {}),
        });
      }
      // Every other collection is empty for this account.
      return json({});
    },
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

async function seed(): Promise<void> {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { encrypt } = await import("@/lib/crypto");
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      timezone: "Europe/Berlin",
      googleHealthClientIdEncrypted: encrypt("client-id"),
      googleHealthClientSecretEncrypted: encrypt("client-secret"),
    },
  });
  await prisma.googleHealthConnection.create({
    data: {
      userId: USER,
      googleUserId: `google-${USER}`,
      accessToken: encrypt("access-0"),
      refreshToken: encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
}

beforeEach(async () => {
  fake.heartRatePoints = 60;
  fake.validToken = "access-0";
  fake.issued = 0;
  fake.expiresIn = 3600;
  fake.requestsPerToken = 0;
  fake.servedByCurrentToken = 0;
  fake.refuseGrant = false;
  fake.throttledPages = new Set();
  fake.revokeAtPage = -1;
  fake.holdAtPage = -1;
  fake.release = null;
  fake.held = null;
  fake.requestsByPath = new Map();
  fake.status429 = 0;
  fake.status401 = 0;
  await seed();
}, 120_000);

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

async function ledgerState(): Promise<string | null> {
  const row = await getPrismaClient().integrationStatus.findUnique({
    where: {
      userId_integration: { userId: USER, integration: "google-health" },
    },
    select: { state: true },
  });
  return row?.state ?? null;
}

async function pulseRows(): Promise<number> {
  return getPrismaClient().measurement.count({
    where: { userId: USER, source: "GOOGLE_HEALTH", type: "PULSE" },
  });
}

describe("Google Health backfill under rate limits and token expiry (#1194)", () => {
  it("waits out 429s, never parks, and finishes the backfill", async () => {
    fake.throttledPages = new Set([1, 2, 4]);
    const { runGoogleHealthBackfillForUser } =
      await import("@/lib/jobs/google-health-backfill");

    const { imported } = await runGoogleHealthBackfillForUser(USER);

    expect(fake.status429).toBe(3);
    expect(imported).toBeGreaterThanOrEqual(60);
    expect(await pulseRows()).toBe(60);
    expect(await ledgerState()).toBe("connected");
    const connection =
      await getPrismaClient().googleHealthConnection.findUnique({
        where: { userId: USER },
      });
    expect(connection?.backfillCompletedAt).toBeInstanceOf(Date);
    expect(connection?.backfillProgress).toBeNull();
    expect(connection?.needsReauth).toBe(false);
  });

  it("renews a token that expires mid-walk before Google refuses it", async () => {
    // Every token issued expires a second inside the refresh buffer, so it
    // is due for renewal before each request, and Google stops taking it
    // after three requests: a walk that carried one token to the end would
    // hit 401 on its fourth.
    fake.expiresIn = 299;
    fake.requestsPerToken = 3;
    await getPrismaClient().googleHealthConnection.update({
      where: { userId: USER },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const { runGoogleHealthBackfillForUser } =
      await import("@/lib/jobs/google-health-backfill");

    await runGoogleHealthBackfillForUser(USER);

    expect(fake.status401).toBe(0);
    expect(fake.issued).toBeGreaterThan(1);
    expect(await pulseRows()).toBe(60);
    expect(await ledgerState()).toBe("connected");
  });

  it("renews a token Google refuses mid-walk once and repeats the request", async () => {
    fake.revokeAtPage = 3;
    const { runGoogleHealthBackfillForUser } =
      await import("@/lib/jobs/google-health-backfill");

    await runGoogleHealthBackfillForUser(USER);

    expect(fake.status401).toBe(1);
    expect(fake.issued).toBe(1);
    expect(await pulseRows()).toBe(60);
    expect(await ledgerState()).toBe("connected");
  });

  it("recovers an account held at error_reauth by a data request's 401", async () => {
    const prisma = getPrismaClient();
    await prisma.integrationStatus.create({
      data: {
        userId: USER,
        integration: "google-health",
        state: "error_reauth",
        consecutiveFailuresByKind: {
          transient: 0,
          reauth_required: 8,
          persistent: 0,
        },
      },
    });
    const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");

    const result = await syncUserGoogleHealth(USER);

    expect(result.failed).toBe(false);
    expect(fake.issued).toBe(1);
    expect(await ledgerState()).toBe("connected");
  });

  it("keeps an account parked when the token endpoint refuses the grant", async () => {
    const prisma = getPrismaClient();
    await prisma.integrationStatus.create({
      data: {
        userId: USER,
        integration: "google-health",
        state: "error_reauth",
      },
    });
    fake.refuseGrant = true;
    const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");

    const first = await syncUserGoogleHealth(USER);
    expect(first.failed).toBe(true);
    expect(await ledgerState()).toBe("error_reauth");
    const connection = await prisma.googleHealthConnection.findUnique({
      where: { userId: USER },
      select: { needsReauth: true },
    });
    expect(connection?.needsReauth).toBe(true);

    // Now parked for good: the next run does not even ask the token endpoint.
    fake.requestsByPath = new Map();
    const second = await syncUserGoogleHealth(USER);
    expect(second.failed).toBe(true);
    expect(fake.requestsByPath.size).toBe(0);
  });

  it("resumes a backfill that stopped part-way with what it did not finish", async () => {
    const { runGoogleHealthBackfillForUser } =
      await import("@/lib/jobs/google-health-backfill");

    // First attempt: the budget runs out three heart-rate pages in.
    let heartRatePagesSeen = 0;
    const stopAfterThreeHeartRatePages = () => {
      heartRatePagesSeen =
        fake.requestsByPath.get("heart-rate/dataPoints") ?? 0;
      return heartRatePagesSeen >= 3;
    };
    await expect(
      runGoogleHealthBackfillForUser(USER, stopAfterThreeHeartRatePages),
    ).rejects.toThrow(/incomplete/);

    const afterFirst =
      await getPrismaClient().googleHealthConnection.findUnique({
        where: { userId: USER },
      });
    expect(afterFirst?.backfillCompletedAt).toBeNull();
    const done = (afterFirst?.backfillProgress as { done: string[] }).done;
    expect(done).toEqual(
      expect.arrayContaining([
        "fetchExercise",
        "sleep",
        "fetchSteps",
        "fetchWeight",
      ]),
    );
    expect(done).not.toContain("fetchHeartRate");

    // Second attempt: the finished collections are not read again.
    fake.requestsByPath = new Map();
    await runGoogleHealthBackfillForUser(USER);

    expect(fake.requestsByPath.get("exercise/dataPoints")).toBeUndefined();
    expect(fake.requestsByPath.get("sleep/dataPoints")).toBeUndefined();
    expect(
      fake.requestsByPath.get("steps/dataPoints:dailyRollUp"),
    ).toBeUndefined();
    expect(fake.requestsByPath.get("heart-rate/dataPoints")).toBe(6);
    expect(await pulseRows()).toBe(60);
    const afterSecond =
      await getPrismaClient().googleHealthConnection.findUnique({
        where: { userId: USER },
      });
    expect(afterSecond?.backfillCompletedAt).toBeInstanceOf(Date);
    expect(afterSecond?.backfillProgress).toBeNull();
  });

  it("never runs the hourly poll or a manual sync beside a running backfill", async () => {
    fake.holdAtPage = 2;
    fake.held = new Promise<void>((resolve) => {
      fake.release = resolve;
    });
    const { runGoogleHealthBackfillForUser } =
      await import("@/lib/jobs/google-health-backfill");
    const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");
    const { handleGoogleHealthSync } =
      await import("@/lib/jobs/reminder/google-health-sync");

    const backfill = runGoogleHealthBackfillForUser(USER);
    // Wait until the backfill is inside its heart-rate walk, holding the lock.
    for (let i = 0; i < 200 && fake.holdAtPage !== -1; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fake.holdAtPage).toBe(-1);

    const requestsBefore = [...fake.requestsByPath.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const manual = await syncUserGoogleHealth(USER);
    expect(manual.busy).toBe(true);

    const hourly = await handleGoogleHealthSync([] as never);
    expect(hourly).toMatchObject({
      ok: true,
      did: { users_skipped: 1, users_parked: 0, users_failed: 0 },
    });
    const requestsAfter = [...fake.requestsByPath.values()].reduce(
      (a, b) => a + b,
      0,
    );
    expect(requestsAfter).toBe(requestsBefore);

    fake.release?.();
    await backfill;
    expect(await pulseRows()).toBe(60);
    expect(await ledgerState()).toBe("connected");
  });
});
