/**
 * `ai` on `GET /api/auth/me`, through the real route against real Postgres.
 *
 * The resolver's precedence is proven exhaustively by its unit table. What
 * only this file can prove is the wiring: that the route reads the right
 * columns for the right record, that the switch set, module map, provider
 * presence and consent receipts it hands the resolver come off the rows they
 * should, and that a switched session resolves for the record it is inside
 * with the authority that record allows. Each state below changes one layer
 * against an all-available baseline and asserts the capabilities that layer
 * owns, and that the others stayed available.
 *
 * Mutation check: resolving every record in the route as the caller's own
 * (owner authority, `recordKind: "self"`) turns the delegate and guardian
 * cases red; the other nine stay green, as they should, since they never
 * leave their own record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const ALL = [
  "coach",
  "briefing",
  "periodNarrative",
  "statusText",
  "workoutInsights",
  "reactionLines",
  "aboutMeQuestions",
  "documentAi",
  "labsOcr",
  "medicationExtract",
  // v1.43 — the supplement label photo (needs the nutrients module, on below).
  "supplementLabel",
] as const;
type Key = (typeof ALL)[number];

interface CapabilityState {
  available: boolean;
  reason: string | null;
  onDeviceAllowed: boolean;
}
interface MePayload {
  modules: Record<string, boolean>;
  moduleAccess: Record<string, string>;
  ai: {
    capabilities: Record<Key, CapabilityState>;
    provider: {
      configured: boolean;
      managedBy: string | null;
      canConfigure: boolean;
      responseTimeoutMs: number;
    };
  };
}

let counter = 0;

/** A person with their own Anthropic key and every AI receipt: all available. */
async function makeUser(
  label: string,
  overrides: Record<string, unknown> = {},
) {
  const suffix = `${label}-${counter++}`;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `ai-${suffix}`,
      email: `ai-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      // Presence only: the probe never decrypts, so any value will do.
      aiAnthropicKeyEncrypted: "v1:presence-only",
      // The nutrients module is opt-in; on, so every capability can open.
      modulePreferencesJson: { nutrients: true },
      ...overrides,
    },
  });
  return user;
}

async function grantConsent(userId: string, kind: string) {
  await getPrismaClient().consentReceipt.create({
    data: { userId, kind, artefact: "test", signedAt: new Date() },
  });
}

async function setSwitches(values: Record<string, unknown>) {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...values },
    update: values,
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function readMe(): Promise<MePayload> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: MePayload }).data;
}

/** The capabilities named are closed for `reason`; every other one is open. */
function expectOnly(
  me: MePayload,
  closed: readonly Key[],
  reason: string | null,
) {
  for (const key of ALL) {
    const state = me.ai.capabilities[key];
    if (closed.includes(key)) {
      expect(state, key).toMatchObject({ available: false, reason });
    } else {
      expect(state, key).toEqual({
        available: true,
        reason: null,
        onDeviceAllowed: true,
      });
    }
  }
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
});

describe("GET /api/auth/me — ai", () => {
  it("publishes every capability available on a fully set-up account", async () => {
    const user = await makeUser("baseline");
    await grantConsent(user.id, "ai_full");
    await signIn(user.id);
    const me = await readMe();
    expectOnly(me, [], null);
    expect(me.ai.provider).toEqual({
      configured: true,
      managedBy: "user",
      canConfigure: true,
      responseTimeoutMs: 60_000,
    });
  });

  it("publishes the record's response-timeout setting as the effective timeout", async () => {
    const user = await makeUser("slow-local", {
      aiResponseTimeoutSeconds: 420,
    });
    await grantConsent(user.id, "ai_full");
    await signIn(user.id);
    const me = await readMe();
    expect(me.ai.provider.responseTimeoutMs).toBe(420_000);
  });

  it("closes everything when the operator's master switch is off", async () => {
    const user = await makeUser("master-off");
    await grantConsent(user.id, "ai_full");
    await setSwitches({ assistantEnabled: false });
    await signIn(user.id);
    const me = await readMe();
    expectOnly(me, ALL, "operator_disabled");
    for (const key of ALL) {
      expect(me.ai.capabilities[key].onDeviceAllowed, key).toBe(false);
    }
    expect(me.ai.provider.canConfigure).toBe(false);
  });

  it("closes exactly the reading capabilities when Reading documents is off", async () => {
    const user = await makeUser("documents-off");
    await grantConsent(user.id, "ai_full");
    await setSwitches({ assistantDocumentAiEnabled: false });
    await signIn(user.id);
    expectOnly(
      await readMe(),
      ["documentAi", "labsOcr", "medicationExtract", "supplementLabel"],
      "operator_disabled",
    );
  });

  it("reports no_provider on an account with nothing configured", async () => {
    const user = await makeUser("no-provider", {
      aiProvider: null,
      aiModel: null,
      aiAnthropicKeyEncrypted: null,
    });
    await signIn(user.id);
    const me = await readMe();
    expectOnly(me, ALL, "no_provider");
    for (const key of ALL) {
      // An on-device model does not need the server's provider.
      expect(me.ai.capabilities[key].onDeviceAllowed, key).toBe(true);
    }
    expect(me.ai.provider).toEqual({
      configured: false,
      managedBy: null,
      canConfigure: true,
      responseTimeoutMs: 60_000,
    });
  });

  it("asks for consent before the operator's key, per consent group", async () => {
    const user = await makeUser("operator-key", {
      aiProvider: null,
      aiModel: null,
      aiAnthropicKeyEncrypted: null,
    });
    await setSwitches({
      adminAiKeyEncrypted: "v1:presence-only",
      adminAiModel: "gpt-4o",
    });
    await signIn(user.id);
    expectOnly(await readMe(), ALL, "consent_required");

    // The insights group's receipt opens exactly that group (and the about-me
    // questions, which either group's receipt serves).
    await grantConsent(user.id, "ai_insights_only");
    expectOnly(
      await readMe(),
      [
        "coach",
        "documentAi",
        "labsOcr",
        "medicationExtract",
        "supplementLabel",
      ],
      "consent_required",
    );
  });

  it("reads hiding the Coach as the person's own choice, and nothing more", async () => {
    const user = await makeUser("coach-hidden", { disableCoach: true });
    await grantConsent(user.id, "ai_full");
    await signIn(user.id);
    expectOnly(await readMe(), ["coach"], "user_disabled");
  });

  it("reads the AI analysis opt-out as the person's own choice", async () => {
    const user = await makeUser("insights-off", {
      modulePreferencesJson: { insights: false, nutrients: true },
    });
    await grantConsent(user.id, "ai_full");
    await signIn(user.id);
    expectOnly(
      await readMe(),
      [
        "briefing",
        "periodNarrative",
        "statusText",
        "workoutInsights",
        "reactionLines",
      ],
      "user_disabled",
    );
  });

  it("closes workout notes with the workouts module", async () => {
    const user = await makeUser("workouts-off", {
      modulePreferencesJson: { workouts: false, nutrients: true },
    });
    await grantConsent(user.id, "ai_full");
    await signIn(user.id);
    expectOnly(await readMe(), ["workoutInsights"], "module_disabled");
  });

  it("has one operator Coach switch: availability no longer decides it", async () => {
    const user = await makeUser("coach-switch");
    await grantConsent(user.id, "ai_full");
    // A Coach key left in the availability blob is ignored.
    await setSwitches({ moduleAvailabilityJson: { coach: false } });
    await signIn(user.id);
    let me = await readMe();
    expect(me.modules.coach).toBe(true);
    expect(me.ai.capabilities.coach.available).toBe(true);

    // The switch decides, and the module map follows it.
    await setSwitches({
      moduleAvailabilityJson: null,
      assistantCoachEnabled: false,
    });
    me = await readMe();
    expect(me.modules.coach).toBe(false);
    expect(me.moduleAccess.coach).toBe("unavailable");
    expect(me.ai.capabilities.coach.reason).toBe("operator_disabled");
  });

  it("admits no AI work for a delegate inside somebody else's record", async () => {
    const owner = await makeUser("owner");
    await grantConsent(owner.id, "ai_full");
    const delegate = await makeUser("delegate");
    await getPrismaClient().accountGrant.create({
      data: {
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "READ",
        acceptedAt: new Date(),
      },
    });
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, owner.id);
    const me = await readMe();
    expectOnly(me, ALL, "not_permitted_for_record");
    expect(me.ai.provider).toEqual({
      configured: false,
      managedBy: null,
      canConfigure: false,
      responseTimeoutMs: 60_000,
    });
  });

  it("gives a guardian the operator's key only, and no setup of their own", async () => {
    const guardian = await makeUser("guardian");
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
      gender: null,
    });
    await grantConsent(profile.id, "ai_full");
    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, profile.id);

    // No operator key: the guardian's own Anthropic key does not count here.
    let me = await readMe();
    expect(me.ai.capabilities.briefing.reason).toBe("no_provider");
    expect(me.ai.provider.canConfigure).toBe(false);

    await setSwitches({
      adminAiKeyEncrypted: "v1:presence-only",
      adminAiModel: "gpt-4o",
    });
    me = await readMe();
    expect(me.ai.capabilities.briefing.available).toBe(true);
    expect(me.ai.provider).toEqual({
      configured: true,
      managedBy: "server",
      canConfigure: false,
      responseTimeoutMs: 60_000,
    });
  });
});
