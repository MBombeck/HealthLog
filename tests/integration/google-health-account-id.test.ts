/**
 * Two records on one instance connect two different Google accounts, against
 * real Postgres and the real callback route.
 *
 * The id a connection stores is the `{user}` segment of the profile's
 * resource name `users/{user}/profile`. Until v1.46.4 the last segment was
 * stored, the constant `profile`, so every connection looked like the same
 * Google account and the one-account-per-record check refused the second
 * record on the instance with `already_linked`, also on a reconnect.
 *
 * Migration 0491 cleared those placeholders to null. A connection left with
 * no id syncs, but the check cannot see it; a clean sync cycle reads the id
 * back with the connection's own token and stores it.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "integration-hmac-key-0123456789abcdef0123456789";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/boss-ready", () => ({
  enqueueWhenBossReady: vi.fn().mockResolvedValue("skipped"),
}));

// The sync cycle's four resources stand in as one written row each, so a
// cycle is clean and reaches the account-id read; their own wire is covered
// elsewhere.
vi.mock("@/lib/google-health/sync-workout", () => ({
  syncUserWorkout: vi.fn(async () => 1),
}));
vi.mock("@/lib/google-health/sync-sleep", () => ({
  syncUserSleep: vi.fn(async () => 1),
}));
vi.mock("@/lib/google-health/sync-activity", () => ({
  syncUserActivity: vi.fn(async () => 1),
}));
vi.mock("@/lib/google-health/sync-metrics", () => ({
  syncUserMetrics: vi.fn(async () => 1),
}));

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_URL = "https://health.googleapis.com/v4/users/me/profile";
const IDENTITY_URL = "https://health.googleapis.com/v4/users/me/identity";
const FIRST = "gh-first";
const SECOND = "gh-second";

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : (input as Request).url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Google as one account sees it: its profile and identity. */
function googleAs(
  healthUserId: string,
  opts: { profileName?: string; identityStatus?: number } = {},
) {
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = urlOf(input);
    if (url === TOKEN_URL) {
      return json({
        access_token: `access-${healthUserId}`,
        refresh_token: `refresh-${healthUserId}`,
        expires_in: 3600,
      });
    }
    if (url === PROFILE_URL) {
      return json({
        name: opts.profileName ?? `users/${healthUserId}/profile`,
        age: 40,
      });
    }
    if (url === IDENTITY_URL) {
      if (opts.identityStatus && opts.identityStatus !== 200) {
        return json(
          { error: { code: opts.identityStatus } },
          opts.identityStatus,
        );
      }
      return json({
        name: "users/me/identity",
        healthUserId,
        legacyUserId: "LEGACY",
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function connect(userId: string): Promise<string | null> {
  const prisma = getPrismaClient();
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const nonce = `nonce-${userId}-${Math.random().toString(36).slice(2)}`;
  await prisma.googleHealthOAuthState.create({
    data: {
      nonce,
      userId,
      codeVerifier: "verifier",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const { GET } = await import("@/app/api/google-health/callback/route");
  const params = new URLSearchParams({ code: "code", state: nonce });
  const res = await GET(
    new NextRequest(`http://localhost/api/google-health/callback?${params}`, {
      method: "GET",
      headers: { cookie: `google_health_state=${nonce}` },
    }),
  );
  return res.headers.get("location");
}

async function storedId(userId: string) {
  const row = await getPrismaClient().googleHealthConnection.findUnique({
    where: { userId },
    select: { googleUserId: true },
  });
  return row?.googleUserId;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  const { encrypt } = await import("@/lib/crypto");
  for (const id of [FIRST, SECOND]) {
    await getPrismaClient().user.create({
      data: {
        id,
        username: id,
        email: `${id}@example.test`,
        role: "USER",
        googleHealthClientIdEncrypted: encrypt("client-id"),
        googleHealthClientSecretEncrypted: encrypt("client-secret"),
      },
    });
  }
  vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google Health account id", () => {
  it("connects two records with two Google accounts and stores each id", async () => {
    googleAs("111");
    expect(await connect(FIRST)).toContain("googleHealth=connected");
    googleAs("222");
    expect(await connect(SECOND)).toContain("googleHealth=connected");
    expect(await storedId(FIRST)).toBe("111");
    expect(await storedId(SECOND)).toBe("222");
  });

  it("still refuses the same Google account on a second record", async () => {
    googleAs("111");
    await connect(FIRST);
    const location = await connect(SECOND);
    expect(location).toContain("reason=already_linked");
    expect(await storedId(SECOND)).toBeUndefined();
  });

  it("reconnects a record whose stored id is the old placeholder, next to another one", async () => {
    const { encrypt } = await import("@/lib/crypto");
    // The state the repair migration leaves: ids cleared to unknown.
    for (const userId of [FIRST, SECOND]) {
      await getPrismaClient().googleHealthConnection.create({
        data: {
          userId,
          googleUserId: null,
          accessToken: encrypt("old"),
          refreshToken: encrypt("old"),
          tokenExpiresAt: new Date(),
          needsReauth: true,
        },
      });
    }
    googleAs("222");
    expect(await connect(SECOND)).toContain("googleHealth=connected");
    expect(await storedId(SECOND)).toBe("222");
  });

  it("reads the id from the identity when the profile answers through the me alias", async () => {
    googleAs("333", { profileName: "users/me/profile" });
    expect(await connect(FIRST)).toContain("googleHealth=connected");
    expect(await storedId(FIRST)).toBe("333");
  });

  it("connects with the id unknown when neither read names the account", async () => {
    googleAs("444", { profileName: "users/me/profile", identityStatus: 403 });
    expect(await connect(FIRST)).toContain("googleHealth=connected");
    expect(await storedId(FIRST)).toBeNull();
    googleAs("555", { profileName: "users/me/profile", identityStatus: 403 });
    expect(await connect(SECOND)).toContain("googleHealth=connected");
    expect(await storedId(SECOND)).toBeNull();
  });
});

/** A connection as migration 0491 leaves it: synced, token valid, id unknown. */
async function seedUnknownId(
  userId: string,
  googleUserId: string | null = null,
) {
  const { encrypt } = await import("@/lib/crypto");
  await getPrismaClient().googleHealthConnection.create({
    data: {
      userId,
      googleUserId,
      accessToken: encrypt(`access-${userId}`),
      refreshToken: encrypt(`refresh-${userId}`),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      needsReauth: false,
    },
  });
}

function profileReads(): number {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([input]) => urlOf(input) === PROFILE_URL).length;
}

describe("Google Health account id after the placeholder repair", () => {
  it("reads the id back on a clean sync, so the same account is refused elsewhere", async () => {
    await seedUnknownId(FIRST);
    googleAs("111");
    const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");
    const result = await syncUserGoogleHealth(FIRST);
    expect(result.failed).toBe(false);
    expect(await storedId(FIRST)).toBe("111");

    expect(await connect(SECOND)).toContain("reason=already_linked");
    expect(await storedId(SECOND)).toBeUndefined();
  });

  it("does not read the profile again once the id is known", async () => {
    await seedUnknownId(FIRST, "111");
    googleAs("111");
    const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");
    await syncUserGoogleHealth(FIRST);
    expect(profileReads()).toBe(0);
    expect(await storedId(FIRST)).toBe("111");
  });

  it("leaves the id unknown when another record already holds the account", async () => {
    await seedUnknownId(FIRST);
    await seedUnknownId(SECOND, "111");
    googleAs("111");
    const { healGoogleHealthAccountId } =
      await import("@/lib/google-health/account-id-heal");
    expect(await healGoogleHealthAccountId(FIRST, "access-gh-first")).toBe(
      "linked_elsewhere",
    );
    expect(await storedId(FIRST)).toBeNull();
    expect(await storedId(SECOND)).toBe("111");
  });

  it("keeps an id a reconnect stored while the read was under way", async () => {
    await seedUnknownId(FIRST);
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url === PROFILE_URL) {
        // The callback lands between the profile read and the write.
        await getPrismaClient().googleHealthConnection.update({
          where: { userId: FIRST },
          data: { googleUserId: "999" },
        });
        return json({ name: "users/111/profile" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { healGoogleHealthAccountId } =
      await import("@/lib/google-health/account-id-heal");
    expect(await healGoogleHealthAccountId(FIRST, "access-gh-first")).toBe(
      "healed",
    );
    expect(await storedId(FIRST)).toBe("999");
  });

  it("stays unknown, and the sync stays clean, when Google names no account", async () => {
    await seedUnknownId(FIRST);
    googleAs("444", { profileName: "users/me/profile", identityStatus: 403 });
    const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");
    const result = await syncUserGoogleHealth(FIRST);
    expect(result.failed).toBe(false);
    expect(await storedId(FIRST)).toBeNull();
  });

  it("keeps the sync clean when the profile read fails", async () => {
    await seedUnknownId(FIRST);
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (urlOf(input) === PROFILE_URL) return json({ error: {} }, 503);
      throw new Error(`Unexpected fetch: ${urlOf(input)}`);
    });
    const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");
    const result = await syncUserGoogleHealth(FIRST);
    expect(result.failed).toBe(false);
    expect(await storedId(FIRST)).toBeNull();
  });
});
