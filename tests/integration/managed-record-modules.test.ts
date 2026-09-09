/**
 * Which record's modules a switched browser reads and writes (#939).
 *
 * Two claims, and neither is provable from one end:
 *
 *   1. a guardian turning a module off for the profile they look after writes
 *      the PROFILE's state, and their own account is untouched — proved
 *      through the real `PATCH /api/record-settings/modules` handler and the
 *      real rows behind it;
 *   2. the payload the browser then gates its navigation on answers for the
 *      RECORD. Before this, `GET /api/auth/me` published the ACTOR's module
 *      map while switched, so the toggle wrote a column nothing on screen was
 *      reading: the guardian turned Cycle off for the child and kept seeing a
 *      Cycle destination in the child's record.
 *
 * `cycle` carries most of the weight because it is the case the issue was
 * opened about and the one the module blob cannot express: it is a DELEGATED
 * module whose user-layer state lives in `CycleProfile.cycleTrackingEnabled`,
 * so `modulePreferencesJson.cycle` is ignored by the gate and refused by the
 * schema. A test that wrote the blob and asserted the blob would have passed
 * against a record whose gate still answered "on".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

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

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `mods-${suffix}`,
      email: `mods-${suffix}@example.test`,
      displayName: `Mods ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      // The guardian tracks cycles themselves. That is the whole point: their
      // own map must not be what the child's record is painted from.
      gender: "FEMALE",
      onboardingCompletedAt: new Date(),
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

interface MePayload {
  modules: Record<string, boolean>;
  cycleTrackingEnabled: boolean;
  accountAccess: { active: { accountId: string } | null };
}

async function readMe(): Promise<MePayload> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: MePayload }).data;
}

async function patchModules(body: unknown) {
  const { PATCH } = await import("@/app/api/record-settings/[family]/route");
  return PATCH(
    new NextRequest("http://localhost/api/record-settings/modules", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ family: "modules" }) },
  );
}

async function readModules() {
  const { GET } = await import("@/app/api/record-settings/[family]/route");
  return GET(
    new NextRequest("http://localhost/api/record-settings/modules", {
      method: "GET",
    }),
    { params: Promise.resolve({ family: "modules" }) },
  );
}

/** A guardian signed in and switched into the profile they look after. */
async function guardianInside(profileGender: string | null = "FEMALE") {
  const guardian = await makeUser("guardian");
  const { createManagedProfile } =
    await import("@/lib/managed-profiles/create");
  const { profile } = await createManagedProfile({
    creatorId: guardian.id,
    displayName: "Managed record",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
    gender: profileGender,
  });
  const session = await signIn(guardian.id);
  await switchSessionTo(session.id, profile.id);
  return { guardian, profile, session };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
});

describe("a guardian turning Cycle off for the record they look after", () => {
  it("writes the record's own cycle profile and leaves their account alone", async () => {
    const { guardian, profile, session } = await guardianInside();

    const response = await patchModules({ cycleTrackingEnabled: false });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.recordId).toBe(profile.id);
    expect(body.data.settings.cycleTrackingEnabled).toBe(false);

    const prisma = getPrismaClient();
    // The delegated module's REAL source, not the module blob — which the
    // gate ignores for this key and the schema refuses.
    const written = await prisma.cycleProfile.findUniqueOrThrow({
      where: { userId: profile.id },
    });
    expect(written.cycleTrackingEnabled).toBe(false);
    expect(
      await prisma.cycleProfile.findUnique({ where: { userId: guardian.id } }),
    ).toBeNull();

    // And the gate agrees, which is the claim that matters.
    const { isModuleEnabled } = await import("@/lib/modules/gate");
    await expect(isModuleEnabled(profile.id, "cycle")).resolves.toBe(false);
    await expect(isModuleEnabled(guardian.id, "cycle")).resolves.toBe(true);

    // The guardian's own account, read as themselves, is what it was.
    await switchSessionTo(session.id, null);
    const own = await readMe();
    expect(own.accountAccess.active).toBeNull();
    expect(own.modules.cycle).toBe(true);
    expect(own.cycleTrackingEnabled).toBe(true);
  });

  it("hides the destination in the record the browser is inside", async () => {
    const { profile } = await guardianInside();

    // Before: the record tracks cycles, because its sex says so.
    const before = await readMe();
    expect(before.accountAccess.active?.accountId).toBe(profile.id);
    expect(before.modules.cycle).toBe(true);

    await patchModules({ cycleTrackingEnabled: false });

    // After: the payload the navigation gates on answers for the RECORD.
    // `visibleNavDestinations` drops an entry whose `requiresModule` key is
    // false, so this is the value that removes the Cycle destination.
    const after = await readMe();
    expect(after.modules.cycle).toBe(false);
    expect(after.cycleTrackingEnabled).toBe(false);

    const { visibleNavDestinations } =
      await import("@/components/layout/nav-model");
    const hrefs = visibleNavDestinations(after.modules, true, true, null).map(
      (destination) => destination.href,
    );
    expect(hrefs).not.toContain("/cycle");
  });

  it("makes the module gate refuse the record's cycle routes", async () => {
    const { profile } = await guardianInside();
    await patchModules({ cycleTrackingEnabled: false });

    const { requireModuleEnabled } = await import("@/lib/modules/gate");
    const gate = await requireModuleEnabled(profile.id, "cycle");
    expect(gate.enabled).toBe(false);
    if (gate.enabled) throw new Error("expected the gate to refuse");
    expect(gate.response.status).toBe(403);
    const refusal = await gate.response.json();
    expect(refusal.meta?.errorCode).toBe("module.disabled");
    expect(refusal.meta?.module).toBe("cycle");
  });
});

describe("a guardian turning a directly-owned module off", () => {
  it("writes the record's preference blob and not their own", async () => {
    const { guardian, profile } = await guardianInside();

    const response = await patchModules({
      modulePreferences: { mood: false },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.settings.modulePreferences.mood).toBe(
      false,
    );

    const { isModuleEnabled } = await import("@/lib/modules/gate");
    await expect(isModuleEnabled(profile.id, "mood")).resolves.toBe(false);
    await expect(isModuleEnabled(guardian.id, "mood")).resolves.toBe(true);

    const switched = await readMe();
    expect(switched.modules.mood).toBe(false);
  });
});

describe("the module map a switched payload publishes", () => {
  it("is byte-identical to the unswitched one when there is no switch", async () => {
    // The do-no-harm claim, and it has to be an equality rather than a spot
    // check: the record scoping is a change to a field every client gates on.
    const user = await makeUser("own");
    await signIn(user.id);

    const payload = await readMe();
    const { resolveModuleMap } = await import("@/lib/modules/gate");
    expect(payload.modules).toEqual(await resolveModuleMap(user.id));
    expect(payload.accountAccess.active).toBeNull();
  });

  it("reads the record's sex rather than the actor's", async () => {
    // No explicit opt-in anywhere: the record simply has a sex the cycle gate
    // derives OFF from, which is the reporter's own suggested fix for a
    // profile created for a child.
    const { profile } = await guardianInside("MALE");

    const payload = await readMe();
    expect(payload.accountAccess.active?.accountId).toBe(profile.id);
    expect(payload.modules.cycle).toBe(false);
    expect(payload.cycleTrackingEnabled).toBe(false);
  });
});

describe("who may write the record's module map", () => {
  it("refuses a delegate whose grant is READ", async () => {
    const guardian = await makeUser("guardian");
    const reader = await makeUser("reader");
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const { acceptGrant, inviteGrant } = await import("@/lib/sharing/grants");
    const grant = await inviteGrant({
      grantorId: profile.id,
      granteeId: reader.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: grant.id, granteeId: reader.id });
    const session = await signIn(reader.id);
    await switchSessionTo(session.id, profile.id);

    const write = await patchModules({ cycleTrackingEnabled: false });
    expect(write.status).toBe(403);

    // Not the read either: the record's configuration is guardian-only, and
    // the refusal is the same at both ends.
    expect((await readModules()).status).toBe(403);

    const prisma = getPrismaClient();
    expect(
      await prisma.cycleProfile.findUnique({ where: { userId: profile.id } }),
    ).toBeNull();
  });

  it("refuses an adult MANAGE delegate on an ordinary record", async () => {
    // A MANAGE grant on an adult's own record is not a route into their
    // account configuration. The guardian fence is about the managed marker,
    // not about the level.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { acceptGrant, inviteGrant } = await import("@/lib/sharing/grants");
    const grant = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: grant.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, owner.id);

    expect((await patchModules({ cycleTrackingEnabled: false })).status).toBe(
      403,
    );
  });
});
