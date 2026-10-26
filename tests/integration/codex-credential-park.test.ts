/**
 * A Codex sign-in the issuer refused is parked until the person signs in
 * again, against the real rows.
 *
 * Before the park, a dead refresh token was asked again on every hop of
 * every run: the chain resolved Codex, the proactive refresh failed and was
 * swallowed, the request 401'd, the on-401 refresh failed again, and the
 * nightly warm repeated that for the briefing and every card. Parking flips
 * the connection to the `expired` state Settings already renders, so the
 * chain and the presence probe stop counting it and nothing leaves until a
 * new sign-in writes `connected`.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

vi.mock("@/lib/logging/signal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/signal")>();
  return { ...actual, emitSignal: vi.fn(actual.emitSignal) };
});

// Only the two calls that would leave the machine are replaced; the
// credential codec stays real so the rows hold genuine ciphertext.
vi.mock("@/lib/ai/codex-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/codex-oauth")>();
  return {
    ...actual,
    refreshDeviceTokens: vi.fn(),
    pollDeviceCode: vi.fn(),
  };
});

import {
  CodexRefreshError,
  encryptAdminCodexCreds,
  encryptCodexCreds,
  pollDeviceCode,
  refreshDeviceTokens,
} from "@/lib/ai/codex-oauth";
import { encrypt } from "@/lib/crypto";
import { emitSignal } from "@/lib/logging/signal";
import { probeProviderChain, resolveProviderChain } from "@/lib/ai/provider";
import { postgresProviderHealthLedger } from "@/lib/ai/provider-health-ledger";

const prisma = getPrismaClient();

const HOUR_MS = 60 * 60 * 1000;

function creds(tag: string, expiresInMs: number) {
  return {
    accessToken: `access-${tag}`,
    refreshToken: `refresh-${tag}`,
    accountId: `account-${tag}`,
    expiresAt: new Date(Date.now() + expiresInMs),
  };
}

function parkSignals(provider: string) {
  return vi
    .mocked(emitSignal)
    .mock.calls.filter(
      ([input]) =>
        input.action === "ai.credential.expired" &&
        input.meta?.provider === provider,
    );
}

async function seedCodexUser() {
  // An access token that expired long ago: the state a dead sign-in sits in.
  const enc = encryptCodexCreds(creds("old", -HOUR_MS));
  const user = await prisma.user.create({
    data: {
      username: "codex-park",
      email: "codex-park@example.test",
      aiProviderChain: [{ providerType: "codex", priority: 1, enabled: true }],
      codexAccessTokenEncrypted: enc.accessEncrypted,
      codexRefreshTokenEncrypted: enc.refreshEncrypted,
      codexConnectionStatus: "connected",
      codexConnectedAt: new Date(),
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(emitSignal).mockClear();
  vi.mocked(refreshDeviceTokens).mockReset();
  vi.mocked(pollDeviceCode).mockReset();
});

afterEach(() => {
  vi.mocked(refreshDeviceTokens).mockReset();
});

describe("a refused Codex sign-in", () => {
  it("is parked once, stops being asked, and resumes after a new sign-in", async () => {
    const user = await seedCodexUser();
    vi.mocked(refreshDeviceTokens).mockRejectedValue(
      new CodexRefreshError(400, "invalid_grant"),
    );

    // Two workers meet the refusal at once: one transition, one signal.
    const [first, second] = await Promise.all([
      resolveProviderChain(user.id),
      resolveProviderChain(user.id),
    ]);
    expect(first.map((p) => p.providerType)).not.toContain("codex");
    expect(second.map((p) => p.providerType)).not.toContain("codex");
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { codexConnectionStatus: true },
        })
      ).codexConnectionStatus,
    ).toBe("expired");
    expect(parkSignals("codex")).toHaveLength(1);
    expect(parkSignals("codex")[0][0].meta?.oauth_error).toBe("invalid_grant");

    // Parked: later runs neither ask the issuer nor count Codex as present.
    const asked = vi.mocked(refreshDeviceTokens).mock.calls.length;
    for (let i = 0; i < 3; i += 1) {
      const chain = await resolveProviderChain(user.id);
      expect(chain.map((p) => p.providerType)).not.toContain("codex");
    }
    expect(vi.mocked(refreshDeviceTokens).mock.calls.length).toBe(asked);
    expect(parkSignals("codex")).toHaveLength(1);
    const presence = await probeProviderChain(user.id);
    expect(presence.availableTypes).not.toContain("codex");

    // The hop that met the refusal left an auth_failed row behind.
    await postgresProviderHealthLedger.recordFailure(user.id, "codex", 401);
    expect(
      (await postgresProviderHealthLedger.getSkipHints(user.id)).get("codex")
        ?.reason,
    ).toBe("credential_expired");

    // The person signs in again through the device-code flow.
    vi.mocked(pollDeviceCode).mockResolvedValue({
      status: "connected",
      creds: creds("new", 10 * HOUR_MS),
    } as Awaited<ReturnType<typeof pollDeviceCode>>);
    cookieJar.set(
      "codex_device",
      encrypt(JSON.stringify({ deviceAuthId: "device", userCode: "CODE" })),
    );
    const { POST } = await import("@/app/api/auth/codex/device-poll/route");
    const res = await POST(
      new NextRequest("http://localhost/api/auth/codex/device-poll", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);

    // Resumed in place: connected, first in the chain, not benched by the
    // refused credential's ledger row, and the fresh token needs no refresh.
    const resumed = await resolveProviderChain(user.id);
    expect(resumed[0]?.providerType).toBe("codex");
    expect(
      (await postgresProviderHealthLedger.getSkipHints(user.id)).has("codex"),
    ).toBe(false);
    expect(vi.mocked(refreshDeviceTokens).mock.calls.length).toBe(asked);
  });

  it("is not parked by a refusal that says nothing about the credential", async () => {
    const user = await seedCodexUser();
    vi.mocked(refreshDeviceTokens).mockRejectedValue(
      new CodexRefreshError(503, null),
    );

    const chain = await resolveProviderChain(user.id);

    // A brown-out at the issuer: the connection stays, the client's own
    // on-401 path gets its chance, and nothing is signalled.
    expect(chain.map((p) => p.providerType)).toContain("codex");
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { codexConnectionStatus: true },
        })
      ).codexConnectionStatus,
    ).toBe("connected");
    expect(parkSignals("codex")).toHaveLength(0);
  });

  it("parks the operator's central connection the same way", async () => {
    const enc = encryptAdminCodexCreds(creds("central", -HOUR_MS));
    await prisma.appSettings.create({
      data: {
        id: "singleton",
        adminCodexAccessTokenEncrypted: enc.accessEncrypted,
        adminCodexRefreshTokenEncrypted: enc.refreshEncrypted,
        adminCodexAccountIdEncrypted: enc.accountIdEncrypted,
        adminCodexTokenExpiresAt: enc.expiresAt,
        adminCodexConnectionStatus: "connected",
      },
    });
    const user = await prisma.user.create({
      data: {
        username: "central-park",
        email: "central-park@example.test",
        aiProviderChain: [],
        useCentralCodex: true,
      },
    });
    vi.mocked(refreshDeviceTokens).mockRejectedValue(
      new CodexRefreshError(401, null),
    );

    const chain = await resolveProviderChain(user.id);
    expect(chain.map((p) => p.providerType)).not.toContain("admin-codex");
    expect(
      (
        await prisma.appSettings.findUniqueOrThrow({
          where: { id: "singleton" },
          select: { adminCodexConnectionStatus: true },
        })
      ).adminCodexConnectionStatus,
    ).toBe("expired");
    expect(parkSignals("admin-codex")).toHaveLength(1);

    await resolveProviderChain(user.id);
    expect(vi.mocked(refreshDeviceTokens)).toHaveBeenCalledTimes(1);
  });
});

/**
 * #1279 — a fresh sign-in also closes the status notes' negative windows,
 * as a save of the person's provider settings and of the operator's admin AI
 * settings do. A window grows with the failures in a row (up to two hours),
 * so without it a fixed connection still had every note wait out the window
 * the refused one earned.
 */
describe("a fresh Codex sign-in and the notes' windows", () => {
  async function openWindow(userId: string) {
    await prisma.insightStatusCache.create({
      data: {
        userId,
        metric: "weight",
        locale: "en",
        dateKey: "2026-06-15",
        retryAt: new Date(Date.now() + HOUR_MS),
        negativeReason: "error",
        failureStreak: 4,
      },
    });
  }

  async function windowOf(userId: string) {
    return prisma.insightStatusCache.findFirstOrThrow({
      where: { userId },
      select: { retryAt: true, failureStreak: true },
    });
  }

  function signedIn() {
    vi.mocked(pollDeviceCode).mockResolvedValue({
      status: "connected",
      creds: creds("new", 10 * HOUR_MS),
    } as Awaited<ReturnType<typeof pollDeviceCode>>);
  }

  it("closes the person's windows on their own sign-in", async () => {
    const user = await seedCodexUser();
    await openWindow(user.id);
    signedIn();
    cookieJar.set(
      "codex_device",
      encrypt(JSON.stringify({ deviceAuthId: "device", userCode: "CODE" })),
    );
    const { POST } = await import("@/app/api/auth/codex/device-poll/route");
    const res = await POST(
      new NextRequest("http://localhost/api/auth/codex/device-poll", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(await windowOf(user.id)).toEqual({
      retryAt: null,
      failureStreak: 0,
    });
  });

  it("closes every account's windows on the operator's central sign-in", async () => {
    const admin = await prisma.user.create({
      data: {
        username: "central-admin",
        email: "central-admin@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    const member = await prisma.user.create({
      data: {
        username: "central-member",
        email: "central-member@example.test",
        useCentralCodex: true,
      },
    });
    await openWindow(member.id);
    await postgresProviderHealthLedger.recordFailure(
      member.id,
      "admin-codex",
      401,
    );
    signedIn();
    cookieJar.set(
      "central_codex_device",
      encrypt(JSON.stringify({ deviceAuthId: "device", userCode: "CODE" })),
    );
    const { POST } =
      await import("@/app/api/admin/central-codex/device-poll/route");
    const res = await POST(
      new NextRequest("http://localhost/api/admin/central-codex/device-poll", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(await windowOf(member.id)).toEqual({
      retryAt: null,
      failureStreak: 0,
    });
    expect(
      (await postgresProviderHealthLedger.getSkipHints(member.id)).has(
        "admin-codex",
      ),
    ).toBe(false);
  });
});

describe("two refreshes of one Codex token", () => {
  async function codexStatus(userId: string) {
    return (
      await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { codexConnectionStatus: true },
      })
    ).codexConnectionStatus;
  }

  it("share one refresh: the slower caller never parks the winner's sign-in", async () => {
    const user = await seedCodexUser();
    // The issuer honours each refresh token once. The first caller's refresh
    // takes a moment; a second refresh of the same token is refused as reused.
    let asked = 0;
    vi.mocked(refreshDeviceTokens).mockImplementation(async () => {
      asked += 1;
      if (asked > 1) throw new CodexRefreshError(400, "refresh_token_reused");
      await new Promise((resolve) => setTimeout(resolve, 200));
      return creds("rotated", 10 * HOUR_MS);
    });

    const [first, second] = await Promise.all([
      resolveProviderChain(user.id),
      resolveProviderChain(user.id),
    ]);

    expect(first.map((p) => p.providerType)).toContain("codex");
    expect(second.map((p) => p.providerType)).toContain("codex");
    expect(asked).toBe(1);
    expect(await codexStatus(user.id)).toBe("connected");
    expect(parkSignals("codex")).toHaveLength(0);
  });

  it("carries on with the token a peer rotated while the issuer refused the old one", async () => {
    const user = await seedCodexUser();
    // Another process won the race: by the time the issuer answers this
    // caller "reused", the peer's rotated tokens are in the row.
    vi.mocked(refreshDeviceTokens).mockImplementation(async () => {
      const peer = encryptCodexCreds(creds("peer", 10 * HOUR_MS));
      await prisma.user.update({
        where: { id: user.id },
        data: {
          codexAccessTokenEncrypted: peer.accessEncrypted,
          codexRefreshTokenEncrypted: peer.refreshEncrypted,
        },
      });
      throw new CodexRefreshError(400, "refresh_token_reused");
    });

    const chain = await resolveProviderChain(user.id);

    expect(chain.map((p) => p.providerType)).toContain("codex");
    expect(await codexStatus(user.id)).toBe("connected");
    expect(parkSignals("codex")).toHaveLength(0);
  });
});

describe("a Codex refresh under the lock", () => {
  it("parks a sign-in whose every refresh the issuer answers as reused", async () => {
    const user = await seedCodexUser();
    // The issuer revoked the token family: no peer rotated anything, yet each
    // refresh comes back reused.
    vi.mocked(refreshDeviceTokens).mockRejectedValue(
      new CodexRefreshError(400, "refresh_token_reused"),
    );

    const chain = await resolveProviderChain(user.id);

    expect(chain.map((p) => p.providerType)).not.toContain("codex");
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { codexConnectionStatus: true },
        })
      ).codexConnectionStatus,
    ).toBe("expired");
    expect(parkSignals("codex")).toHaveLength(1);
    expect(parkSignals("codex")[0][0].meta?.oauth_error).toBe(
      "refresh_token_reused",
    );
  });

  it("does not use Codex once more when the person disconnected it meanwhile", async () => {
    const user = await seedCodexUser();
    vi.mocked(refreshDeviceTokens).mockImplementation(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          codexAccessTokenEncrypted: null,
          codexRefreshTokenEncrypted: null,
          codexConnectionStatus: "disconnected",
        },
      });
      return creds("rotated", 10 * HOUR_MS);
    });

    const chain = await resolveProviderChain(user.id);

    expect(chain.map((p) => p.providerType)).not.toContain("codex");
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { codexConnectionStatus: true },
        })
      ).codexConnectionStatus,
    ).toBe("disconnected");
  });
});
