import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar, queuedSessionIds } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";
import { findActiveGrant } from "@/lib/sharing/grant-access";
import {
  clearManagedProfileMarker,
  ManagedProfileLifecycleError,
} from "@/lib/managed-profiles/lifecycle";

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

async function createFreshMfaUser(label = "guardian") {
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
  return { user, sessionId: session.id };
}

async function signInWithFreshMfa() {
  const { user, sessionId } = await createFreshMfaUser();
  cookieJar.set("healthlog_session", sessionId);
  return user;
}

async function makeAdult(label: string) {
  const suffix = sequence++;
  return getPrismaClient().user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
    },
  });
}

async function createTwoGuardians() {
  const creator = await createFreshMfaUser("creator");
  const secondGuardian = await createFreshMfaUser("second-guardian");
  const { profile, creatorGrant } = await createManagedProfile({
    creatorId: creator.user.id,
    displayName: "Managed profile",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  const invitation = await inviteGrant({
    grantorId: profile.id,
    granteeId: secondGuardian.user.id,
    access: "MANAGE",
    scope: null,
  });
  const secondGrant = await acceptGrant({
    grantId: invitation.id,
    granteeId: secondGuardian.user.id,
  });
  return { creator, secondGuardian, profile, creatorGrant, secondGrant };
}

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/managed-profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  queuedSessionIds.length = 0;
});

afterEach(async () => {
  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS managed_profile_creation_failure ON "account_grants"',
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS fail_managed_profile_creation()",
  );
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS managed_profile_acceptance_failure ON "account_grants"',
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS fail_managed_profile_acceptance()",
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER IF EXISTS managed_profile_delete_audit_failure ON audit_logs",
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS fail_managed_profile_delete_audit()",
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER IF EXISTS managed_guardian_audit_failure ON audit_logs",
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS fail_managed_guardian_audit()",
  );
});

describe("managed profile lifecycle (real Postgres)", () => {
  it("creation records a complete DOB and one accepted non-expiring Guardian grant", async () => {
    const guardian = await signInWithFreshMfa();
    const { POST } = await import("@/app/api/managed-profiles/route");

    const response = await POST(
      createRequest({
        displayName: "Managed profile",
        dateOfBirth: "2012-03-04",
        locale: "de",
        timezone: "Europe/Zurich",
      }),
    );
    expect(response.status).toBe(201);

    const body = await response.json();
    const profile = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: body.data.id },
    });
    expect(profile.username).toMatch(/^managed-/);
    expect(profile.username).not.toContain("Managed profile");
    expect(profile.email).toBeNull();
    expect(profile.passwordHash).toBeNull();
    expect(profile.dateOfBirth?.toISOString().slice(0, 10)).toBe("2012-03-04");
    expect(profile.locale).toBe("de");
    expect(profile.timezone).toBe("Europe/Zurich");
    expect(profile.managedProfileAt).not.toBeNull();

    const grant = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: profile.id, granteeId: guardian.id },
    });
    expect(grant.access).toBe("MANAGE");
    expect(grant.acceptedAt).not.toBeNull();
    expect(grant.expiresAt).toBeNull();
  });

  it("creation accepts an absent DOB without fabricating one", async () => {
    await signInWithFreshMfa();
    const { POST } = await import("@/app/api/managed-profiles/route");

    const response = await POST(
      createRequest({
        displayName: "No birth date",
        locale: "en",
        timezone: "UTC",
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    const profile = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: body.data.id },
    });
    expect(profile.dateOfBirth).toBeNull();
  });

  it("creation rolls the profile back when its Guardian grant fails", async () => {
    await signInWithFreshMfa();
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_managed_profile_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'managed profile grant failure'; END; $$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER managed_profile_creation_failure BEFORE INSERT ON "account_grants" FOR EACH ROW EXECUTE FUNCTION fail_managed_profile_creation()',
    );

    const { POST } = await import("@/app/api/managed-profiles/route");
    const response = await POST(
      createRequest({
        displayName: "Must roll back",
        locale: "en",
        timezone: "UTC",
      }),
    );
    expect(response.status).toBe(500);
    expect(
      await prisma.user.count({
        where: { managedProfileAt: { not: null } },
      }),
    ).toBe(0);
    expect(await prisma.accountGrant.count()).toBe(0);
  });

  it("second Guardian accepts through the ordinary invitation and does not expire", async () => {
    const creator = await signInWithFreshMfa();
    const secondGuardian = await makeAdult("second-guardian");
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const invitationExpiry = new Date(Date.now() + 60 * 60 * 1000);

    const invitation = await inviteGrant({
      grantorId: profile.id,
      granteeId: secondGuardian.id,
      access: "MANAGE",
      scope: null,
      expiresAt: invitationExpiry,
    });
    expect(invitation.acceptedAt).toBeNull();
    expect(invitation.expiresAt).toEqual(invitationExpiry);

    const accepted = await acceptGrant({
      grantId: invitation.id,
      granteeId: secondGuardian.id,
    });
    expect(accepted.acceptedAt).not.toBeNull();
    expect(accepted.expiresAt).toBeNull();
    expect(
      await findActiveGrant(
        { grantorId: profile.id, granteeId: secondGuardian.id },
        getPrismaClient(),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ),
    ).not.toBeNull();
  });

  it("lets a cookie-authenticated Guardian invite and revoke another Guardian", async () => {
    const creator = await createFreshMfaUser("creator");
    const secondGuardian = await createFreshMfaUser("second-guardian");
    cookieJar.set("healthlog_session", creator.sessionId);
    const { profile } = await createManagedProfile({
      creatorId: creator.user.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const invitationExpiry = new Date(Date.now() + 60 * 60 * 1000);

    const { POST: inviteGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/route");
    const invited = await inviteGuardian(
      new NextRequest(
        `http://localhost/api/managed-profiles/${profile.id}/guardians`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identifier: secondGuardian.user.username,
            expiresAt: invitationExpiry.toISOString(),
          }),
        },
      ),
      { params: Promise.resolve({ id: profile.id }) },
    );
    expect(invited.status).toBe(201);
    const invitation = (await invited.json()).data;
    expect(invitation.acceptedAt).toBeNull();
    // The expiry is read off the stored row: the route answers with the entry
    // the roster publishes, and that entry describes who looks after the
    // record rather than the terms of one invitation.
    expect(
      (
        await getPrismaClient().accountGrant.findUniqueOrThrow({
          where: { id: invitation.grantId },
        })
      ).expiresAt?.getTime(),
    ).toBe(invitationExpiry.getTime());

    cookieJar.set("healthlog_session", secondGuardian.sessionId);
    const { POST: acceptInvitation } =
      await import("@/app/api/account/grants/[id]/accept/route");
    const accepted = await acceptInvitation(
      new NextRequest(
        `http://localhost/api/account/grants/${invitation.grantId}/accept`,
        {
          method: "POST",
        },
      ),
      { params: Promise.resolve({ id: invitation.grantId }) },
    );
    expect(accepted.status).toBe(200);
    expect(
      await getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: invitation.grantId },
      }),
    ).toMatchObject({ acceptedAt: expect.any(Date), expiresAt: null });
    await switchSessionTo(secondGuardian.sessionId, profile.id);

    cookieJar.set("healthlog_session", creator.sessionId);
    const { DELETE: revokeGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/[grantId]/route");
    const revoked = await revokeGuardian(
      new NextRequest(
        `http://localhost/api/managed-profiles/${profile.id}/guardians/${invitation.grantId}`,
        { method: "DELETE" },
      ),
      {
        params: Promise.resolve({
          id: profile.id,
          grantId: invitation.grantId,
        }),
      },
    );
    expect(revoked.status).toBe(200);
    expect(
      await getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: invitation.grantId },
      }),
    ).toMatchObject({ revokedBy: "GRANTOR" });
    expect(
      await getPrismaClient().session.findUniqueOrThrow({
        where: { id: secondGuardian.sessionId },
      }),
    ).toMatchObject({ actingAsUserId: null });
    const audit = await getPrismaClient().auditLog.findMany({
      where: {
        userId: profile.id,
        action: {
          in: [
            "managed_profile.guardian.invited",
            "managed_profile.guardian.revoked",
          ],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(audit).toHaveLength(2);
    expect(audit.map((entry) => entry.actorUserId)).toEqual([
      creator.user.id,
      creator.user.id,
    ]);
    expect(audit.map((entry) => JSON.parse(entry.details ?? "{}"))).toEqual([
      { grantId: invitation.grantId },
      { grantId: invitation.grantId },
    ]);
  });

  it("withdraws a pending Guardian invitation without touching the active count and permits re-invitation", async () => {
    const creator = await createFreshMfaUser("creator");
    const secondGuardian = await createFreshMfaUser("second-guardian");
    cookieJar.set("healthlog_session", creator.sessionId);
    const { profile } = await createManagedProfile({
      creatorId: creator.user.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const { POST: inviteGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/route");
    const { DELETE: revokeGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/[grantId]/route");
    const invite = async () => {
      const response = await inviteGuardian(
        new NextRequest(
          `http://localhost/api/managed-profiles/${profile.id}/guardians`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ identifier: secondGuardian.user.username }),
          },
        ),
        { params: Promise.resolve({ id: profile.id }) },
      );
      expect(response.status).toBe(201);
      return (await response.json()).data;
    };

    const pending = await invite();
    const withdrawn = await revokeGuardian(
      new NextRequest(
        `http://localhost/api/managed-profiles/${profile.id}/guardians/${pending.grantId}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: profile.id, grantId: pending.grantId }) },
    );
    expect(withdrawn.status).toBe(200);
    expect(
      await getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: pending.grantId },
      }),
    ).toMatchObject({ acceptedAt: null, revokedAt: expect.any(Date) });

    const replacement = await invite();
    expect(replacement.grantId).not.toBe(pending.grantId);
    expect(replacement.acceptedAt).toBeNull();
  });

  it("refuses a managed profile as a Guardian invitee", async () => {
    const creator = await createFreshMfaUser("creator");
    cookieJar.set("healthlog_session", creator.sessionId);
    const { profile } = await createManagedProfile({
      creatorId: creator.user.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const { profile: managedInvitee } = await createManagedProfile({
      creatorId: creator.user.id,
      displayName: "Another managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const { POST: inviteGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/route");

    const response = await inviteGuardian(
      new NextRequest(
        `http://localhost/api/managed-profiles/${profile.id}/guardians`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identifier: managedInvitee.username }),
        },
      ),
      { params: Promise.resolve({ id: profile.id }) },
    );
    expect(response.status).toBe(422);
    expect(
      await getPrismaClient().accountGrant.count({
        where: { grantorId: profile.id },
      }),
    ).toBe(1);
  });

  it("rolls Guardian invitations back when their audit entry fails", async () => {
    const creator = await createFreshMfaUser("creator");
    const secondGuardian = await createFreshMfaUser("second-guardian");
    cookieJar.set("healthlog_session", creator.sessionId);
    const { profile } = await createManagedProfile({
      creatorId: creator.user.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_managed_guardian_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'managed_profile.guardian.invited' THEN RAISE EXCEPTION 'managed Guardian audit failure'; END IF; RETURN NEW; END; $$",
    );
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER managed_guardian_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_managed_guardian_audit()",
    );
    const { POST: inviteGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/route");

    const response = await inviteGuardian(
      new NextRequest(
        `http://localhost/api/managed-profiles/${profile.id}/guardians`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identifier: secondGuardian.user.username }),
        },
      ),
      { params: Promise.resolve({ id: profile.id }) },
    );
    expect(response.status).toBe(500);
    expect(
      await prisma.accountGrant.count({ where: { grantorId: profile.id } }),
    ).toBe(1);
  });

  it("rolls active Guardian revocation back when its audit entry fails", async () => {
    const { creator, profile, secondGuardian, secondGrant } =
      await createTwoGuardians();
    cookieJar.set("healthlog_session", creator.sessionId);
    await switchSessionTo(secondGuardian.sessionId, profile.id);
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_managed_guardian_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'managed_profile.guardian.revoked' THEN RAISE EXCEPTION 'managed Guardian audit failure'; END IF; RETURN NEW; END; $$",
    );
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER managed_guardian_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_managed_guardian_audit()",
    );
    const { DELETE: revokeGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/[grantId]/route");

    const response = await revokeGuardian(
      new NextRequest(
        `http://localhost/api/managed-profiles/${profile.id}/guardians/${secondGrant.id}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: profile.id, grantId: secondGrant.id }) },
    );
    expect(response.status).toBe(500);
    expect(
      await prisma.accountGrant.findUniqueOrThrow({
        where: { id: secondGrant.id },
      }),
    ).toMatchObject({ revokedAt: null });
    expect(
      await prisma.session.findUniqueOrThrow({
        where: { id: secondGuardian.sessionId },
      }),
    ).toMatchObject({ actingAsUserId: profile.id });
  });

  it("rolls managed Guardian acceptance back when the grant update fails", async () => {
    const creator = await signInWithFreshMfa();
    const secondGuardian = await makeAdult("second-guardian");
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const invitation = await inviteGrant({
      grantorId: profile.id,
      granteeId: secondGuardian.id,
      access: "MANAGE",
      scope: null,
      expiresAt,
    });
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_managed_profile_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL THEN RAISE EXCEPTION 'managed profile acceptance failure'; END IF; RETURN NEW; END; $$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER managed_profile_acceptance_failure BEFORE UPDATE ON "account_grants" FOR EACH ROW EXECUTE FUNCTION fail_managed_profile_acceptance()',
    );

    await expect(
      acceptGrant({ grantId: invitation.id, granteeId: secondGuardian.id }),
    ).rejects.toThrow("managed profile acceptance failure");
    expect(
      await prisma.accountGrant.findUniqueOrThrow({
        where: { id: invitation.id },
      }),
    ).toMatchObject({ acceptedAt: null, expiresAt });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: profile.id } }),
    ).toMatchObject({ managedProfileAt: expect.any(Date) });
  });

  it("serializes Guardian acceptance against marker clearing", async () => {
    const creator = await signInWithFreshMfa();
    const secondGuardian = await makeAdult("second-guardian");
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const invitation = await inviteGrant({
      grantorId: profile.id,
      granteeId: secondGuardian.id,
      access: "MANAGE",
      scope: null,
      expiresAt,
    });

    await Promise.all([
      acceptGrant({ grantId: invitation.id, granteeId: secondGuardian.id }),
      clearManagedProfileMarker({ profileId: profile.id }),
    ]);

    const [profileAfter, grantAfter] = await Promise.all([
      getPrismaClient().user.findUniqueOrThrow({ where: { id: profile.id } }),
      getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: invitation.id },
      }),
    ]);
    expect(profileAfter.managedProfileAt).toBeNull();
    expect(grantAfter.acceptedAt).toEqual(expect.any(Date));
    expect([null, expiresAt.getTime()]).toContain(
      grantAfter.expiresAt?.getTime() ?? null,
    );
  });

  it("refuses to delete a Guardian account when it would leave a managed profile behind", async () => {
    const guardian = await signInWithFreshMfa();
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const { DELETE } = await import("@/app/api/settings/account/route");

    const response = await DELETE(
      new NextRequest("http://localhost/api/settings/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(
      await getPrismaClient().user.findUnique({ where: { id: guardian.id } }),
    ).not.toBeNull();
    expect(
      await getPrismaClient().user.findUnique({ where: { id: profile.id } }),
    ).not.toBeNull();
  });

  it("preserves account, session, and audit rows when last-Guardian deletion is refused", async () => {
    const guardian = await signInWithFreshMfa();
    const prisma = getPrismaClient();
    await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    await prisma.auditLog.create({
      data: { action: "test.before.guardian.refusal", userId: guardian.id },
    });
    const [sessionsBefore, auditsBefore] = await Promise.all([
      prisma.session.count({ where: { userId: guardian.id } }),
      prisma.auditLog.count({ where: { userId: guardian.id } }),
    ]);
    const { DELETE } = await import("@/app/api/settings/account/route");

    const response = await DELETE(
      new NextRequest("http://localhost/api/settings/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
      }),
    );
    expect(response.status).toBe(409);
    await expect(
      Promise.all([
        prisma.session.count({ where: { userId: guardian.id } }),
        prisma.auditLog.count({ where: { userId: guardian.id } }),
        prisma.auditLog.count({
          where: { userId: guardian.id, action: "user.account.delete" },
        }),
      ]),
    ).resolves.toEqual([sessionsBefore, auditsBefore, 0]);
  });

  it("deletes a managed profile through its fresh-MFA Guardian route", async () => {
    const guardian = await signInWithFreshMfa();
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });

    const { DELETE } = await import("@/app/api/managed-profiles/[id]/route");
    const response = await DELETE(
      new NextRequest(`http://localhost/api/managed-profiles/${profile.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: profile.id }) },
    );
    expect(response.status).toBe(200);
    expect(
      await getPrismaClient().user.findUnique({ where: { id: profile.id } }),
    ).toBeNull();
  });

  it("rolls profile deletion back when its audit entry fails", async () => {
    const guardian = await signInWithFreshMfa();
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_managed_profile_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'managed_profile.deleted' THEN RAISE EXCEPTION 'managed profile deletion audit failure'; END IF; RETURN NEW; END; $$",
    );
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER managed_profile_delete_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_managed_profile_delete_audit()",
    );
    const { DELETE } = await import("@/app/api/managed-profiles/[id]/route");

    const response = await DELETE(
      new NextRequest(`http://localhost/api/managed-profiles/${profile.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: profile.id }) },
    );
    expect(response.status).toBe(500);
    expect(
      await prisma.user.findUnique({ where: { id: profile.id } }),
    ).not.toBeNull();
    expect(
      await prisma.accountGrant.count({ where: { grantorId: profile.id } }),
    ).toBe(1);
  });

  it("serializes a Guardian renunciation against that Guardian's account deletion", async () => {
    const { profile, secondGuardian, secondGrant } = await createTwoGuardians();
    const { POST: renounce } =
      await import("@/app/api/account/grants/[id]/renounce/route");
    const { DELETE: deleteAccount } =
      await import("@/app/api/settings/account/route");
    queuedSessionIds.push(
      secondGuardian.sessionId,
      secondGuardian.sessionId,
      secondGuardian.sessionId,
    );

    const [renounced, deleted] = await Promise.all([
      renounce(
        new NextRequest(
          `http://localhost/api/account/grants/${secondGrant.id}/renounce`,
          { method: "POST" },
        ),
        { params: Promise.resolve({ id: secondGrant.id }) },
      ),
      deleteAccount(
        new NextRequest("http://localhost/api/settings/account", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
        }),
      ),
    ]);

    // Either order is a correct serialization: the renunciation lands first
    // (200), or the deletion ends the grant first and the renunciation finds
    // it gone (404) or already ended (409 `sharing.renounce.already_ended`).
    // Which one wins depends only on timing, and the write ceiling charged
    // ahead of the renunciation shifts that timing.
    expect([200, 404, 409]).toContain(renounced.status);
    if (renounced.status === 409) {
      const body = (await renounced.clone().json()) as {
        meta?: { errorCode?: string };
      };
      expect(body.meta?.errorCode).toBe("sharing.renounce.already_ended");
    }
    expect(deleted.status).toBe(200);
    await expect(
      Promise.all([
        getPrismaClient().user.findUnique({
          where: { id: secondGuardian.user.id },
        }),
        getPrismaClient().session.count({
          where: { userId: secondGuardian.user.id },
        }),
        getPrismaClient().accountGrant.count({
          where: {
            grantorId: profile.id,
            access: "MANAGE",
            acceptedAt: { not: null },
            revokedAt: null,
          },
        }),
      ]),
    ).resolves.toEqual([null, 0, 1]);
  });

  it("serializes a Guardian renunciation against managed profile deletion", async () => {
    const { creator, profile, secondGuardian, secondGrant } =
      await createTwoGuardians();
    const { POST: renounce } =
      await import("@/app/api/account/grants/[id]/renounce/route");
    const { DELETE: deleteProfile } =
      await import("@/app/api/managed-profiles/[id]/route");
    queuedSessionIds.push(secondGuardian.sessionId, creator.sessionId);

    const [renounced, deleted] = await Promise.all([
      renounce(
        new NextRequest(
          `http://localhost/api/account/grants/${secondGrant.id}/renounce`,
          { method: "POST" },
        ),
        { params: Promise.resolve({ id: secondGrant.id }) },
      ),
      deleteProfile(
        new NextRequest(`http://localhost/api/managed-profiles/${profile.id}`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id: profile.id }) },
      ),
    ]);

    // Either order is a correct serialization: the renunciation lands first
    // (200), or the deletion ends the grant first and the renunciation finds
    // it gone (404) or already ended (409 `sharing.renounce.already_ended`).
    // Which one wins depends only on timing, and the write ceiling charged
    // ahead of the renunciation shifts that timing.
    expect([200, 404, 409]).toContain(renounced.status);
    if (renounced.status === 409) {
      const body = (await renounced.clone().json()) as {
        meta?: { errorCode?: string };
      };
      expect(body.meta?.errorCode).toBe("sharing.renounce.already_ended");
    }
    expect(deleted.status).toBe(200);
    await expect(
      Promise.all([
        getPrismaClient().user.findUnique({ where: { id: profile.id } }),
        getPrismaClient().accountGrant.count({
          where: { grantorId: profile.id },
        }),
        getPrismaClient().auditLog.count({
          where: {
            userId: creator.user.id,
            action: "managed_profile.deleted",
          },
        }),
      ]),
    ).resolves.toEqual([null, 0, 1]);
  });

  it("serializes a Guardian revocation route against internal marker clearing", async () => {
    const { creator, profile, secondGrant } = await createTwoGuardians();
    const { DELETE: revokeGuardian } =
      await import("@/app/api/managed-profiles/[id]/guardians/[grantId]/route");
    queuedSessionIds.push(creator.sessionId);

    const [revoked] = await Promise.all([
      revokeGuardian(
        new NextRequest(
          `http://localhost/api/managed-profiles/${profile.id}/guardians/${secondGrant.id}`,
          { method: "DELETE" },
        ),
        {
          params: Promise.resolve({ id: profile.id, grantId: secondGrant.id }),
        },
      ),
      clearManagedProfileMarker({ profileId: profile.id }),
    ]);

    expect([200, 404]).toContain(revoked.status);
    const [profileAfter, grantAfter] = await Promise.all([
      getPrismaClient().user.findUniqueOrThrow({ where: { id: profile.id } }),
      getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: secondGrant.id },
      }),
    ]);
    expect(profileAfter.managedProfileAt).toBeNull();
    expect([null, "GRANTOR"]).toContain(grantAfter.revokedBy);
  });

  it("keeps marker clearing internal while stopping managed behavior", async () => {
    const guardian = await signInWithFreshMfa();
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed profile",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });

    await clearManagedProfileMarker({ profileId: profile.id });
    const cleared = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(cleared.managedProfileAt).toBeNull();
    await expect(
      clearManagedProfileMarker({ profileId: "missing-profile" }),
    ).rejects.toBeInstanceOf(ManagedProfileLifecycleError);
  });
});
