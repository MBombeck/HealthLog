import { kickOffhostPurge } from "@/lib/jobs/offhost-purge";
import {
  accountDeletionGraceDays,
  accountDeletionPurgeAt,
} from "@/lib/account-deletion/grace";
import {
  eraseAccount,
  lockAccountForDeletion,
} from "@/lib/account-deletion/lifecycle";
import {
  activeGuardianWhere,
  remainingGuardianWhere,
} from "@/lib/managed-profiles/guardian-where";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { releaseUnbackedClientApps } from "@/lib/integrations/oauth-kit/connect-target";
import type { Prisma } from "@/generated/prisma/client";
import { dayKeyAsUtcMidnight, dateOnlyKey } from "@/lib/tz/date-only";
import {
  WIPE_TRANSACTION_MAX_WAIT_MS,
  WIPE_TRANSACTION_TIMEOUT_MS,
} from "@/lib/data-wipe/wipe-plan";

type Transaction = Prisma.TransactionClient;

export { activeGuardianWhere, remainingGuardianWhere };

/**
 * Whether `profileId` keeps a Guardian who is not pending deletion once
 * `leavingGuardianId` (if any) is gone. Call it under the record lock.
 */
async function keepsAGuardian(
  tx: Transaction,
  profileId: string,
  leavingGuardianId: string | null,
): Promise<boolean> {
  const remaining = await tx.accountGrant.count({
    where: {
      grantorId: profileId,
      ...(leavingGuardianId ? { granteeId: { not: leavingGuardianId } } : {}),
      ...remainingGuardianWhere(new Date()),
    },
  });
  return remaining > 0;
}

export type ManagedProfileLifecycleErrorCode =
  "not_found" | "not_managed" | "not_guardian" | "managed_grantee";

export class ManagedProfileLifecycleError extends Error {
  constructor(readonly code: ManagedProfileLifecycleErrorCode) {
    super(`managed profile lifecycle refused: ${code}`);
    this.name = "ManagedProfileLifecycleError";
  }
}

/** A refusal the caller can recover from by adding another Guardian. */
export class LastManagedGuardianError extends Error {
  constructor() {
    super("A managed profile needs another Guardian before this change");
    this.name = "LastManagedGuardianError";
  }
}

/**
 * Serialize lifecycle changes on one managed-record key for the lifetime of
 * the caller's transaction. The lock is held before re-reading the marker and
 * every active Guardian row, so a second reducer sees the first committed
 * change instead of making its decision from a stale count.
 */
export async function withManagedProfileLock<T>(
  tx: Transaction,
  profileId: string,
  operation: (
    profile: {
      id: string;
      managedProfileAt: Date | null;
      deletionRequestedAt: Date | null;
    } | null,
  ) => Promise<T>,
): Promise<T> {
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${`managed-profile:${profileId}`}, 0))
  `;
  const profile = await tx.user.findUnique({
    where: { id: profileId },
    select: { id: true, managedProfileAt: true, deletionRequestedAt: true },
  });
  return operation(profile);
}

/**
 * Run one removal of an active Guardian after holding the record lock and
 * re-reading the invariant in the same transaction.
 */
export async function reduceManagedProfileGuardian<T>(
  tx: Transaction,
  profileId: string,
  leavingGuardianId: string,
  reduction: () => Promise<T>,
): Promise<T> {
  return withManagedProfileLock(tx, profileId, async (profile) => {
    // A profile pending deletion has left every roster; nobody is stranded.
    if (!profile?.managedProfileAt || profile.deletionRequestedAt) {
      return reduction();
    }
    if (!(await keepsAGuardian(tx, profile.id, leavingGuardianId))) {
      throw new LastManagedGuardianError();
    }
    return reduction();
  });
}

/**
 * Budget for a transaction that ends in `user.delete`.
 *
 * Deleting an account row is one statement, but the cascade behind it removes
 * every row the account owns across the whole schema — the same set the data
 * wipe deletes model by model — so its duration grows with the record. Prisma's
 * default interactive-transaction timeout is 5 s; an account with a few years
 * of imported samples blew through it, the transaction rolled back, and the
 * person was answered 500 with nothing deleted, every time they tried.
 *
 * Splitting the delete into batches outside the transaction is not an option:
 * the Guardian invariant is decided under the record lock inside this
 * transaction, and a refusal there must leave the account whole. Batches
 * committed before the refusal would be a partial erasure the person was told
 * did not happen. So the deletion stays atomic and gets the wipe's budget,
 * which was sized for the same work.
 */
export const ACCOUNT_DELETION_TRANSACTION_OPTIONS = {
  timeout: WIPE_TRANSACTION_TIMEOUT_MS,
  maxWait: WIPE_TRANSACTION_MAX_WAIT_MS,
} as const;

/**
 * Keep account deletion and its Guardian checks inside the same transaction.
 * Profiles are locked in id order so an account protecting more than one
 * profile cannot deadlock with a concurrent lifecycle operation.
 *
 * `erasing: false` is the request that only locks the account for a grace
 * window: the Guardian invariant is decided exactly as for an erasure, so a
 * request that could never complete is refused while the person is still
 * there to act on the answer, but the grants stay and so does any provider
 * app a profile borrowed through them. The purge job runs this again with
 * `erasing: true` when the window ends, and the invariant is decided again.
 */
export async function deleteGuardianAccountWithLifecycle<T>(
  guardianId: string,
  deleteAccount: (tx: Transaction) => Promise<T>,
  options: { erasing: boolean } = { erasing: true },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    // A profile already pending deletion is not stranded by this account
    // leaving: it has left every roster and goes at the end of its own
    // window. Counting it refused a Guardian who had just deleted their only
    // profile, with nothing left they could do about it.
    const grants = await tx.accountGrant.findMany({
      where: {
        granteeId: guardianId,
        ...activeGuardianWhere(now),
        grantor: { managedProfileAt: { not: null }, deletionRequestedAt: null },
      },
      select: { grantorId: true },
      distinct: ["grantorId"],
      orderBy: { grantorId: "asc" },
    });

    for (const { grantorId } of grants) {
      await withManagedProfileLock(tx, grantorId, async (profile) => {
        if (!profile?.managedProfileAt || profile.deletionRequestedAt) return;

        const stillActive = await tx.accountGrant.findFirst({
          where: {
            grantorId,
            granteeId: guardianId,
            ...activeGuardianWhere(new Date()),
          },
          select: { id: true },
        });
        if (!stillActive) return;

        // Another Guardian who is not pending deletion must stay. Counted
        // under the record lock, so two Guardians deleting at once cannot
        // each count the other.
        if (!(await keepsAGuardian(tx, grantorId, guardianId))) {
          throw new LastManagedGuardianError();
        }
      });
    }

    const result = await deleteAccount(tx);
    if (!options.erasing) return result;
    // The guardian's grants went with their account; a provider app any of
    // their profiles borrowed from them goes too.
    for (const { grantorId } of grants) {
      await releaseUnbackedClientApps(grantorId, tx);
    }
    return result;
  }, ACCOUNT_DELETION_TRANSACTION_OPTIONS);
}

/**
 * Hold every managed-record lock affected by a data wipe, then prove that the
 * wipe will not leave a managed profile with no active Guardian. The caller
 * keeps the transaction open through the AccountGrant deletion, so a final
 * notification egress claim observes either the live grants before the wipe
 * or the committed deletion afterwards; it cannot authorize in between.
 *
 * A data wipe keeps the account and its managed-profile marker. It therefore
 * refuses rather than silently turning the last Guardian removal into an
 * unmanaged profile. Deleting the managed profile remains the explicit
 * product action for that case.
 */
export async function protectManagedProfilesDuringDataWipe(
  tx: Transaction,
  userId: string,
): Promise<string[]> {
  const affectedProfiles = await tx.accountGrant.findMany({
    where: {
      OR: [{ grantorId: userId }, { granteeId: userId }],
      grantor: { managedProfileAt: { not: null } },
    },
    select: { grantorId: true },
    distinct: ["grantorId"],
    orderBy: { grantorId: "asc" },
  });

  // Acquire every key before reading the final state. Sorting is required
  // because a wipe can affect more than one managed profile.
  for (const { grantorId } of affectedProfiles) {
    await withManagedProfileLock(tx, grantorId, async () => undefined);
  }

  // Re-read after all locks are held. A concurrent acceptance, revocation,
  // expiry reduction, or notification claim uses the same key and is now
  // ordered entirely before or after this transaction.
  const now = new Date();
  for (const { grantorId } of affectedProfiles) {
    await withManagedProfileLock(tx, grantorId, async (profile) => {
      // A profile pending deletion is stranded by nobody (see the deletion
      // above); its grants still go with the wipe, as the caller settles.
      if (!profile?.managedProfileAt || profile.deletionRequestedAt) return;

      // Guardians pending deletion count on neither side.
      const [activeGuardians, guardiansRemovedByWipe] = await Promise.all([
        tx.accountGrant.count({
          where: { grantorId: profile.id, ...remainingGuardianWhere(now) },
        }),
        tx.accountGrant.count({
          where: {
            AND: [
              { grantorId: profile.id },
              { OR: [{ grantorId: userId }, { granteeId: userId }] },
              remainingGuardianWhere(now),
            ],
          },
        }),
      ]);

      if (activeGuardians <= guardiansRemovedByWipe) {
        throw new LastManagedGuardianError();
      }
    });
  }
  // The profiles whose grants the wipe touches, for the caller to settle
  // what those grants carried once they are gone.
  return affectedProfiles.map((p) => p.grantorId);
}

/**
 * Delete a managed profile on a Guardian's word.
 *
 * With a grace window the profile is locked rather than erased (see
 * `lockAccountForDeletion`): it leaves every Guardian's roster, nothing acts
 * for it, and the purge job erases it when the window ends unless an admin
 * undoes it first. Without one (`ACCOUNT_DELETION_GRACE_DAYS=0`) it is
 * erased here, as before. Answers when it will be erased, or null when it
 * already was.
 */
export async function deleteManagedProfile(input: {
  profileId: string;
  guardianId: string;
}): Promise<{ scheduledPurgeAt: Date | null }> {
  const requestedAt = new Date();
  const purgeAt = accountDeletionPurgeAt(
    requestedAt,
    accountDeletionGraceDays(),
  );
  await prisma.$transaction(async (tx) => {
    await withManagedProfileLock(tx, input.profileId, async (profile) => {
      // A profile already pending deletion has left every roster; to its
      // Guardians it is gone, and only an admin can bring it back.
      if (!profile || profile.deletionRequestedAt) {
        throw new ManagedProfileLifecycleError("not_found");
      }
      if (!profile.managedProfileAt) {
        throw new ManagedProfileLifecycleError("not_managed");
      }

      const guardian = await tx.accountGrant.findFirst({
        where: {
          grantorId: profile.id,
          granteeId: input.guardianId,
          ...activeGuardianWhere(new Date()),
        },
        select: { id: true },
      });
      if (!guardian) throw new ManagedProfileLifecycleError("not_guardian");

      await auditLog("managed_profile.deleted", {
        userId: input.guardianId,
        details: {
          profileId: profile.id,
          scheduledPurgeAt: purgeAt?.toISOString() ?? null,
        },
        client: tx,
      });
      if (purgeAt) {
        await lockAccountForDeletion(tx, {
          userId: profile.id,
          requestedById: input.guardianId,
          requestedAt,
          purgeAt,
        });
        return;
      }
      await eraseAccount(tx, profile.id, "managed_profile_deleted");
    });
  }, ACCOUNT_DELETION_TRANSACTION_OPTIONS);
  if (!purgeAt) await kickOffhostPurge();
  return { scheduledPurgeAt: purgeAt };
}

/**
 * One managed record, as its own family publishes it.
 *
 * The same five fields the creation answers with, plus `gender`. It is a view
 * and not the row: a `User` carries credentials, provider connections and the
 * whole health profile, and a Guardian panel needs the record's identity, not
 * its account.
 */
export interface ManagedProfileView {
  id: string;
  displayName: string | null;
  /** ISO `yyyy-MM-dd`, or null. Never synthesised from a year. */
  dateOfBirth: string | null;
  gender: string | null;
  /**
   * The column is nullable and this view says so. Every record this family
   * creates carries one — creation requires it — so null here means a row that
   * predates the requirement or was written by something else, and a client
   * renders its own language for it rather than the string "null".
   */
  locale: string | null;
  timezone: string;
  recordKind: "managed";
}

/** The columns the view is built from, kept in one place for both readers. */
const MANAGED_PROFILE_VIEW_SELECT = {
  id: true,
  displayName: true,
  dateOfBirth: true,
  gender: true,
  locale: true,
  timezone: true,
} as const;

export function toManagedProfileView(row: {
  id: string;
  displayName: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  locale: string | null;
  timezone: string;
}): ManagedProfileView {
  return {
    id: row.id,
    displayName: row.displayName,
    dateOfBirth: row.dateOfBirth ? dateOnlyKey(row.dateOfBirth) : null,
    gender: row.gender,
    locale: row.locale,
    timezone: row.timezone,
    recordKind: "managed",
  };
}

/**
 * The record as it stands, or `null` when the caller may not have it.
 *
 * One `null` for "no such account", "not a managed profile" and "you are not
 * an active Guardian of it", exactly as the roster read answers, so the route
 * above it is not an enumeration oracle.
 *
 * No lock and no transaction, for the same reason the roster takes neither:
 * this guards no invariant. It is the read an edit form fills itself from, and
 * a form filled from a snapshot that moved under it is refused by the write,
 * not by the read.
 */
export async function readManagedProfileForGuardian(input: {
  profileId: string;
  guardianId: string;
  now?: Date;
}): Promise<ManagedProfileView | null> {
  const profile = await prisma.user.findUnique({
    where: { id: input.profileId },
    select: {
      ...MANAGED_PROFILE_VIEW_SELECT,
      managedProfileAt: true,
      deletionRequestedAt: true,
    },
  });
  if (!profile?.managedProfileAt || profile.deletionRequestedAt) return null;

  const guardian = await prisma.accountGrant.findFirst({
    where: {
      grantorId: profile.id,
      granteeId: input.guardianId,
      ...activeGuardianWhere(input.now ?? new Date()),
    },
    select: { id: true },
  });
  if (!guardian) return null;

  return toManagedProfileView(profile);
}

/**
 * The fields a Guardian may change, in the shape the route's schema parses
 * them into — `dateOfBirth` an ISO `yyyy-MM-dd` string rather than a `Date`.
 *
 * The parsed body arrives here and the column assembly happens below, in one
 * place. Doing it at the route and again here would be two statements of which
 * fields are writable, and the second one to be forgotten is the one that
 * matters.
 */
export interface ManagedProfileEdit {
  displayName?: string;
  dateOfBirth?: string | null;
  locale?: string;
  timezone?: string;
  gender?: string | null;
}

/**
 * Change a managed record's identity.
 *
 * Guarded exactly as the deletion beside it is: the same advisory lock, the
 * same managed-profile marker, and the same active-Guardian grant lookup, so
 * the two acts on one record cannot disagree about who may perform them. The
 * lock is not strictly needed to write five columns — it is taken because a
 * concurrent deletion holds it, and an edit that landed between that
 * transaction's guardian check and its `user.delete` would be a write to a row
 * on its way out.
 *
 * The Prisma payload is assembled field by field from the parsed patch — never
 * by spreading it — and the `changed` list the audit row carries is derived
 * from the same object, so the trail names what actually moved rather than
 * what the form rendered.
 */
export async function updateManagedProfile(input: {
  profileId: string;
  guardianId: string;
  patch: ManagedProfileEdit;
}): Promise<ManagedProfileView> {
  return prisma.$transaction(async (tx) => {
    return withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile || profile.deletionRequestedAt) {
        throw new ManagedProfileLifecycleError("not_found");
      }
      if (!profile.managedProfileAt) {
        throw new ManagedProfileLifecycleError("not_managed");
      }

      const guardian = await tx.accountGrant.findFirst({
        where: {
          grantorId: profile.id,
          granteeId: input.guardianId,
          ...activeGuardianWhere(new Date()),
        },
        select: { id: true },
      });
      if (!guardian) throw new ManagedProfileLifecycleError("not_guardian");

      const patch = input.patch;
      const data = {
        ...(patch.displayName !== undefined
          ? { displayName: patch.displayName }
          : {}),
        ...(patch.dateOfBirth !== undefined
          ? {
              dateOfBirth: patch.dateOfBirth
                ? dayKeyAsUtcMidnight(patch.dateOfBirth)
                : null,
            }
          : {}),
        ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
      };

      const updated = await tx.user.update({
        where: { id: profile.id },
        data,
        select: MANAGED_PROFILE_VIEW_SELECT,
      });

      // Filed under the RECORD with the Guardian named as the actor, which is
      // how every other record-scoped change is filed. The record's activity
      // trail is the one an incoming Guardian reads to learn what happened to
      // it, and a row filed under whoever happened to be at the keyboard would
      // leave that trail with a hole in it.
      await auditLog("managed_profile.updated", {
        userId: profile.id,
        actorUserId: input.guardianId,
        details: { changed: Object.keys(data) },
        client: tx,
      });

      return toManagedProfileView(updated);
    });
  });
}

/**
 * Clear the managed-profile marker: the record becomes an ordinary account.
 *
 * v1.42 (#959) — the handover's claim (`handover.ts`) is the one product path
 * that calls this, inside its own transaction and in the same commit that sets
 * the new owner's credentials and settles every Guardian's access. Passing
 * `tx` runs it there; the advisory lock is re-entrant inside one transaction,
 * so the claim, which already holds it, takes it again here at no cost.
 * Without `tx` it opens a transaction of its own, which is what the lifecycle
 * race tests drive it through.
 *
 * Holding the same lock is the point either way: an acceptance, a Guardian
 * removal or a deletion that races the clearing is ordered entirely before or
 * after it.
 */
export async function clearManagedProfileMarker(
  input: { profileId: string },
  tx?: Transaction,
): Promise<void> {
  const clear = (client: Transaction) =>
    withManagedProfileLock(client, input.profileId, async (profile) => {
      if (!profile) throw new ManagedProfileLifecycleError("not_found");
      if (!profile.managedProfileAt) return;
      await client.user.update({
        where: { id: profile.id },
        data: { managedProfileAt: null },
      });
    });
  if (tx) {
    await clear(tx);
    return;
  }
  await prisma.$transaction(clear);
}
