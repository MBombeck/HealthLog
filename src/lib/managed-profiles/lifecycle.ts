import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import type { Prisma } from "@/generated/prisma/client";

type Transaction = Prisma.TransactionClient;

export const activeGuardianWhere = (now: Date) => ({
  access: "MANAGE" as const,
  acceptedAt: { not: null },
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

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
    profile: { id: string; managedProfileAt: Date | null } | null,
  ) => Promise<T>,
): Promise<T> {
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${`managed-profile:${profileId}`}, 0))
  `;
  const profile = await tx.user.findUnique({
    where: { id: profileId },
    select: { id: true, managedProfileAt: true },
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
  reduction: () => Promise<T>,
): Promise<T> {
  return withManagedProfileLock(tx, profileId, async (profile) => {
    if (!profile?.managedProfileAt) return reduction();

    const activeGuardians = await tx.accountGrant.count({
      where: { grantorId: profile.id, ...activeGuardianWhere(new Date()) },
    });
    if (activeGuardians <= 1) throw new LastManagedGuardianError();

    return reduction();
  });
}

/**
 * Keep account deletion and its Guardian checks inside the same transaction.
 * Profiles are locked in id order so an account protecting more than one
 * profile cannot deadlock with a concurrent lifecycle operation.
 */
export async function deleteGuardianAccountWithLifecycle<T>(
  guardianId: string,
  deleteAccount: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const grants = await tx.accountGrant.findMany({
      where: {
        granteeId: guardianId,
        ...activeGuardianWhere(now),
        grantor: { managedProfileAt: { not: null } },
      },
      select: { grantorId: true },
      distinct: ["grantorId"],
      orderBy: { grantorId: "asc" },
    });

    for (const { grantorId } of grants) {
      await withManagedProfileLock(tx, grantorId, async (profile) => {
        if (!profile?.managedProfileAt) return;

        const stillActive = await tx.accountGrant.findFirst({
          where: {
            grantorId,
            granteeId: guardianId,
            ...activeGuardianWhere(new Date()),
          },
          select: { id: true },
        });
        if (!stillActive) return;

        const activeGuardians = await tx.accountGrant.count({
          where: { grantorId, ...activeGuardianWhere(new Date()) },
        });
        if (activeGuardians <= 1) throw new LastManagedGuardianError();
      });
    }

    return deleteAccount(tx);
  });
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
): Promise<void> {
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
      if (!profile?.managedProfileAt) return;

      const [activeGuardians, guardiansRemovedByWipe] = await Promise.all([
        tx.accountGrant.count({
          where: { grantorId: profile.id, ...activeGuardianWhere(now) },
        }),
        tx.accountGrant.count({
          where: {
            AND: [
              { grantorId: profile.id },
              { OR: [{ grantorId: userId }, { granteeId: userId }] },
              activeGuardianWhere(now),
            ],
          },
        }),
      ]);

      if (activeGuardians <= guardiansRemovedByWipe) {
        throw new LastManagedGuardianError();
      }
    });
  }
}

export async function deleteManagedProfile(input: {
  profileId: string;
  guardianId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile) throw new ManagedProfileLifecycleError("not_found");
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
        details: { profileId: profile.id },
        client: tx,
      });
      await tx.user.delete({ where: { id: profile.id } });
    });
  });
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
    dateOfBirth: row.dateOfBirth?.toISOString().slice(0, 10) ?? null,
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
    select: { ...MANAGED_PROFILE_VIEW_SELECT, managedProfileAt: true },
  });
  if (!profile?.managedProfileAt) return null;

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
      if (!profile) throw new ManagedProfileLifecycleError("not_found");
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
                ? new Date(`${patch.dateOfBirth}T00:00:00.000Z`)
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
 * Internal-only future compatibility hook. There is intentionally no route for
 * this state change in the current product; holding the same lock ensures any
 * later handover cannot race a Guardian reduction.
 */
export async function clearManagedProfileMarker(input: {
  profileId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile) throw new ManagedProfileLifecycleError("not_found");
      if (!profile.managedProfileAt) return;
      await tx.user.update({
        where: { id: profile.id },
        data: { managedProfileAt: null },
      });
    });
  });
}
