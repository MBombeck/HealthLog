/**
 * The account grant against real Postgres.
 *
 * Everything asserted here is a property of the DATABASE, which is why none of
 * it is unit-testable: the partial unique index that allows history but not a
 * second live grant, the conditional-update claims that make accept one-shot,
 * and the two cascades. A fake Prisma client that ignored `where` would report
 * every one of them as working.
 *
 * The three lifecycle paths a new persisted table has to join are proven here
 * too, each against the real route rather than against a list that claims the
 * route does it:
 *
 *   1. account deletion — BOTH directions, because a grant naming a user who
 *      no longer exists is a dangling authorization;
 *   2. `DELETE /api/settings/data` — for the owner AND for the delegate, since
 *      a grant belongs to two accounts;
 *   3. `POST /api/admin/backups/[id]/restore` — which must leave grants
 *      exactly as it found them. That third one is an inverse proof and is
 *      deliberate: `AccountGrant` is classified NOT_IN_BACKUP (see
 *      `src/lib/export/backup-plan.ts` for the reasoning), so the property
 *      worth holding is that a restore can neither resurrect a revoked grant
 *      nor be talked into creating one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import {
  GrantError,
  acceptGrant,
  findActiveGrant,
  grantAllows,
  inviteGrant,
  renounceGrant,
  revokeGrant,
  touchGrantUsage,
} from "@/lib/sharing/grants";

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

let counter = 0;

async function makeUser(label: string, role: "USER" | "ADMIN" = "USER") {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `grant-${suffix}`,
      email: `grant-${suffix}@example.test`,
      role,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/** Owner and delegate, with the grant already invited and accepted. */
async function acceptedGrant() {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access: "READ",
    scope: null,
  });
  const grant = await acceptGrant({
    grantId: invited.id,
    granteeId: delegate.id,
  });
  return { owner, delegate, grant };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("account grant lifecycle", () => {
  it("confers nothing until the delegate accepts", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");

    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    expect(invited.acceptedAt).toBeNull();
    expect(invited.access).toBe("READ");
    expect(
      await findActiveGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
      }),
    ).toBeNull();

    const accepted = await acceptGrant({
      grantId: invited.id,
      granteeId: delegate.id,
    });
    expect(accepted.acceptedAt).not.toBeNull();
    // The consent record says who and when, and deliberately not from where.
    // A column re-added and written again would fail here rather than pass
    // unnoticed, which is the point of asserting an absence.
    expect(accepted).not.toHaveProperty("acceptedIp");

    const active = await findActiveGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
    });
    expect(active?.id).toBe(invited.id);
  });

  it("stores the level the invitation offered, and confers it only once accepted", async () => {
    // The column, not the argument: a write grant is the one thing in this
    // feature that lets somebody put data into another person's record, so the
    // proof that WRITE survives the round trip belongs against real Postgres
    // rather than against a client fake.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");

    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "WRITE",
      scope: null,
    });
    const stored = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: invited.id },
    });
    expect(stored.access).toBe("WRITE");
    // Offered is not accepted. Both consents or nothing.
    expect(grantAllows(stored, "write")).toBe(false);

    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const live = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: invited.id },
    });
    expect(grantAllows(live, "write")).toBe(true);
    expect(grantAllows(live, "read")).toBe(true);
  });

  it("refuses an account sharing its record with itself", async () => {
    const solo = await makeUser("solo");
    await expect(
      inviteGrant({
        grantorId: solo.id,
        granteeId: solo.id,
        access: "READ",
        scope: null,
      }),
    ).rejects.toMatchObject({ code: "self_grant" });
    expect(await getPrismaClient().accountGrant.count()).toBe(0);
  });

  it("lets only the named delegate accept, exactly once", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const stranger = await makeUser("stranger");

    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });

    await expect(
      acceptGrant({ grantId: invited.id, granteeId: stranger.id }),
    ).rejects.toMatchObject({ code: "not_grantee" });
    expect(
      (
        await getPrismaClient().accountGrant.findUniqueOrThrow({
          where: { id: invited.id },
        })
      ).acceptedAt,
    ).toBeNull();

    const first = await acceptGrant({
      grantId: invited.id,
      granteeId: delegate.id,
    });
    await expect(
      acceptGrant({
        grantId: invited.id,
        granteeId: delegate.id,
      }),
    ).rejects.toMatchObject({ code: "not_pending" });

    // The second attempt did not re-stamp the acceptance: the consent record
    // still says when the delegate actually agreed.
    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: invited.id },
    });
    expect(row.acceptedAt).toEqual(first.acceptedAt);
  });

  it("cannot accept an invitation that already lapsed", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      acceptGrant({ grantId: invited.id, granteeId: delegate.id }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("stops conferring access the moment the grant expires", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });

    const pair = { grantorId: owner.id, granteeId: delegate.id };
    expect(await findActiveGrant(pair)).not.toBeNull();
    // Nothing swept, nothing changed the row: only the clock the resolver
    // reads moved past the lapse instant.
    expect(
      await findActiveGrant(
        pair,
        getPrismaClient(),
        new Date(Date.now() + 61_000),
      ),
    ).toBeNull();
  });

  it("revokes without deleting, and says who ended it", async () => {
    const { owner, delegate, grant } = await acceptedGrant();

    const revoked = await revokeGrant({
      grantId: grant.id,
      grantorId: owner.id,
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedBy).toBe("GRANTOR");

    // The row is the consent record. It survives, with the acceptance it
    // carried before the revocation intact.
    const row = await getPrismaClient().accountGrant.findUnique({
      where: { id: grant.id },
    });
    expect(row).not.toBeNull();
    expect(row!.acceptedAt).toEqual(grant.acceptedAt);

    expect(
      await findActiveGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
      }),
    ).toBeNull();
  });

  it("records a renouncement as the delegate's act, not the owner's", async () => {
    const { delegate, grant } = await acceptedGrant();

    const renounced = await renounceGrant({
      grantId: grant.id,
      granteeId: delegate.id,
    });
    expect(renounced.revokedBy).toBe("GRANTEE");
    expect(
      await getPrismaClient().accountGrant.count({ where: { id: grant.id } }),
    ).toBe(1);
  });

  it("refuses a revocation from anyone but the parties named", async () => {
    const { owner, delegate, grant } = await acceptedGrant();
    const stranger = await makeUser("stranger");

    await expect(
      revokeGrant({ grantId: grant.id, grantorId: stranger.id }),
    ).rejects.toMatchObject({ code: "not_grantor" });
    await expect(
      renounceGrant({ grantId: grant.id, granteeId: stranger.id }),
    ).rejects.toMatchObject({ code: "not_grantee" });

    // The delegate cannot revoke as the owner, nor the owner renounce as the
    // delegate — the attribution is not a label the caller picks.
    await expect(
      revokeGrant({ grantId: grant.id, grantorId: delegate.id }),
    ).rejects.toMatchObject({ code: "not_grantor" });
    await expect(
      renounceGrant({ grantId: grant.id, granteeId: owner.id }),
    ).rejects.toMatchObject({ code: "not_grantee" });

    expect(
      (
        await getPrismaClient().accountGrant.findUniqueOrThrow({
          where: { id: grant.id },
        })
      ).revokedAt,
    ).toBeNull();
  });

  it("refuses a revocation the record cannot attribute", async () => {
    // The database holds the halves together, because a revoked row with no
    // revoker and a revoker with no revocation are both records that cannot
    // answer the question the table exists to answer. The domain module always
    // writes the pair; this is the floor under it.
    const { grant } = await acceptedGrant();
    const prisma = getPrismaClient();

    await expect(
      prisma.accountGrant.update({
        where: { id: grant.id },
        data: { revokedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.accountGrant.update({
        where: { id: grant.id },
        data: { revokedBy: "GRANTOR" },
      }),
    ).rejects.toThrow();

    const row = await prisma.accountGrant.findUniqueOrThrow({
      where: { id: grant.id },
    });
    expect(row.revokedAt).toBeNull();
    expect(row.revokedBy).toBeNull();
  });

  it("refuses a second live grant for the same pair", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });

    await expect(
      inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "READ",
        scope: null,
      }),
    ).rejects.toBeInstanceOf(GrantError);
    await expect(
      inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "READ",
        scope: null,
      }),
    ).rejects.toMatchObject({ code: "duplicate_live_grant" });
    expect(await getPrismaClient().accountGrant.count()).toBe(1);
  });

  it("re-invites after a revocation as a NEW row, leaving the old one intact", async () => {
    const { owner, delegate, grant } = await acceptedGrant();
    const first = await revokeGrant({
      grantId: grant.id,
      grantorId: owner.id,
    });

    const second = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.acceptedAt).toBeNull();
    expect(second.revokedAt).toBeNull();

    // Two rows for one pair: the ended one and the pending one. This is the
    // whole reason the unique index is partial.
    const all = await getPrismaClient().accountGrant.findMany({
      where: { grantorId: owner.id, granteeId: delegate.id },
      orderBy: { createdAt: "asc" },
    });
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(first.id);
    expect(all[0].revokedAt).toEqual(first.revokedAt);
    expect(all[0].revokedBy).toBe("GRANTOR");

    // And the resolver still answers with the live row only.
    expect(
      await findActiveGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
      }),
    ).toBeNull();
  });

  it("re-invites after a grant EXPIRED, closing the lapsed row instead of colliding", async () => {
    // The bug carrier is the partial unique index `WHERE revoked_at IS NULL`:
    // it cannot read the clock, so an expired-but-never-revoked row keeps
    // occupying the live-pair slot and every re-invitation 409s. A mocked
    // Prisma cannot reproduce this — the index is the thing under test — so it
    // lives here, against real Postgres.
    for (const accepted of [true, false]) {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");

      const first = await inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "READ",
        scope: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      if (accepted) {
        // Acceptance is refused once lapsed, so stamp it directly to build the
        // "accepted then expired" row the report describes.
        await getPrismaClient().accountGrant.update({
          where: { id: first.id },
          data: { acceptedAt: new Date(Date.now() - 2000) },
        });
      }

      // The lapsed row confers nothing already.
      expect(
        await findActiveGrant({ grantorId: owner.id, granteeId: delegate.id }),
      ).toBeNull();

      // Re-inviting the same pair must succeed rather than 409 on the index.
      const second = await inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "READ",
        scope: null,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.revokedAt).toBeNull();

      // History kept, not deleted: the old row is now closed by expiry, and its
      // revoker is stamped so the paired CHECK holds.
      const old = await getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(old.revokedAt).not.toBeNull();
      expect(old.revokedBy).toBe("GRANTOR");

      // Two rows for the pair: the ended one and the fresh one.
      expect(
        await getPrismaClient().accountGrant.count({
          where: { grantorId: owner.id, granteeId: delegate.id },
        }),
      ).toBe(2);

      // And the close is on the audit trail.
      const trail = await getPrismaClient().auditLog.findMany({
        where: { action: "sharing.grant.expired_closed", userId: owner.id },
      });
      expect(trail).toHaveLength(1);
    }
  });

  it("keeps history without limit — a third grant does not collide with two ended ones", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    for (let i = 0; i < 2; i++) {
      const invited = await inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "READ",
        scope: null,
      });
      await revokeGrant({ grantId: invited.id, grantorId: owner.id });
    }
    await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    expect(
      await getPrismaClient().accountGrant.count({
        where: { grantorId: owner.id, granteeId: delegate.id },
      }),
    ).toBe(3);
  });

  it("refuses to end a grant twice", async () => {
    const { owner, grant } = await acceptedGrant();
    await revokeGrant({ grantId: grant.id, grantorId: owner.id });
    await expect(
      revokeGrant({ grantId: grant.id, grantorId: owner.id }),
    ).rejects.toMatchObject({ code: "already_revoked" });
  });

  it("stamps lastUsedAt without failing the caller when the grant is gone", async () => {
    const { grant } = await acceptedGrant();
    await touchGrantUsage(grant.id);
    expect(
      (
        await getPrismaClient().accountGrant.findUniqueOrThrow({
          where: { id: grant.id },
        })
      ).lastUsedAt,
    ).not.toBeNull();

    // Fire-and-forget: a grant deleted between the read and the stamp must not
    // turn a successful request into a failure.
    await expect(touchGrantUsage("no-such-grant")).resolves.toBeUndefined();
  });
});

describe("account grant lifecycle paths", () => {
  it("is removed when EITHER account is deleted", async () => {
    const prisma = getPrismaClient();

    const byOwner = await acceptedGrant();
    await prisma.user.delete({ where: { id: byOwner.owner.id } });
    expect(
      await prisma.accountGrant.count({ where: { id: byOwner.grant.id } }),
      "deleting the owner left an authorization naming a user who no longer exists",
    ).toBe(0);

    const byDelegate = await acceptedGrant();
    await prisma.user.delete({ where: { id: byDelegate.delegate.id } });
    expect(
      await prisma.accountGrant.count({ where: { id: byDelegate.grant.id } }),
      "deleting the delegate left an authorization naming a user who no longer exists",
    ).toBe(0);
  });

  it("is removed by Delete All Data, from either side of the grant", async () => {
    const prisma = getPrismaClient();
    const { DELETE } = await import("@/app/api/settings/data/route");

    const wipe = async (userId: string) => {
      await signIn(userId);
      const response = await DELETE(
        new Request("http://localhost/api/settings/data", {
          method: "DELETE",
          body: JSON.stringify({ confirm: "DELETE" }),
        }) as never,
      );
      expect(response.status).toBe(200);
    };

    // The owner erases their record: the access they handed out goes with it.
    const asOwner = await acceptedGrant();
    await wipe(asOwner.owner.id);
    expect(
      await prisma.accountGrant.count({ where: { id: asOwner.grant.id } }),
      "a delegate still holds read access to an account that erased everything",
    ).toBe(0);

    // The delegate erases their record: the access they hold goes too. Wiping
    // only the grantor side would leave this row behind.
    const asDelegate = await acceptedGrant();
    await wipe(asDelegate.delegate.id);
    expect(
      await prisma.accountGrant.count({ where: { id: asDelegate.grant.id } }),
      "the wipe took only the grants this account made, not the ones it held",
    ).toBe(0);
  });

  it("survives an admin restore untouched, and cannot be created by one", async () => {
    const prisma = getPrismaClient();
    const admin = await makeUser("restore-admin", "ADMIN");

    // The admin is also an owner: one live grant over their record, and one
    // they revoked earlier. A restore must move neither.
    const live = await makeUser("live-delegate");
    const dropped = await makeUser("dropped-delegate");

    const liveInvite = await inviteGrant({
      grantorId: admin.id,
      granteeId: live.id,
      access: "READ",
      scope: null,
    });
    const liveGrant = await acceptGrant({
      grantId: liveInvite.id,
      granteeId: live.id,
    });
    const droppedInvite = await inviteGrant({
      grantorId: admin.id,
      granteeId: dropped.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: droppedInvite.id, granteeId: dropped.id });
    const revoked = await revokeGrant({
      grantId: droppedInvite.id,
      grantorId: admin.id,
    });

    // A payload that carries grants — including one for an account whose
    // access the owner ended. `parseBackupPayload` passes unknown keys
    // through, so this is what a hand-edited or future-shaped file looks like
    // arriving at today's restore.
    const stranger = await makeUser("stranger");
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "ACCOUNT_GRANT_RESTORE_TEST",
        data: encrypt(
          JSON.stringify({
            schemaVersion: "1",
            exportedAt: "2026-08-01T00:00:00.000Z",
            userId: admin.id,
            measurements: [],
            medications: [],
            intakeEvents: [],
            moodEntries: [],
            accountGrants: [
              {
                id: revoked.id,
                grantorId: admin.id,
                granteeId: dropped.id,
                access: "READ",
                acceptedAt: "2026-07-01T00:00:00.000Z",
                revokedAt: null,
                revokedBy: null,
              },
              {
                grantorId: admin.id,
                granteeId: stranger.id,
                access: "WRITE",
                acceptedAt: "2026-07-01T00:00:00.000Z",
              },
            ],
          }),
        ),
      },
    });

    await signIn(admin.id);
    const { POST } = await import("./restore-job-driver");
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    // The revoked grant stayed revoked. This is the failure the exclusion
    // exists to prevent: access the owner ended coming back alive out of a
    // file, with nobody deciding it and nobody told.
    const after = await prisma.accountGrant.findUniqueOrThrow({
      where: { id: revoked.id },
    });
    expect(after.revokedAt).toEqual(revoked.revokedAt);
    expect(after.revokedBy).toBe("GRANTOR");

    // The live grant is neither dropped nor re-stamped.
    const stillLive = await prisma.accountGrant.findUniqueOrThrow({
      where: { id: liveGrant.id },
    });
    expect(stillLive.revokedAt).toBeNull();
    expect(stillLive.acceptedAt).toEqual(liveGrant.acceptedAt);

    // And the payload could not mint one.
    expect(
      await prisma.accountGrant.count({ where: { granteeId: stranger.id } }),
      "a backup file created an authorization over a health record",
    ).toBe(0);
    expect(await prisma.accountGrant.count()).toBe(2);
  });
});
