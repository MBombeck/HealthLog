/**
 * The account-grant state machine: the transitions here, the predicates they
 * decide by (state, level, scope, the live grant for a pair) in
 * `./grant-access.ts`. Two modules, one set of rules.
 *
 * A grant is one account's standing permission to open another account's
 * record — to read it, and where the grant says so to add to it. The row is
 * also the durable record of the consent that created it (there is no second
 * receipt table — see the model docblock in `prisma/schema.prisma`).
 * Everything that decides what a grant currently MEANS lives in these two
 * modules, and nothing else in the tree is allowed to decide it.
 *
 * Why one place rather than the rules at the call sites: two consumers read
 * these rows for different reasons — the acting-account resolver on every
 * request, and the grant CRUD surface when a person invites, accepts, revokes
 * or renounces. If each carried its own idea of "active", the two would drift,
 * and the drift would be silent in exactly one direction: the resolver
 * admitting a grant the panel shows as ended. The Bearer-token resolver lives
 * in one file for the same reason, and this module is shaped like it.
 * (Naming that function here in prose is what trips the frozen-resolver guard
 * in `src/__tests__/bearer-scope-enforcement-guard.test.ts`, which matches
 * source text and does not exempt comments. Left as it is: a guard over the
 * Bearer perimeter that shouts at a mention is the right direction to be
 * wrong in.)
 *
 * Four properties are the whole point, and each is a decision made HERE and
 * nowhere else:
 *
 *   * **Pending confers nothing.** An invitation is not access. A row with
 *     `acceptedAt IS NULL` fails {@link isGrantActive} — being handed read
 *     access to someone's health record is not something to impose silently.
 *   * **Expiry is live.** The check runs against the clock on the request that
 *     reads the row, not against a sweep that may not have run. A grant a
 *     second past `expiresAt` is already inert.
 *   * **Revocation never deletes.** {@link revokeGrant} and
 *     {@link renounceGrant} stamp `revokedAt` + `revokedBy` on a row that
 *     stays. A deleted row cannot answer "who had access, from when to when,
 *     and who ended it", and that question is the reason the table exists in
 *     the shape it does. Re-inviting the same person mints a NEW row; the
 *     partial unique index in migration 0292 keeps at most one LIVE row per
 *     pair while the history piles up underneath.
 *   * **The level never widens, and neither does the scope.** A row is READ,
 *     WRITE or MANAGE from the moment it is offered, over the sections it
 *     named at that moment, and no transition here raises either. Widening a
 *     grant somebody has already accepted would change what they agreed to
 *     without asking them again, and the delegate's consent is half of what
 *     makes a write grant legitimate. {@link inviteGrant} carries the
 *     reasoning.
 *
 * Every write below is a CONDITIONAL update — the state the transition
 * requires is in the `where`, not in a read the caller performed a moment
 * earlier. Two concurrent accepts therefore cannot both win, and a revoke that
 * lands between a caller's read and its write cannot be overwritten by a
 * transition computed against the stale row.
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { isP2002 } from "@/lib/prisma-errors";
import { clearActingSessions } from "@/lib/sharing/acting-session";
import { releaseUnbackedClientApps } from "@/lib/integrations/oauth-kit/connect-target";
import {
  activeGuardianWhere,
  LastManagedGuardianError,
  ManagedProfileLifecycleError,
  keepsAGuardian,
  reduceManagedProfileGuardian,
  withManagedProfileLock,
} from "@/lib/managed-profiles/lifecycle";
import {
  grantAccessFor,
  type HandoverAccess,
} from "@/lib/managed-profiles/handover-access";
import { isShareDomain } from "@/lib/sharing/scope";
import type { ShareDomain } from "@/lib/sharing/scope";
import { grantState, type GrantDb } from "@/lib/sharing/grant-access";
import { Prisma } from "@/generated/prisma/client";
import type {
  AccountGrant,
  AccountGrantAccess,
} from "@/generated/prisma/client";

export type GrantErrorCode =
  /** An account cannot share its record with itself. */
  | "self_grant"
  /** A live grant for this (owner, delegate) pair already exists. */
  | "duplicate_live_grant"
  /** No grant with that id. */
  | "not_found"
  /** The caller is not the delegate this grant names. */
  | "not_grantee"
  /** The caller is not the owner this grant names. */
  | "not_grantor"
  /** Accept ran against a grant that is not pending (already accepted). */
  | "not_pending"
  /** Accept ran against an invitation that had already lapsed. */
  | "expired"
  /** Revoke or renounce ran against a grant that was already ended. */
  | "already_revoked"
  /**
   * v1.37.0 — the invitation named a scope that cannot mean anything: an
   * empty array, a key outside the vocabulary, or any scope at all on a
   * MANAGE invitation, which is whole-record by construction.
   */
  | "invalid_scope";

/**
 * A refused transition, with a stable code.
 *
 * Codes rather than prose because the two consumers map them to different
 * things — an HTTP status on the CRUD surface, an audit reason in the
 * resolver — and neither should be parsing a sentence.
 */
export class GrantError extends Error {
  constructor(readonly code: GrantErrorCode) {
    super(`account grant refused: ${code}`);
    this.name = "GrantError";
  }
}

// ── Lifecycle transitions ───────────────────────────────────────────────────

export interface InviteGrantInput {
  /** The account whose record is being shared. */
  grantorId: string;
  /** The account being invited to it. */
  granteeId: string;
  /**
   * What the invitation offers. Required, with no default in this module: a
   * level nobody named is a level nobody chose, and the one place an omitted
   * request field becomes READ is the invite schema
   * (`src/lib/validations/account-sharing.ts`). Two defaults agreeing today is
   * how they disagree later.
   */
  access: AccountGrantAccess;
  /**
   * v1.37.0 — which sections the invitation opens. `null` is the entire
   * record, and it is a choice rather than an omission: same no-default
   * posture as `access` above, for the same reason. A scope nobody named is a
   * scope nobody chose, and two modules that both default it are two modules
   * that will disagree about it later.
   *
   * Refused here, as `invalid_scope`: an empty array (a grant that opens
   * nothing is not a grant, it is a mistake wearing one), a key outside the
   * vocabulary, and any scope at all beside MANAGE. The request-shape
   * validator refuses the same three earlier and more legibly; this is the
   * floor under it, because the column's meaning is decided in this file and
   * a caller that never went through a Zod schema must not be able to write a
   * row the resolver would have to interpret.
   */
  scope: ShareDomain[] | null;
  /** Optional lapse date. Null = the grant runs until somebody ends it. */
  expiresAt?: Date | null;
}

/**
 * Offer a grant. The delegate has access only once they accept it.
 *
 * The level is fixed here and never moves. There is no widen, no PATCH, no
 * upgrade endpoint, and the absence is the design rather than a gap: write
 * access needs two consents, the owner's because it is their record and the
 * delegate's because they are being asked to put something into somebody's
 * health record under their own name. Acceptance is the single moment those
 * two meet, and it happens once. Raising a live grant afterwards would carry
 * one consent, and it would not be the delegate's. The way up is a new
 * invitation at the level meant, accepted again — the partial unique index
 * permits it as soon as the old row is ended, and the cost is one revoke and
 * one accept.
 *
 * Self-grants are refused here rather than by a database CHECK — migration
 * 0292 carries the reason (the schema-driven wipe seeder plants a row with
 * grantor = grantee by construction). The refusal is therefore load-bearing:
 * it is the only thing standing between the app and a nonsense row.
 */
export async function inviteGrant(
  input: InviteGrantInput,
  db: GrantDb = prisma,
): Promise<AccountGrant> {
  if (input.grantorId === input.granteeId) {
    throw new GrantError("self_grant");
  }

  const scope = input.scope;
  if (scope !== null) {
    // Whole-record by construction, and the refusal is here rather than in a
    // comment: "they can do anything, but only to part of you" promises a
    // boundary that cannot survive an edit, so the product does not offer it
    // and this file does not store it.
    if (input.access === "MANAGE") throw new GrantError("invalid_scope");
    if (scope.length === 0) throw new GrantError("invalid_scope");
    if (!scope.every(isShareDomain)) throw new GrantError("invalid_scope");
    if (new Set(scope).size !== scope.length) {
      throw new GrantError("invalid_scope");
    }
  }

  const now = new Date();

  // An expired grant confers nothing (see `grantState`), but its row still
  // sits in the live-pair slot the partial unique index guards: the index
  // predicate is `WHERE revoked_at IS NULL` and cannot read the clock. Without
  // ending the lapsed row here, a re-invitation for the same pair after expiry
  // always collides on P2002 and 409s, though the person genuinely has no
  // access anymore. Close it now — conditionally, the expiry state in the
  // WHERE — so "revocation never deletes" still holds and the fresh invitation
  // can mint its row. A live (unexpired) row is not matched, so its P2002 stays
  // correct. `revokedBy` is stamped GRANTOR rather than left null because the
  // paired CHECK (`account_grants_revoked_by_check`) requires revoked_at and
  // revoked_by to be both set or both null and the revoker enum has no expiry
  // member; the owner re-inviting is the actor that ends the lapsed row.
  const closed = await db.accountGrant.updateMany({
    where: {
      grantorId: input.grantorId,
      granteeId: input.granteeId,
      revokedAt: null,
      expiresAt: { lte: now },
    },
    data: { revokedAt: now, revokedBy: "GRANTOR" },
  });
  if (closed.count > 0) {
    // Keep "who had access, from when to when, and who ended it" answering
    // truthfully: the lapsed row ended by its own expiry, closed on re-invite.
    await auditLog("sharing.grant.expired_closed", {
      userId: input.grantorId,
      details: {
        granteeId: input.granteeId,
        closedCount: closed.count,
        reason: "expired",
      },
      client: db,
    }).catch(() => {});
  }

  try {
    return await db.accountGrant.create({
      data: {
        grantorId: input.grantorId,
        granteeId: input.granteeId,
        access: input.access,
        // `DbNull` and not `null`: on a nullable Json column Prisma reads a
        // bare `null` as the JSON value `null`, which is a stored blob that
        // is not an array and would resolve through `normaliseScope` to the
        // empty set — a grant that opens nothing, written by the path meant
        // to open everything. The two nulls are one keystroke apart and mean
        // opposite things here.
        //
        scopeJson: scope === null ? Prisma.DbNull : scope,
        invitedAt: now,
        expiresAt: input.expiresAt ?? null,
      },
    });
  } catch (err) {
    // The partial unique index is what refuses a second live grant for the
    // pair; a revoked row never collides, so a re-invitation after revocation
    // lands as a new row and the old one keeps its history.
    if (isP2002(err)) throw new GrantError("duplicate_live_grant");
    throw err;
  }
}

export interface AcceptGrantInput {
  grantId: string;
  /** Taken from the authenticated session — never from a request body. */
  granteeId: string;
}

/**
 * Accept an invitation. Delegate-only, one-shot.
 *
 * The claim is the `where` clause: `acceptedAt: null` means two concurrent
 * accepts cannot both update a row, and a grant the owner revoked in the
 * meantime cannot be accepted at all. On a miss the row is read back once to
 * say WHY, which is a diagnosis and never a second chance.
 */
export async function acceptGrant(
  input: AcceptGrantInput,
): Promise<AccountGrant> {
  return prisma.$transaction((tx) => acceptGrantInTransaction(input, tx));
}

async function acceptGrantInTransaction(
  input: AcceptGrantInput,
  tx: Prisma.TransactionClient,
): Promise<AccountGrant> {
  const candidate = await tx.accountGrant.findUnique({
    where: { id: input.grantId },
    select: { grantorId: true, access: true },
  });
  if (!candidate) {
    throw await refusalFor(input.grantId, { granteeId: input.granteeId }, tx);
  }

  const accept = async (managedProfile: boolean) => {
    const now = new Date();
    const { count } = await tx.accountGrant.updateMany({
      where: {
        id: input.grantId,
        granteeId: input.granteeId,
        acceptedAt: null,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        acceptedAt: now,
        ...(managedProfile ? { expiresAt: null } : {}),
      },
    });
    if (count === 0) {
      throw await refusalFor(input.grantId, { granteeId: input.granteeId }, tx);
    }
    return tx.accountGrant.findUniqueOrThrow({ where: { id: input.grantId } });
  };

  if (candidate.access !== "MANAGE") return accept(false);

  return withManagedProfileLock(tx, candidate.grantorId, async (profile) =>
    accept(Boolean(profile?.managedProfileAt)),
  );
}

export async function inviteManagedProfileGuardian(input: {
  profileId: string;
  guardianId: string;
  granteeId: string;
  expiresAt?: Date | null;
}): Promise<AccountGrant> {
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
      const grantee = await tx.user.findUnique({
        where: { id: input.granteeId },
        select: { managedProfileAt: true },
      });
      if (grantee?.managedProfileAt) {
        throw new ManagedProfileLifecycleError("managed_grantee");
      }
      const grant = await inviteGrant(
        {
          grantorId: profile.id,
          granteeId: input.granteeId,
          access: "MANAGE",
          scope: null,
          expiresAt: input.expiresAt ?? null,
        },
        tx,
      );
      await auditLog("managed_profile.guardian.invited", {
        userId: profile.id,
        actorUserId: input.guardianId,
        details: { grantId: grant.id },
        client: tx,
      });
      return grant;
    });
  });
}

export async function revokeManagedProfileGuardian(input: {
  profileId: string;
  guardianId: string;
  grantId: string;
}): Promise<AccountGrant> {
  return prisma.$transaction(async (tx) => {
    return withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile) throw new ManagedProfileLifecycleError("not_found");
      if (!profile.managedProfileAt) {
        throw new ManagedProfileLifecycleError("not_managed");
      }
      const requester = await tx.accountGrant.findFirst({
        where: {
          grantorId: profile.id,
          granteeId: input.guardianId,
          ...activeGuardianWhere(new Date()),
        },
        select: { id: true },
      });
      if (!requester) throw new ManagedProfileLifecycleError("not_guardian");

      const target = await tx.accountGrant.findFirst({
        where: {
          id: input.grantId,
          grantorId: profile.id,
          access: "MANAGE",
          revokedAt: null,
        },
        select: {
          id: true,
          granteeId: true,
          acceptedAt: true,
          expiresAt: true,
        },
      });
      if (!target) throw new ManagedProfileLifecycleError("not_guardian");
      if (target.granteeId === input.guardianId) {
        throw new ManagedProfileLifecycleError("not_guardian");
      }

      const now = new Date();
      const targetIsActive =
        target.acceptedAt !== null &&
        (target.expiresAt === null || target.expiresAt > now);
      const leaves = targetIsActive ? target.granteeId : null;
      if (leaves && !(await keepsAGuardian(tx, profile.id, leaves))) {
        throw new LastManagedGuardianError();
      }

      await tx.accountGrant.update({
        where: { id: target.id },
        // `revokedBy` records which grant party withdrew access. The managed
        // profile is the grantor; the individual Guardian is durable audit
        // attribution below rather than an overloaded enum value.
        data: { revokedAt: now, revokedBy: "GRANTOR" },
      });
      await clearActingSessions(
        { grantorId: profile.id, granteeId: target.granteeId },
        tx,
      );
      // A provider app the profile borrowed from this guardian goes with them.
      await releaseUnbackedClientApps(profile.id, tx);
      // v1.42 (#959) — a handover link the removed Guardian minted dies with
      // their access. The claim refuses it anyway (its creator must still be
      // an active Guardian); withdrawing it here keeps the other Guardians'
      // panel from showing a link that can no longer be used.
      await tx.managedProfileHandover.updateMany({
        where: {
          profileId: profile.id,
          createdById: target.granteeId,
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await auditLog("managed_profile.guardian.revoked", {
        userId: profile.id,
        actorUserId: input.guardianId,
        details: { grantId: target.id },
        client: tx,
      });
      return tx.accountGrant.findUniqueOrThrow({ where: { id: target.id } });
    });
  });
}

// ── Handover (v1.42, #959) ──────────────────────────────────────────────────

/**
 * Withdraw every invitation the record has offered and nobody has accepted.
 *
 * Called when a managed profile is claimed. A pending MANAGE invitation on a
 * managed profile is a Guardian invitation; once the record belongs to an
 * adult, `acceptGrant` would still accept it, and the invitee would become a
 * MANAGE delegate of a person who never agreed to them. Withdrawing every
 * pending row the record has offered closes that, and nothing else is lost:
 * the new owner invites whoever they want themselves.
 *
 * `revokedBy = GRANTOR` because the record's owner is the party ending them.
 * Must run inside the caller's transaction and under the managed-profile lock,
 * which is what orders it against a concurrent acceptance.
 */
export async function withdrawPendingGrantsOfRecord(
  tx: Prisma.TransactionClient,
  recordId: string,
  now: Date,
): Promise<number> {
  const { count } = await tx.accountGrant.updateMany({
    where: { grantorId: recordId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now, revokedBy: "GRANTOR" },
  });
  return count;
}

/** What settling one Guardian's access did. */
export interface HandoverGrantSettlement {
  /** The level the Guardian now holds. */
  access: HandoverAccess;
  /** The live grant afterwards, or null when access ended. */
  grantId: string | null;
  /** Whether a row was ended or written. */
  changed: boolean;
  /** How many of the Guardian's browser sessions were inside the record. */
  sessionsCleared: number;
}

/**
 * Set one former Guardian's access to a managed profile that is being, or has
 * just been, handed over. The one place a handover moves a grant.
 *
 * The rules of WHICH level to set live in `handover-access.ts`; this is the
 * mechanics, and it follows the state machine above:
 *
 *   - the level a row carries never moves. Changing it ends the row
 *     (`revokedBy = GRANTOR`, the record's owner deciding) and writes a new
 *     one, so the history keeps "who had what, from when to when";
 *   - ending a row and clearing the sessions inside it are one act, in the
 *     caller's transaction, as {@link endAndClear} has it for the panel;
 *   - a row that already says what the target says is left alone.
 *
 * The new row is written ACCEPTED, which is the one place this file creates a
 * grant without an acceptance, and it is argued rather than assumed. The
 * Guardian accepted MANAGE over this whole record when they became a Guardian;
 * a handover only ever sets a level at or below that, and only for somebody
 * who held it a moment earlier. A READ row cut from their MANAGE is a
 * narrowing they need no new consent for, and a MANAGE row the new owner
 * restores is the consent they already gave. What it cannot do is reach
 * anybody who was not a Guardian of this record, or reach above MANAGE.
 *
 * Callers hold the managed-profile lock (`withManagedProfileLock`) for the
 * transaction, so the live row read beside this call is the row it settles.
 */
export async function settleHandoverGuardianGrant(
  tx: Prisma.TransactionClient,
  input: {
    recordId: string;
    guardianId: string;
    /** The pair's live row (`revokedAt IS NULL`), or null. */
    liveGrant: Pick<AccountGrant, "id" | "access" | "scopeJson"> | null;
    target: HandoverAccess;
    now: Date;
  },
): Promise<HandoverGrantSettlement> {
  const pair = { grantorId: input.recordId, granteeId: input.guardianId };
  const targetAccess = grantAccessFor(input.target);
  const live = input.liveGrant;

  const alreadyThere =
    live !== null &&
    targetAccess !== null &&
    live.access === targetAccess &&
    (live.access === "MANAGE" || live.scopeJson === null);
  if (alreadyThere) {
    return {
      access: input.target,
      grantId: live.id,
      changed: false,
      sessionsCleared: 0,
    };
  }
  if (live === null && targetAccess === null) {
    return {
      access: "end",
      grantId: null,
      changed: false,
      sessionsCleared: 0,
    };
  }

  if (live !== null) {
    await tx.accountGrant.updateMany({
      where: { id: live.id, revokedAt: null },
      data: { revokedAt: input.now, revokedBy: "GRANTOR" },
    });
  }

  let grantId: string | null = null;
  if (targetAccess !== null) {
    const created = await tx.accountGrant.create({
      data: {
        grantorId: input.recordId,
        granteeId: input.guardianId,
        access: targetAccess,
        // `DbNull`, never `null`: see `inviteGrant` for why the two nulls
        // mean opposite things on this column.
        scopeJson: Prisma.DbNull,
        invitedAt: input.now,
        acceptedAt: input.now,
        expiresAt: null,
      },
      select: { id: true },
    });
    grantId = created.id;
  }

  const sessionsCleared = await clearActingSessions(pair, tx);
  // A Guardian who keeps no MANAGE takes back the provider app they lent.
  await releaseUnbackedClientApps(input.recordId, tx);
  return { access: input.target, grantId, changed: true, sessionsCleared };
}

export interface RevokeGrantInput {
  grantId: string;
  /** The owner ending their own grant. Taken from the session. */
  grantorId: string;
}

/**
 * The owner withdraws access.
 *
 * No step-up, no friction: reducing access must never be harder than granting
 * it. The row survives with `revokedBy = GRANTOR`, and because the resolver
 * re-reads the grant on every request, enforcement is the delegate's next
 * request rather than their next login.
 */
export async function revokeGrant(
  input: RevokeGrantInput,
): Promise<AccountGrant> {
  return prisma.$transaction((tx) =>
    endGrant(input.grantId, { grantorId: input.grantorId }, "GRANTOR", tx),
  );
}

export interface RenounceGrantInput {
  grantId: string;
  /** The delegate handing the access back. Taken from the session. */
  granteeId: string;
}

/**
 * The delegate hands the access back.
 *
 * Same transition, different attribution: `revokedBy = GRANTEE` so the record
 * can tell "the owner withdrew it" from "the person given access no longer
 * wanted it". Two facts, one column, because they are answers to the same
 * question.
 */
export async function renounceGrant(
  input: RenounceGrantInput,
): Promise<AccountGrant> {
  return prisma.$transaction((tx) =>
    endGrant(input.grantId, { granteeId: input.granteeId }, "GRANTEE", tx),
  );
}

/**
 * What ending a grant did: the row as it now stands, and how many of the
 * delegate's browser sessions were sitting inside the record when it happened.
 */
export interface EndedGrant {
  grant: AccountGrant;
  sessionsCleared: number;
}

/**
 * The owner withdraws access, and any browser already inside the record leaves
 * with it.
 *
 * This is the verb the sharing panel calls; {@link revokeGrant} is the state
 * transition underneath it. They are separate because the transition has to be
 * usable inside somebody else's transaction, and because a caller who takes the
 * transition alone should have to notice they are leaving sessions behind.
 *
 * One transaction, and the reason is a specific failure: the grant row and the
 * sessions pointing at it are two statements of the same fact, and a revocation
 * that stamped the row but not the sessions would leave the delegate's browser
 * inside a record it can no longer read — every request 403, the banner still
 * saying "viewing her record", nothing on screen able to account for it. The
 * resolver would refuse correctly and the person would still be looking at a
 * lie.
 *
 * Still no step-up, no confirmation ceremony, nothing that makes this slower
 * than granting was. Reducing access must never be harder than giving it: the
 * person ending access to their own health record is the one party here whose
 * intent needs no verification.
 */
export async function revokeGrantAndClearSwitch(
  input: RevokeGrantInput,
): Promise<EndedGrant> {
  return endAndClear((tx) =>
    endGrant(input.grantId, { grantorId: input.grantorId }, "GRANTOR", tx),
  );
}

/**
 * The delegate hands the access back, and their own browser leaves the record.
 *
 * Same cleanup, and for a sharper reason than on the revoke side: the session
 * being cleared is almost certainly the one making this very request, because
 * renouncing is a thing people do while looking at the record they are
 * renouncing.
 */
export async function renounceGrantAndClearSwitch(
  input: RenounceGrantInput,
): Promise<EndedGrant> {
  return endAndClear((tx) =>
    endGrant(input.grantId, { granteeId: input.granteeId }, "GRANTEE", tx),
  );
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Run an ending transition and its session cleanup as one unit.
 *
 * The transition runs first and throws on a refusal, which rolls the whole
 * thing back — so a revoke somebody was not entitled to make cannot clear a
 * session as a side effect of being refused.
 */
async function endAndClear(
  transition: (tx: Prisma.TransactionClient) => Promise<AccountGrant>,
): Promise<EndedGrant> {
  return prisma.$transaction(async (tx) => {
    const grant = await transition(tx);
    const sessionsCleared = await clearActingSessions(
      { grantorId: grant.grantorId, granteeId: grant.granteeId },
      tx,
    );
    // An ended MANAGE grant takes back the provider app it lent the record.
    await releaseUnbackedClientApps(grant.grantorId, tx);
    return { grant, sessionsCleared };
  });
}

/** The shared body of revoke and renounce. */
async function endGrant(
  grantId: string,
  actor: { grantorId: string } | { granteeId: string },
  revokedBy: "GRANTOR" | "GRANTEE",
  db: Prisma.TransactionClient,
): Promise<AccountGrant> {
  const current = await db.accountGrant.findUnique({
    where: { id: grantId },
    select: {
      grantorId: true,
      granteeId: true,
      access: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  const end = async () => {
    const { count } = await db.accountGrant.updateMany({
      where: { id: grantId, ...actor, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy },
    });
    if (count === 0) throw await refusalFor(grantId, actor, db);
    return db.accountGrant.findUniqueOrThrow({ where: { id: grantId } });
  };

  const actorOwnsGrant =
    current &&
    ("grantorId" in actor
      ? current.grantorId === actor.grantorId
      : current.granteeId === actor.granteeId);
  const isActiveManagedGuardian =
    current?.access === "MANAGE" &&
    current.acceptedAt !== null &&
    current.revokedAt === null &&
    (current.expiresAt === null || current.expiresAt > new Date());

  if (!actorOwnsGrant || !isActiveManagedGuardian) return end();
  // `current` was read before the record lock. A concurrent change that holds
  // the lock first (the Guardian's account deletion ends this grant) commits
  // in between, and counting under the lock would then refuse with "add
  // another Guardian" for a grant that is no longer active, instead of saying
  // it has already ended. So the grant is re-read under the lock; only a grant
  // still live there is a Guardian whose removal the count has to allow.
  return withManagedProfileLock(db, current.grantorId, async () => {
    const live = await db.accountGrant.findFirst({
      where: { id: grantId, revokedAt: null },
      select: { id: true },
    });
    if (!live) return end();
    return reduceManagedProfileGuardian(db, current, end);
  });
}

/**
 * Why did a conditional update match nothing?
 *
 * Read once, after the fact, purely to name the refusal. The ordering is
 * ownership first: telling a stranger "that grant is already revoked" would
 * confirm the grant exists, so a caller who is not a party to the row learns
 * only that it is not theirs.
 */
async function refusalFor(
  grantId: string,
  actor: { grantorId: string } | { granteeId: string },
  db: GrantDb,
): Promise<GrantError> {
  const grant = await db.accountGrant.findUnique({ where: { id: grantId } });
  if (!grant) return new GrantError("not_found");

  if ("granteeId" in actor) {
    if (grant.granteeId !== actor.granteeId) {
      return new GrantError("not_grantee");
    }
  } else if (grant.grantorId !== actor.grantorId) {
    return new GrantError("not_grantor");
  }

  // The state machine names the refusal, so "why did this fail" and "what is
  // this row" can never give different answers.
  switch (grantState(grant)) {
    case "REVOKED":
      return new GrantError("already_revoked");
    case "EXPIRED":
      return new GrantError("expired");
    // Reached only from the accept path — revoke and renounce match any live
    // row, lapsed or not, because ending a grant explicitly is always the
    // owner's or the delegate's to do.
    default:
      return new GrantError("not_pending");
  }
}
