/**
 * Reading and changing a managed record's identity, through the real routes
 * and a real Postgres (#939).
 *
 * The card's controls are proved from a static render in
 * `src/components/settings/access/__tests__/managed-profile-affordances.test.tsx`,
 * which can say a control exists and nothing about what pressing it does. This
 * file is the other half, and it posts the body the CLIENT composes
 * (`managedProfileEditBody`) rather than a hand-written copy of it: a
 * hand-written copy stays green while the form renames a field, and the
 * assembly between the two ends is the part that drops.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";
import { managedProfileEditBody } from "@/lib/queries/use-managed-profiles";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar, queuedSessionIds } =
    await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => {
      const snapshot = new Map(cookieJar);
      const queuedSessionId = queuedSessionIds.shift();
      if (queuedSessionId) {
        snapshot.set("healthlog_session", queuedSessionId);
      }
      return {
        get: (name: string) => {
          const value = snapshot.get(name);
          return value ? { name, value } : undefined;
        },
        set: (name: string, value: string) => {
          cookieJar.set(name, value);
        },
        delete: (name: string) => {
          cookieJar.delete(name);
        },
      };
    }),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let sequence = 0;

interface Person {
  id: string;
  username: string;
  sessionId: string;
}

/** An account with a second factor and a session that has just proved it. */
async function person(label: string): Promise<Person> {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      totpConfirmedAt: new Date(),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  return { id: user.id, username: user.username, sessionId: session.id };
}

function signIn(who: Person): void {
  headerJar.delete("authorization");
  cookieJar.set("healthlog_session", who.sessionId);
}

async function readProfile(profileId: string) {
  const { GET } = await import("@/app/api/managed-profiles/[id]/route");
  return GET(
    new NextRequest(`http://localhost/api/managed-profiles/${profileId}`, {
      method: "GET",
    }),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function patchProfile(profileId: string, body: unknown) {
  const { PATCH } = await import("@/app/api/managed-profiles/[id]/route");
  return PATCH(
    new NextRequest(`http://localhost/api/managed-profiles/${profileId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function guardianAndProfile() {
  const guardian = await person("guardian");
  const { profile } = await createManagedProfile({
    creatorId: guardian.id,
    displayName: "Placeholder",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  return { guardian, profile };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("GET /api/managed-profiles/{id}", () => {
  it("answers a Guardian with the record's own identity", async () => {
    const { guardian, profile } = await guardianAndProfile();
    signIn(guardian);

    const response = await readProfile(profile.id);
    expect(response.status).toBe(200);
    const { data } = await response.json();

    // Asserted with `Object.keys` rather than by presence: a route that
    // over-discloses passes every "contains" assertion ever written about it,
    // and this one answers about an account with no self to consent.
    expect(Object.keys(data).sort()).toEqual([
      "dateOfBirth",
      "displayName",
      "gender",
      "id",
      "locale",
      "recordKind",
      "timezone",
    ]);
    expect(data).toMatchObject({
      id: profile.id,
      displayName: "Placeholder",
      dateOfBirth: null,
      gender: null,
      locale: "en",
      timezone: "UTC",
      recordKind: "managed",
    });
  });

  it("answers somebody who is not a Guardian the unknown-record refusal", async () => {
    const { profile } = await guardianAndProfile();
    const stranger = await person("stranger");
    signIn(stranger);

    const response = await readProfile(profile.id);
    // 404 rather than 403, and deliberately: "no such record" and "not yours"
    // are byte-identical here so the route is not an enumeration oracle.
    expect(response.status).toBe(404);
    expect((await response.json()).meta?.errorCode).toBe(
      "managed_profile.not_found",
    );
  });
});

describe("PATCH /api/managed-profiles/{id}", () => {
  it("changes the name and the timezone a Guardian sends, and audits both", async () => {
    const { guardian, profile } = await guardianAndProfile();
    signIn(guardian);

    const response = await patchProfile(
      profile.id,
      managedProfileEditBody({
        profileId: profile.id,
        displayName: "Robin",
        timezone: "Europe/Berlin",
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      displayName: "Robin",
      timezone: "Europe/Berlin",
      // Untouched by a two-field patch. Absence means "leave it", and a body
      // that always sent five fields would overwrite these with whatever the
      // form last read.
      locale: "en",
      dateOfBirth: null,
      gender: null,
    });

    const prisma = getPrismaClient();
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: profile.id },
      select: { displayName: true, timezone: true, locale: true },
    });
    expect(row).toEqual({
      displayName: "Robin",
      timezone: "Europe/Berlin",
      locale: "en",
    });

    // Filed under the RECORD with the Guardian named as the actor: the
    // record's own trail is what an incoming Guardian reads to learn what
    // happened to it, and it names only what actually moved.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "managed_profile.updated", userId: profile.id },
    });
    expect(audit.actorUserId).toBe(guardian.id);
    expect(
      ((audit.details as { changed?: string[] } | null)?.changed ?? []).sort(),
    ).toEqual(["displayName", "timezone"]);
  });

  it("records the sex a Guardian sets, which is what the cycle module reads", async () => {
    const { guardian, profile } = await guardianAndProfile();
    signIn(guardian);

    const response = await patchProfile(
      profile.id,
      managedProfileEditBody({ profileId: profile.id, gender: "MALE" }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.gender).toBe("MALE");

    // Not a second column and not a mirror: `User.gender` is the one the cycle
    // gate derives from, so the record it was recorded on is the record whose
    // module map answers.
    const { isModuleEnabled } = await import("@/lib/modules/gate");
    await expect(isModuleEnabled(profile.id, "cycle")).resolves.toBe(false);
  });

  it("clears a date of birth on an explicit null and leaves it on an absent key", async () => {
    const { guardian, profile } = await guardianAndProfile();
    signIn(guardian);

    await patchProfile(profile.id, { dateOfBirth: "2015-04-02" });
    const kept = await patchProfile(profile.id, { displayName: "Robin" });
    expect((await kept.json()).data.dateOfBirth).toBe("2015-04-02");

    const cleared = await patchProfile(profile.id, { dateOfBirth: null });
    expect((await cleared.json()).data.dateOfBirth).toBeNull();
  });

  it("refuses a body that names nothing, rather than auditing a change nobody made", async () => {
    const { guardian, profile } = await guardianAndProfile();
    signIn(guardian);

    const response = await patchProfile(profile.id, {});
    expect(response.status).toBe(422);

    const rows = await getPrismaClient().auditLog.count({
      where: { action: "managed_profile.updated" },
    });
    expect(rows).toBe(0);
  });

  it("refuses a field the schema does not name", async () => {
    const { guardian, profile } = await guardianAndProfile();
    signIn(guardian);

    // `.strict()`, so a helpful extra key is a refusal rather than an ignored
    // one. `heightCm` is a real `User` column and the closest thing to a
    // plausible mistake.
    const response = await patchProfile(profile.id, {
      displayName: "Robin",
      heightCm: 120,
    });
    expect(response.status).toBe(422);
  });

  it("refuses somebody who is not a Guardian, and changes nothing", async () => {
    const { profile } = await guardianAndProfile();
    const stranger = await person("stranger");
    signIn(stranger);

    const response = await patchProfile(profile.id, { displayName: "Mine" });
    expect(response.status).toBe(404);
    expect((await response.json()).meta?.errorCode).toBe(
      "managed_profile.not_found",
    );

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: profile.id },
      select: { displayName: true },
    });
    expect(row.displayName).toBe("Placeholder");
  });

  it("refuses an adult MANAGE delegate on an ordinary record", async () => {
    // A MANAGE grant on an adult's own record is not a route into their
    // identity. The same refusal the deletion beside it answers with.
    const owner = await person("owner");
    const delegate = await person("delegate");
    const grant = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: grant.id, granteeId: delegate.id });
    signIn(delegate);

    const response = await patchProfile(owner.id, { displayName: "Mine" });
    expect(response.status).toBe(404);
  });

  it("refuses a session that has not proved a second factor", async () => {
    const { guardian, profile } = await guardianAndProfile();
    const prisma = getPrismaClient();
    await prisma.session.update({
      where: { id: guardian.sessionId },
      data: { mfaVerifiedAt: null },
    });
    signIn(guardian);

    const response = await patchProfile(profile.id, { displayName: "Robin" });
    // The gate creation and deletion carry, unconditionally. The card renders
    // this as "confirm your second factor", not as a failure.
    expect(response.status).toBe(401);
    expect((await response.json()).meta?.errorCode).toBe(
      "auth.stepup.required",
    );
  });

  it("lets a second Guardian edit the record they were invited to", async () => {
    const { guardian, profile } = await guardianAndProfile();
    const second = await person("second");
    const invitation = await inviteGrant({
      grantorId: profile.id,
      granteeId: second.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invitation.id, granteeId: second.id });
    signIn(second);

    const response = await patchProfile(profile.id, { displayName: "Robin" });
    expect(response.status).toBe(200);

    // The creator is not privileged over anybody else who looks after it.
    expect(guardian.id).not.toBe(second.id);
  });
});
