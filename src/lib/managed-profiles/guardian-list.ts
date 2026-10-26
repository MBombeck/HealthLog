import { prisma } from "@/lib/db";
import { activeGuardianWhere } from "@/lib/managed-profiles/lifecycle";
import { grantState } from "@/lib/sharing/grant-access";
import { GRANT_PARTY_SELECT, type GrantParty } from "@/lib/sharing/grant-view";

/**
 * v1.37.0 — who looks after one managed profile.
 *
 * The read the removal route always needed. `DELETE
 * /api/managed-profiles/{id}/guardians/{grantId}` shipped with integration
 * coverage and no caller, because nothing in the product could hand a browser a
 * `grantId` for it: `GET /api/account/grants` returns the CALLER's grants, and
 * a Guardian grant has the PROFILE as grantor, so a Guardian's given-list never
 * contains one.
 *
 * ## What it discloses, and what it deliberately does not
 *
 * `GRANT_PARTY_SELECT` — `{ id, username, displayName }` — and nothing else per
 * Guardian. That is exactly what one party to a grant already sees of another
 * on the sharing panel today, so this route widens nobody's reach; it makes
 * reachable, on the record's own page, a fact the same person can already read
 * one page over. No e-mail, no channel data, no `lastUsedAt`.
 *
 * `access` and `scope` are omitted because they are constants here: a Guardian
 * grant is always `MANAGE` with `scope: null` (`inviteManagedProfileGuardian`),
 * and publishing a constant invites a client to branch on it.
 *
 * ## Why `state` is derived and not read
 *
 * Through `grantState()`, the same function the request resolver's own
 * predicate is built on. A second derivation from `acceptedAt` would drift in
 * the dangerous direction — a roster saying "accepted" about a grant the
 * resolver has stopped honouring, or the reverse — and this roster is what the
 * card counts to decide whether a remove control may exist at all.
 *
 * EXPIRED and REVOKED rows are filtered out rather than published. The question
 * this answers is "who looks after this record NOW"; an ended Guardian grant is
 * history that belongs to the grant panel, not to a floor calculation.
 */
export interface ManagedProfileGuardianView {
  /** The grant row's id — what `DELETE .../guardians/{grantId}` takes. */
  grantId: string;
  account: GrantParty;
  state: "PENDING" | "ACTIVE";
  invitedAt: string;
  acceptedAt: string | null;
}

/** The lifecycle columns this view derives its state from. */
type GuardianGrantRow = {
  id: string;
  invitedAt: Date;
  acceptedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

/**
 * One live Guardian grant, as every surface publishes it.
 *
 * Exported because the invitation route answers with it too. That route used to
 * return the `AccountGrant` row Prisma handed it — `grantorId`, `granteeId`,
 * `scopeJson`, `lastUsedAt` and the rest — which made a table's columns the
 * wire contract of a route nobody had described. One mapper means the roster
 * and the invitation cannot describe a Guardian differently.
 *
 * `null` for a row that is neither PENDING nor ACTIVE, so an ended grant cannot
 * reach a list the last-Guardian floor is counted from. The caller decides what
 * an ended row means for it; here it simply is not a Guardian.
 */
export function toManagedProfileGuardianView(
  grant: GuardianGrantRow,
  account: GrantParty,
  now: Date = new Date(),
): ManagedProfileGuardianView | null {
  const state = grantState(grant, now);
  if (state !== "PENDING" && state !== "ACTIVE") return null;
  return {
    grantId: grant.id,
    account,
    state,
    invitedAt: grant.invitedAt.toISOString(),
    acceptedAt: grant.acceptedAt?.toISOString() ?? null,
  };
}

/**
 * The roster, or `null` when the caller may not have it.
 *
 * One `null` for three different situations — no such account, an account that
 * is not a managed profile, and a profile the caller is not an active Guardian
 * of — so the route answers the same 404 to all three. An adult record whose
 * owner happened to grant somebody MANAGE is not a managed profile and must be
 * indistinguishable from one that does not exist, exactly as it is in
 * `inviteManagedProfileGuardian`.
 *
 * No lock and no transaction. `withManagedProfileLock` exists to serialize
 * lifecycle TRANSITIONS so a reducer decides from a committed count rather than
 * a stale one; taking it for a panel refresh would put an advisory lock on a
 * read that guards no invariant. The roster is a snapshot and is allowed to be
 * one — which is why the last-Guardian refusal stays enforced at the route that
 * changes something, and the card's pre-emptive floor is a courtesy on top of
 * it rather than a replacement for it.
 */
export async function listManagedProfileGuardians(input: {
  profileId: string;
  callerId: string;
  now?: Date;
}): Promise<ManagedProfileGuardianView[] | null> {
  const now = input.now ?? new Date();

  const profile = await prisma.user.findUnique({
    where: { id: input.profileId },
    select: { id: true, managedProfileAt: true },
  });
  if (!profile?.managedProfileAt) return null;

  const caller = await prisma.accountGrant.findFirst({
    where: {
      grantorId: profile.id,
      granteeId: input.callerId,
      ...activeGuardianWhere(now),
    },
    select: { id: true },
  });
  if (!caller) return null;

  const grants = await prisma.accountGrant.findMany({
    where: {
      grantorId: profile.id,
      access: "MANAGE",
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: {
      id: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      invitedAt: true,
      grantee: { select: GRANT_PARTY_SELECT },
    },
    orderBy: { invitedAt: "asc" },
  });

  const roster: ManagedProfileGuardianView[] = [];
  for (const grant of grants) {
    // The `where` above already excludes an ended row, so the mapper's null is
    // the belt on the derivation rather than the filter itself: `grantState` is
    // the authority on what a row IS, and a row it calls ended must not reach a
    // roster the last-Guardian floor is counted from.
    const view = toManagedProfileGuardianView(grant, grant.grantee, now);
    if (view) roster.push(view);
  }
  return roster;
}
