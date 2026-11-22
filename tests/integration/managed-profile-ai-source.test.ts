/**
 * #1403 — a guardian chooses a managed profile's AI provider source, and
 * reads the profile's activity from their own account.
 *
 * Through the real routes and a real Postgres: the `aiSource` record-settings
 * family writes the profile's columns with the caller as the lender, the
 * audit row names the guardian and records only closed facts, the presence
 * probe then serves the guardian's chain for the profile, and the profile's
 * activity feed shows the change to a guardian and to nobody else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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

let counter = 0;

async function makeUser(label: string, data: Record<string, unknown> = {}) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `mas-${suffix}`,
      email: `mas-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      ...data,
    },
  });
}

async function signIn(userId: string) {
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function guardianWithProfile() {
  const guardian = await makeUser("guardian", {
    aiAnthropicKeyEncrypted: encrypt("sk-ant-guardian-integration"),
    aiModel: "claude-sonnet-4-6",
    aiProviderChain: [
      { providerType: "anthropic", priority: 0, enabled: true },
    ],
    aiNamedChains: {
      chains: [{ id: "family", name: "Family", entries: ["anthropic"] }],
      defaultChainId: null,
      attachments: {},
    },
  });
  const { createManagedProfile } =
    await import("@/lib/managed-profiles/create");
  const { profile } = await createManagedProfile({
    creatorId: guardian.id,
    displayName: "Managed record",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  return { guardian, profile };
}

async function aiSource(method: "GET" | "PATCH", body?: unknown) {
  const route = await import("@/app/api/record-settings/[family]/route");
  const { NextRequest } = await import("next/server");
  const handler = route[method] as unknown as (
    r: unknown,
    c: { params: Promise<{ family: string }> },
  ) => Promise<Response>;
  const res = await handler(
    new NextRequest("http://localhost/api/record-settings/aiSource", {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
    { params: Promise.resolve({ family: "aiSource" }) },
  );
  return { status: res.status, body: await res.json() };
}

async function activity(profileId: string) {
  const route = await import("@/app/api/managed-profiles/[id]/activity/route");
  const { NextRequest } = await import("next/server");
  const res = await (
    route.GET as unknown as (
      r: unknown,
      c: { params: Promise<{ id: string }> },
    ) => Promise<Response>
  )(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/activity`,
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
  return { status: res.status, body: await res.json() };
}

async function presenceFor(profileId: string) {
  const { probeProviderChain } = await import("@/lib/ai/provider");
  return probeProviderChain(profileId, {
    origin: "system",
    recordUserId: profileId,
    actorUserId: null,
    grantId: null,
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("aiSource record-settings family", () => {
  it("lends the guardian's named chain to the profile and audits it", async () => {
    const { guardian, profile } = await guardianWithProfile();
    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, profile.id);

    const before = await aiSource("GET");
    expect(before.status).toBe(200);
    expect(before.body.data.settings).toMatchObject({
      source: "INSTANCE",
      chainId: null,
      yourChains: [{ id: "family", name: "Family" }],
    });
    // Before the choice: no operator key, so the profile has no AI.
    expect((await presenceFor(profile.id)).entries).toEqual([]);

    const saved = await aiSource("PATCH", {
      source: "GUARDIAN",
      chainId: "family",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.settings).toMatchObject({
      source: "GUARDIAN",
      chainId: "family",
      servedByYou: true,
      guardianChainUsable: true,
    });

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: profile.id },
      select: {
        managedAiSource: true,
        managedAiGuardianId: true,
        managedAiChainId: true,
      },
    });
    expect(row).toEqual({
      managedAiSource: "GUARDIAN",
      managedAiGuardianId: guardian.id,
      managedAiChainId: "family",
    });

    const audit = await getPrismaClient().auditLog.findFirstOrThrow({
      where: { userId: profile.id, action: "record-settings.aiSource.update" },
    });
    expect(audit.actorUserId).toBe(guardian.id);
    expect(JSON.parse(audit.details ?? "{}")).toEqual({
      changed: ["source"],
      source: "GUARDIAN",
      chain: "named",
    });

    const presence = await presenceFor(profile.id);
    expect(presence.entries.map((e) => e.providerType)).toEqual(["anthropic"]);
  });

  it("refuses a chain the guardian does not have", async () => {
    const { guardian, profile } = await guardianWithProfile();
    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, profile.id);

    const refused = await aiSource("PATCH", {
      source: "GUARDIAN",
      chainId: "nope",
    });
    expect(refused.status).toBe(422);
    expect(refused.body.meta?.errorCode).toBe(
      "record_settings.ai_source.chain_missing",
    );
    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: profile.id },
      select: { managedAiSource: true },
    });
    expect(row.managedAiSource).toBe("INSTANCE");
  });

  it("stops serving the moment the lending guardian loses the profile", async () => {
    const { guardian, profile } = await guardianWithProfile();
    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, profile.id);
    expect(
      (await aiSource("PATCH", { source: "GUARDIAN", chainId: null })).status,
    ).toBe(200);
    expect((await presenceFor(profile.id)).entries).toHaveLength(1);

    await getPrismaClient().accountGrant.updateMany({
      where: { grantorId: profile.id, granteeId: guardian.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });
    expect((await presenceFor(profile.id)).entries).toEqual([]);
  });
});

describe("the guardian's chain and the off switch", () => {
  it("serves a lent cloud chain without a profile receipt, and NONE switches AI off", async () => {
    const { guardian, profile } = await guardianWithProfile();
    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, profile.id);
    const { aiCapabilityForJob } = await import("@/lib/ai/capabilities/gate");

    expect(
      (await aiSource("PATCH", { source: "GUARDIAN", chainId: "family" }))
        .status,
    ).toBe(200);
    // The guardian chose the chain for the profile; that choice is the
    // consent, as `docs/self-hosting/account-sharing.md` says.
    const lent = await aiCapabilityForJob(profile.id, "coach");
    expect(lent.reason).not.toBe("consent_required");
    expect(lent.reason).not.toBe("no_provider");

    // The off switch: no provider, every capability says so.
    expect((await aiSource("PATCH", { source: "NONE" })).status).toBe(200);
    expect((await presenceFor(profile.id)).entries).toEqual([]);
    for (const key of ["coach", "briefing", "documentAi"] as const) {
      expect((await aiCapabilityForJob(profile.id, key)).reason).toBe(
        "no_provider",
      );
    }
  });
});

describe("GET /api/managed-profiles/{id}/activity", () => {
  it("shows a guardian who did what, and refuses anybody else", async () => {
    const { guardian, profile } = await guardianWithProfile();
    const prisma = getPrismaClient();
    await prisma.auditLog.createMany({
      data: [
        {
          userId: profile.id,
          actorUserId: guardian.id,
          action: "measurement.create",
        },
        // Background work has no actor and is not an act by a person.
        { userId: profile.id, actorUserId: null, action: "job.something" },
        // The guardian's own record is not this profile's feed.
        {
          userId: guardian.id,
          actorUserId: guardian.id,
          action: "labResult.create",
        },
      ],
    });

    await signIn(guardian.id);
    const seen = await activity(profile.id);
    expect(seen.status).toBe(200);
    const actions = seen.body.data.entries.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toContain("measurement.create");
    expect(actions).not.toContain("job.something");
    expect(actions).not.toContain("labResult.create");
    const entry = seen.body.data.entries.find(
      (e: { action: string }) => e.action === "measurement.create",
    );
    expect(Object.keys(entry).sort()).toEqual([
      "accesses",
      "action",
      "actor",
      "createdAt",
      "id",
    ]);
    expect(entry.actor.id).toBe(guardian.id);
    expect(typeof seen.body.data.retentionDays).toBe("number");

    const stranger = await makeUser("stranger");
    await signIn(stranger.id);
    const refused = await activity(profile.id);
    expect(refused.status).toBe(404);
    expect(refused.body.meta?.errorCode).toBe("managed_profile.not_found");
  });
});
