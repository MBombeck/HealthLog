/**
 * Account deletion, data wipe and managed-profile deletion wait out a grace
 * window, against real Postgres.
 *
 * Everything here goes through production code: the deletion and wipe
 * routes, the sign-in route, the admin undo route, the restore route and job,
 * the purge job, and the queries background passes enumerate accounts with.
 * Mutations that must turn this red:
 *   - erase in the route again (the account row is gone after the request);
 *   - lock without revoking credentials (the session and token survive);
 *   - drop the pending check from the session resolver (the late session
 *     reads `/api/auth/me`);
 *   - drop the predicate from the off-host cohort or the pregenerate query
 *     (the pending account is enumerated);
 *   - let the wipe delete its own `PRE_WIPE_<ms>` copy (nothing to restore);
 *   - let the purge job erase an account that is not yet due.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const adminNotices = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(
    async (opts: Record<string, unknown>) => {
      adminNotices.push(opts);
    },
  ),
}));

const { hashPassword } = await import("@/lib/auth/password");

const PASSWORD = "Correct horse battery staple!42";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  const prisma = getPrismaClient();
  adminNotices.length = 0;
  await truncateAllTables(prisma);
  await prisma.rateLimit.deleteMany();
  cookieJar.clear();
  headerJar.clear();
  vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "14");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function jsonRequest(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** An account with a password, a small record and a stored weekly copy. */
async function seedAccount(username: string, role = "USER") {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role,
      passwordHash: await hashPassword(PASSWORD),
      onboardingCompletedAt: new Date(),
    },
  });
  await prisma.measurement.createMany({
    data: [0, 1, 2].map((i) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      value: 80 + i,
      unit: "kg",
      measuredAt: new Date(Date.UTC(2026, 8, 1 + i, 7)),
      source: "MANUAL" as const,
    })),
  });
  await prisma.medication.create({
    data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
  });
  await prisma.apiToken.create({
    data: {
      userId: user.id,
      name: "connector",
      tokenHash: `hash-${username}`,
      permissions: ["*"],
    },
  });
  await prisma.dataBackup.create({
    data: { userId: user.id, type: "WEEKLY_AUTO", data: "sealed-copy" },
  });
  return user;
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session.id;
}

async function recordCounts(userId: string) {
  const prisma = getPrismaClient();
  const [measurements, medications, backups] = await Promise.all([
    prisma.measurement.count({ where: { userId } }),
    prisma.medication.count({ where: { userId } }),
    prisma.dataBackup.count({ where: { userId } }),
  ]);
  return { measurements, medications, backups };
}

async function deleteOwnAccount() {
  const { DELETE } = await import("@/app/api/settings/account/route");
  return DELETE(
    jsonRequest("/api/settings/account", "DELETE", {
      confirm: "DELETE_ACCOUNT",
    }),
  );
}

async function passwordLogin(email: string) {
  const { POST } = await import("@/app/api/auth/login/route");
  return POST(
    jsonRequest("/api/auth/login", "POST", { email, password: PASSWORD }),
  );
}

describe("account deletion with a grace window", () => {
  it("locks the account, keeps the record, and an admin's undo gives it back", async () => {
    const prisma = getPrismaClient();
    const user = await seedAccount("leaving");
    const before = await recordCounts(user.id);
    await signIn(user.id);

    const res = await deleteOwnAccount();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { deleted: boolean; scheduledPurgeAt: string | null };
    };
    expect(body.data.deleted).toBe(true);
    const purgeAt = new Date(body.data.scheduledPurgeAt ?? 0);
    expect(purgeAt.getTime() - Date.now()).toBeGreaterThan(13.9 * DAY_MS);
    expect(purgeAt.getTime() - Date.now()).toBeLessThan(14.1 * DAY_MS);

    // Locked: every credential revoked, the record and its copies untouched.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletionRequestedAt).not.toBeNull();
    expect(row.deletionPurgeAt?.toISOString()).toBe(purgeAt.toISOString());
    expect(row.deletionRequestedById).toBe(user.id);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.apiToken.count({
        where: { userId: user.id, revoked: false },
      }),
    ).toBe(0);
    expect(await recordCounts(user.id)).toEqual(before);
    expect(await prisma.offhostPurgeRequest.count()).toBe(0);

    // Sign-in is refused with the date, after the password was proved.
    const refused = await passwordLogin(user.email!);
    expect(refused.status).toBe(403);
    const refusal = (await refused.json()) as {
      meta: { errorCode: string; purgeAt: string };
    };
    expect(refusal.meta.errorCode).toBe("auth.account.deletion_pending");
    expect(refusal.meta.purgeAt).toBe(purgeAt.toISOString());
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    // A wrong password learns nothing about the deletion.
    const { POST } = await import("@/app/api/auth/login/route");
    const wrong = await POST(
      jsonRequest("/api/auth/login", "POST", {
        email: user.email,
        password: "not the password",
      }),
    );
    expect(wrong.status).toBe(401);

    // A session that slipped past the lock is not honoured.
    await signIn(user.id);
    const { GET: me } = await import("@/app/api/auth/me/route");
    expect((await me()).status).toBe(401);

    // An admin undoes it: nothing was changed, so nothing has to come back.
    const admin = await seedAccount("admin", "ADMIN");
    await signIn(admin.id);
    const { POST: undo } =
      await import("@/app/api/admin/users/[id]/undo-deletion/route");
    const undone = await undo(
      jsonRequest(`/api/admin/users/${user.id}/undo-deletion`, "POST"),
      { params: Promise.resolve({ id: user.id }) },
    );
    expect(undone.status).toBe(200);
    const restored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(restored.deletionRequestedAt).toBeNull();
    expect(restored.deletionPurgeAt).toBeNull();
    expect(await recordCounts(user.id)).toEqual(before);
    expect(
      await prisma.auditLog.count({
        where: { action: "admin.user.deletion.undo", userId: admin.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: "user.account.deletion_cancelled", userId: user.id },
      }),
    ).toBe(1);

    // A second undo has nothing to undo.
    const again = await undo(
      jsonRequest(`/api/admin/users/${user.id}/undo-deletion`, "POST"),
      { params: Promise.resolve({ id: user.id }) },
    );
    expect(again.status).toBe(409);

    // And the person signs in again.
    cookieJar.clear();
    expect((await passwordLogin(user.email!)).status).toBe(200);
  });

  it("lists the pending account for admins with its date", async () => {
    const user = await seedAccount("listed");
    await signIn(user.id);
    expect((await deleteOwnAccount()).status).toBe(200);

    const admin = await seedAccount("admin", "ADMIN");
    await signIn(admin.id);
    const { GET } = await import("@/app/api/admin/users/route");
    const res = await GET();
    const { data } = (await res.json()) as {
      data: Array<{ id: string; deletion: unknown }>;
    };
    const row = data.find((u) => u.id === user.id);
    expect(row?.deletion).toMatchObject({ requestedBy: "self" });
    expect(data.find((u) => u.id === admin.id)?.deletion).toBeNull();
  });

  it("keeps background passes away from the pending account", async () => {
    const prisma = getPrismaClient();
    const pending = await seedAccount("pending");
    const active = await seedAccount("active");
    await signIn(pending.id);
    expect((await deleteOwnAccount()).status).toBe(200);
    cookieJar.clear();

    const { readOffhostCohort } =
      await import("@/lib/jobs/offhost-backup-cohort");
    const cohort = await readOffhostCohort(prisma, undefined);
    expect(cohort.users.map((u) => u.id)).toEqual([active.id]);

    const { findPregenerateCandidates } =
      await import("@/lib/jobs/insight-pregenerate");
    const candidates = await findPregenerateCandidates(prisma, new Date(), 50);
    expect(candidates.map((c) => c.id)).toEqual([active.id]);

    // The nightly score jobs: a cross-account `groupBy` the guard used to
    // read as scoped because its `orderBy` names `userId`.
    for (const userId of [pending.id, active.id]) {
      await prisma.measurement.create({
        data: {
          userId,
          type: "HEART_RATE_VARIABILITY",
          value: 48,
          unit: "ms",
          measuredAt: new Date(Date.now() - 3_600_000),
          source: "MANUAL",
        },
      });
    }
    const { findStressScoreCandidates } =
      await import("@/lib/jobs/stress-score");
    expect(await findStressScoreCandidates(prisma, new Date(), 50)).toEqual([
      active.id,
    ]);

    // A job queued for it before the deletion completes without running.
    const { dropJobsOfPendingAccounts } =
      await import("@/lib/jobs/pending-deletion-gate");
    const queued = [
      { id: "j1", data: { userId: pending.id } },
      { id: "j2", data: { userId: active.id } },
    ];
    expect(
      (await dropJobsOfPendingAccounts(queued)).live.map((j) => j.id),
    ).toEqual(["j2"]);

    // Nothing is delivered about or to it, whoever enumerated it.
    const { resolveNotificationDeliveryIdentity } =
      await import("@/lib/notifications/delivery-identity");
    const payload = (userId: string) => ({
      eventType: "MEDICATION_REMINDER" as const,
      userId,
      title: "t",
      message: "m",
    });
    expect(
      await resolveNotificationDeliveryIdentity(payload(pending.id)),
    ).toBeNull();
    expect(
      await resolveNotificationDeliveryIdentity(payload(active.id)),
    ).toMatchObject({ recordUserId: active.id });

    // And no model work is admitted for it.
    const { loadAiCapabilityInputs } =
      await import("@/lib/ai/capabilities/load");
    const { providerWorkAuthorityForRecord } =
      await import("@/lib/sharing/provider-work-authority");
    const inputsFor = (recordId: string) =>
      loadAiCapabilityInputs({
        recordId,
        authority: providerWorkAuthorityForRecord(recordId),
        sections: null,
        recordKind: "self",
      });
    expect((await inputsFor(pending.id))?.providerWorkAdmitted).toBe(false);
    expect((await inputsFor(active.id))?.providerWorkAdmitted).toBe(true);
  });

  it("erases the account when the window ends, and only then", async () => {
    const prisma = getPrismaClient();
    const due = await seedAccount("due");
    const notYet = await seedAccount("not-yet");
    for (const user of [due, notYet]) {
      await signIn(user.id);
      expect((await deleteOwnAccount()).status).toBe(200);
    }
    await prisma.user.update({
      where: { id: due.id },
      data: { deletionPurgeAt: new Date(Date.now() - 60_000) },
    });

    const { processDueAccountDeletions } =
      await import("@/lib/jobs/account-deletion-purge");
    const report = await processDueAccountDeletions(new Date());
    expect(report).toMatchObject({ due: 1, purged: 1, refused: 0 });

    expect(await prisma.user.findUnique({ where: { id: due.id } })).toBeNull();
    expect(await recordCounts(due.id)).toEqual({
      measurements: 0,
      medications: 0,
      backups: 0,
    });
    // The account's own audit history goes with it.
    expect(await prisma.auditLog.count({ where: { userId: due.id } })).toBe(0);

    const kept = await prisma.user.findUnique({ where: { id: notYet.id } });
    expect(kept?.deletionRequestedAt).not.toBeNull();
    expect((await recordCounts(notYet.id)).measurements).toBe(3);
  });

  it("erases at once with no window, as before", async () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "0");
    const prisma = getPrismaClient();
    const user = await seedAccount("immediate");
    await signIn(user.id);

    const res = await deleteOwnAccount();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { scheduledPurgeAt: string | null };
    };
    expect(body.data.scheduledPurgeAt).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect((await recordCounts(user.id)).measurements).toBe(0);
  });

  it("does not let the last admin hide behind another admin pending deletion", async () => {
    const prisma = getPrismaClient();
    const first = await seedAccount("admin-one", "ADMIN");
    const second = await seedAccount("admin-two", "ADMIN");
    await signIn(first.id);
    expect((await deleteOwnAccount()).status).toBe(200);

    await signIn(second.id);
    const res = await deleteOwnAccount();
    expect(res.status).toBe(400);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(row.deletionRequestedAt).toBeNull();
  });
});

describe("an erasure the Guardian invariant refuses", () => {
  it("stays locked and tells every admin once", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAccount("admin", "ADMIN");
    const leaving = await seedAccount("guardian-leaving");
    const staying = await seedAccount("guardian-staying");
    const profile = await prisma.user.create({
      data: {
        username: "managed-kid",
        managedProfileAt: new Date(),
        timezone: "Europe/Berlin",
      },
    });
    for (const guardian of [leaving, staying]) {
      await prisma.accountGrant.create({
        data: {
          grantorId: profile.id,
          granteeId: guardian.id,
          access: "MANAGE",
          acceptedAt: new Date(),
        },
      });
    }

    // Allowed while another guardian holds the profile.
    await signIn(leaving.id);
    expect((await deleteOwnAccount()).status).toBe(200);
    // The other guardian leaves during the window.
    await prisma.accountGrant.updateMany({
      where: { granteeId: staying.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTEE" },
    });
    await prisma.user.update({
      where: { id: leaving.id },
      data: { deletionPurgeAt: new Date(Date.now() - 60_000) },
    });

    const { processDueAccountDeletions } =
      await import("@/lib/jobs/account-deletion-purge");
    expect(await processDueAccountDeletions(new Date())).toMatchObject({
      purged: 0,
      refused: 1,
    });
    // The next hourly run is refused again, and says nothing new.
    expect(await processDueAccountDeletions(new Date())).toMatchObject({
      refused: 1,
    });

    const row = await prisma.user.findUnique({ where: { id: leaving.id } });
    expect(row?.deletionRequestedAt).not.toBeNull();
    expect(adminNotices).toHaveLength(1);
    expect(adminNotices[0]).toMatchObject({
      userId: admin.id,
      titleKey: "notifications.admin.accountErasureRefusedTitle",
      params: { username: "guardian-leaving" },
    });
  });
});

describe("managed-profile deletion with a grace window", () => {
  it("locks the profile away from its Guardian until an admin undoes it", async () => {
    const prisma = getPrismaClient();
    const guardian = await seedAccount("guardian");
    const profile = await prisma.user.create({
      data: {
        username: "managed-child",
        displayName: "Child",
        managedProfileAt: new Date(),
        timezone: "Europe/Berlin",
      },
    });
    await prisma.accountGrant.create({
      data: {
        grantorId: profile.id,
        granteeId: guardian.id,
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
    await prisma.measurement.create({
      data: {
        userId: profile.id,
        type: "WEIGHT",
        value: 21,
        unit: "kg",
        measuredAt: new Date(Date.UTC(2026, 8, 1, 7)),
        source: "MANUAL",
      },
    });

    const { deleteManagedProfile, readManagedProfileForGuardian } =
      await import("@/lib/managed-profiles/lifecycle");
    const { scheduledPurgeAt } = await deleteManagedProfile({
      profileId: profile.id,
      guardianId: guardian.id,
    });
    expect(scheduledPurgeAt).not.toBeNull();

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(row.deletionRequestedById).toBe(guardian.id);
    expect(
      await readManagedProfileForGuardian({
        profileId: profile.id,
        guardianId: guardian.id,
      }),
    ).toBeNull();
    expect(
      await prisma.measurement.count({ where: { userId: profile.id } }),
    ).toBe(1);
    // A second deletion of a profile already pending is refused.
    await expect(
      deleteManagedProfile({ profileId: profile.id, guardianId: guardian.id }),
    ).rejects.toMatchObject({ code: "not_found" });

    const admin = await seedAccount("admin", "ADMIN");
    const { cancelAccountDeletion } =
      await import("@/lib/account-deletion/lifecycle");
    expect(
      await cancelAccountDeletion({ userId: profile.id, adminId: admin.id }),
    ).toBe("cancelled");
    expect(
      await readManagedProfileForGuardian({
        profileId: profile.id,
        guardianId: guardian.id,
      }),
    ).toMatchObject({ id: profile.id });
    expect(
      await prisma.measurement.count({ where: { userId: profile.id } }),
    ).toBe(1);
  });
});

/** A managed profile with the given Guardians, each grant accepted. */
async function profileGuardedBy(username: string, guardianIds: string[]) {
  const prisma = getPrismaClient();
  const profile = await prisma.user.create({
    data: {
      username,
      displayName: "Kid",
      managedProfileAt: new Date(),
      timezone: "Europe/Berlin",
    },
  });
  for (const granteeId of guardianIds) {
    await prisma.accountGrant.create({
      data: {
        grantorId: profile.id,
        granteeId,
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
  }
  return profile;
}

describe("a handover link and a profile pending deletion", () => {
  it("revokes the open link with the deletion and refuses every way to claim the profile", async () => {
    const prisma = getPrismaClient();
    const guardian = await seedAccount("guardian");
    const profile = await profileGuardedBy("managed-teen", [guardian.id]);
    const { createHandover, previewHandover, claimManagedProfile } =
      await import("@/lib/managed-profiles/handover");
    const { deleteManagedProfile } =
      await import("@/lib/managed-profiles/lifecycle");
    const { token } = await createHandover({
      profileId: profile.id,
      guardianId: guardian.id,
      expiresInDays: 7,
      proposals: [],
    });
    expect(await previewHandover(token)).not.toBeNull();

    await deleteManagedProfile({
      profileId: profile.id,
      guardianId: guardian.id,
    });
    const link = await prisma.managedProfileHandover.findFirstOrThrow({
      where: { profileId: profile.id },
    });
    expect(link.revokedAt).not.toBeNull();
    expect(await previewHandover(token)).toBeNull();

    // A link the deletion did not reach (one that was reopened by hand here)
    // is still refused: the claim decides on the profile under its lock.
    await prisma.managedProfileHandover.update({
      where: { id: link.id },
      data: { revokedAt: null },
    });
    expect(await previewHandover(token)).toBeNull();
    await expect(
      claimManagedProfile({
        link: { rawToken: token },
        username: "teen-now-adult",
        email: "teen@example.test",
        passwordHash: "argon2-hash-placeholder",
      }),
    ).rejects.toMatchObject({ name: "HandoverError" });
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(row.managedProfileAt).not.toBeNull();
    expect(row.passwordHash).toBeNull();
  });

  it("revokes the links a Guardian minted when the Guardian deletes their account", async () => {
    const leaving = await seedAccount("guardian-leaving");
    const staying = await seedAccount("guardian-staying");
    const profile = await profileGuardedBy("managed-kid", [
      leaving.id,
      staying.id,
    ]);
    const { createHandover, previewHandover } =
      await import("@/lib/managed-profiles/handover");
    const { token } = await createHandover({
      profileId: profile.id,
      guardianId: leaving.id,
      expiresInDays: 7,
      proposals: [],
    });
    await signIn(leaving.id);
    expect((await deleteOwnAccount()).status).toBe(200);
    expect(await previewHandover(token)).toBeNull();
  });
});

describe("the last-Guardian rule and accounts pending deletion", () => {
  it("lets a Guardian whose only profile is pending deletion delete their own account", async () => {
    const guardian = await seedAccount("guardian");
    const profile = await profileGuardedBy("managed-kid", [guardian.id]);
    const { deleteManagedProfile } =
      await import("@/lib/managed-profiles/lifecycle");
    await deleteManagedProfile({
      profileId: profile.id,
      guardianId: guardian.id,
    });
    await signIn(guardian.id);
    expect((await deleteOwnAccount()).status).toBe(200);
  });

  it("does not let the second of two Guardians leave on the strength of the first, pending deletion", async () => {
    const prisma = getPrismaClient();
    const first = await seedAccount("guardian-first");
    const second = await seedAccount("guardian-second");
    const profile = await profileGuardedBy("managed-kid", [
      first.id,
      second.id,
    ]);
    await signIn(first.id);
    expect((await deleteOwnAccount()).status).toBe(200);
    await signIn(second.id);
    const refused = await deleteOwnAccount();
    expect(refused.status).toBe(409);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: second.id } }))
        .deletionRequestedAt,
    ).toBeNull();

    // Nor through a data wipe, which ends the second Guardian's grant.
    const { protectManagedProfilesDuringDataWipe } =
      await import("@/lib/managed-profiles/lifecycle");
    await expect(
      prisma.$transaction((tx) =>
        protectManagedProfilesDuringDataWipe(tx, second.id),
      ),
    ).rejects.toMatchObject({ name: "LastManagedGuardianError" });
    expect(
      await prisma.accountGrant.count({ where: { grantorId: profile.id } }),
    ).toBe(2);
  });

  it("does not give back a managed profile whose Guardians left during the window", async () => {
    const guardian = await seedAccount("guardian");
    const profile = await profileGuardedBy("managed-kid", [guardian.id]);
    const { deleteManagedProfile } =
      await import("@/lib/managed-profiles/lifecycle");
    await deleteManagedProfile({
      profileId: profile.id,
      guardianId: guardian.id,
    });
    await signIn(guardian.id);
    expect((await deleteOwnAccount()).status).toBe(200);

    const admin = await seedAccount("admin", "ADMIN");
    const { cancelAccountDeletion } =
      await import("@/lib/account-deletion/lifecycle");
    expect(
      await cancelAccountDeletion({ userId: profile.id, adminId: admin.id }),
    ).toBe("no_guardian");
    // The Guardian's own deletion undone first: the profile can come back.
    expect(
      await cancelAccountDeletion({ userId: guardian.id, adminId: admin.id }),
    ).toBe("cancelled");
    expect(
      await cancelAccountDeletion({ userId: profile.id, adminId: admin.id }),
    ).toBe("cancelled");
  });
});

describe("the last admin and admins pending deletion", () => {
  it("does not let the last usable admin step down while another is pending deletion", async () => {
    const prisma = getPrismaClient();
    const first = await seedAccount("admin-one", "ADMIN");
    const second = await seedAccount("admin-two", "ADMIN");
    await signIn(first.id);
    expect((await deleteOwnAccount()).status).toBe(200);

    await signIn(second.id);
    const { PUT } = await import("@/app/api/admin/users/[id]/route");
    const res = await PUT(
      jsonRequest(`/api/admin/users/${second.id}`, "PUT", { role: "USER" }),
      { params: Promise.resolve({ id: second.id }) },
    );
    expect(res.status).toBe(400);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).role,
    ).toBe("ADMIN");
  });
});

describe("delete all data with a grace window", () => {
  it("keeps a copy of the record that an admin can restore", async () => {
    const prisma = getPrismaClient();
    const user = await seedAccount("wiping");
    const before = await recordCounts(user.id);
    await signIn(user.id);

    const { DELETE } = await import("@/app/api/settings/data/route");
    const res = await DELETE(
      jsonRequest("/api/settings/data", "DELETE", { confirm: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { restorableUntil: string | null };
    };
    expect(body.data.restorableUntil).not.toBeNull();

    // The record is gone; the copy taken first is not, and the weekly copy
    // went with the record as before.
    expect((await recordCounts(user.id)).measurements).toBe(0);
    const copies = await prisma.dataBackup.findMany({
      where: { userId: user.id },
      select: { id: true, type: true },
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]!.type).toMatch(/^PRE_WIPE_\d+$/);

    // A second wipe keeps the first copy beside its own.
    const second = await DELETE(
      jsonRequest("/api/settings/data", "DELETE", { confirm: "DELETE" }),
    );
    expect(second.status).toBe(200);
    expect(await prisma.dataBackup.count({ where: { userId: user.id } })).toBe(
      2,
    );

    // The ordinary restore brings the record back from the first copy.
    const admin = await seedAccount("admin", "ADMIN");
    await signIn(admin.id);
    const { POST } = await import("./restore-job-driver");
    const restored = await POST(
      new Request(
        `http://localhost/api/admin/backups/${copies[0]!.id}/restore`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "RESTORE" }),
        },
      ) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: copies[0]!.id }) },
    );
    expect(restored.status).toBe(200);
    const after = await recordCounts(user.id);
    expect(after.measurements).toBe(before.measurements);
    expect(after.medications).toBe(before.medications);

    // When the window ends, the purge job deletes the copies.
    await prisma.dataBackup.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 15 * DAY_MS) },
    });
    const { processDueAccountDeletions } =
      await import("@/lib/jobs/account-deletion-purge");
    const report = await processDueAccountDeletions(new Date());
    expect(report.preWipeCopiesDeleted).toBe(2);
    expect(await prisma.dataBackup.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect((await recordCounts(user.id)).measurements).toBe(
      before.measurements,
    );
  });

  // The off-host purge a wipe asks for is held to the end of the window. A
  // restore of the copy taken for that wipe withdraws it (the account has
  // that record again); a later wipe's purge stays, because the restore does
  // not bring back what the later wipe removed.
  it("withdraws the held off-host purge of the wipe a restore undoes, and only that one", async () => {
    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://bucket.invalid");
    vi.stubEnv("BACKUP_S3_BUCKET", "b");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "a");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "s");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "e".repeat(64));
    const prisma = getPrismaClient();
    const user = await seedAccount("wiping-twice");
    await signIn(user.id);
    const { DELETE } = await import("@/app/api/settings/data/route");
    const wipe = () =>
      DELETE(
        jsonRequest("/api/settings/data", "DELETE", { confirm: "DELETE" }),
      );

    expect((await wipe()).status).toBe(200);
    const [firstCopy] = await prisma.dataBackup.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    const firstRequest = await prisma.offhostPurgeRequest.findFirstOrThrow({
      where: { subjectId: user.id, reason: "data_wiped" },
    });
    expect(firstRequest.notBefore).not.toBeNull();

    // Data that arrives between the wipes, and is wiped by the second one.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 79,
        unit: "kg",
        measuredAt: new Date(),
        source: "MANUAL",
      },
    });
    expect((await wipe()).status).toBe(200);
    const requests = await prisma.offhostPurgeRequest.findMany({
      where: { subjectId: user.id, reason: "data_wiped" },
      orderBy: { requestedAt: "asc" },
    });
    expect(requests).toHaveLength(2);

    const admin = await seedAccount("admin", "ADMIN");
    await signIn(admin.id);
    const { POST } = await import("./restore-job-driver");
    const restored = await POST(
      new Request(
        `http://localhost/api/admin/backups/${firstCopy!.id}/restore`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "RESTORE" }),
        },
      ) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: firstCopy!.id }) },
    );
    expect(restored.status).toBe(200);

    const left = await prisma.offhostPurgeRequest.findMany({
      where: { subjectId: user.id, reason: "data_wiped" },
      select: { id: true },
    });
    expect(left.map((r) => r.id)).toEqual([requests[1]!.id]);
  });

  it("takes no copy with no window, as before", async () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "0");
    const prisma = getPrismaClient();
    const user = await seedAccount("wiping-now");
    await signIn(user.id);
    const { DELETE } = await import("@/app/api/settings/data/route");
    const res = await DELETE(
      jsonRequest("/api/settings/data", "DELETE", { confirm: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { restorableUntil: string | null };
    };
    expect(body.data.restorableUntil).toBeNull();
    expect(await prisma.dataBackup.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });
});
