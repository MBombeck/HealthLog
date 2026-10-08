/**
 * v1.42 (#959) — handing a managed profile over to the person it describes.
 *
 * A managed profile is a `User` row nobody signs into, kept by its Guardians.
 * The handover turns it into that person's own account. No data moves: every
 * reading already hangs off the profile's own id. What changes is who can sign
 * in to it and who else keeps access.
 *
 * The flow, in the order it happens:
 *
 *   1. A Guardian, with a fresh second factor, mints a one-time link and
 *      proposes a level per Guardian (`handover-access.ts`). Only the HMAC of
 *      the token is stored; at most one link per profile is open, and minting
 *      a new one withdraws the old.
 *   2. The person opens the link, sees a minimal preview (the profile's name,
 *      the link's expiry, each Guardian's proposed access — no health data),
 *      and chooses a username, an email and a password.
 *   3. The claim runs as ONE transaction under the managed-profile lock: the
 *      token is consumed, the credentials are set, the marker is cleared,
 *      every pending invitation the record has offered is withdrawn, each
 *      Guardian's access is set to its proposal, the disclaimer, onboarding
 *      and AI consent are reset so the new owner gives them personally, and
 *      every step is audited. A failure anywhere leaves the profile managed
 *      and the link unused.
 *   4. On first sign-in the new owner sees each Guardian's access and decides
 *      finally. Until they do, the proposal is what holds.
 *
 * Every refusal on the anonymous side is the same `invalid`, so the preview
 * and the claim cannot be used to learn whether a token, a profile or a
 * Guardian exists.
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  generateHandoverToken,
  handoverHashMatches,
  hashHandoverToken,
  looksLikeHandoverToken,
} from "@/lib/auth/handover-token";
import { withdrawConsentInTransaction } from "@/lib/consent/withdrawal";
import { consentKindEnum } from "@/lib/validations/consent";
import {
  activeGuardianWhere,
  clearManagedProfileMarker,
  withManagedProfileLock,
} from "@/lib/managed-profiles/lifecycle";
import {
  DEFAULT_HANDOVER_ACCESS,
  HANDOVER_ACCESS_LEVELS,
  handoverAccessOf,
  type HandoverAccess,
} from "@/lib/managed-profiles/handover-access";
import {
  isGrantActive,
  settleHandoverGuardianGrant,
  withdrawPendingGrantsOfRecord,
} from "@/lib/sharing/grants";
import { isP2002 } from "@/lib/prisma-errors";
import type { Prisma } from "@/generated/prisma/client";

type Transaction = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

export type HandoverErrorCode =
  /** No such managed profile, or the caller is not one of its Guardians. */
  | "not_found"
  /** A proposal names a grant that is not an active Guardian of the profile. */
  | "unknown_guardian"
  /** Anonymous side: no usable link behind the token. Every cause. */
  | "invalid"
  /** The username or email is already taken. */
  | "taken"
  /** The new owner has no handover decision waiting. */
  | "no_pending";

export class HandoverError extends Error {
  constructor(readonly code: HandoverErrorCode) {
    super(`managed profile handover refused: ${code}`);
    this.name = "HandoverError";
  }
}

// ── Stored state ────────────────────────────────────────────────────────────

/** One Guardian's proposal, as the issuing Guardian recorded it. */
interface StoredProposal {
  /** The Guardian's MANAGE grant when the link was minted. */
  grantId: string;
  guardianId: string;
  proposal: HandoverAccess;
}

/** One Guardian's access across the claim and the owner's decision. */
interface StoredClaimEntry {
  /** The Guardian's MANAGE grant at the moment of the claim. */
  grantId: string;
  guardianId: string;
  proposal: HandoverAccess;
  /** What the claim set. */
  applied: HandoverAccess;
  /** The live grant the handover last wrote or kept, or null for `end`. */
  currentGrantId: string | null;
  /** The new owner's final choice, once made. */
  decided?: HandoverAccess;
}

/**
 * Everything `proposals_json` holds. Versioned, because the column outlives
 * the code that wrote it: a row from a later shape that this code cannot read
 * is treated as no handover at all, never guessed at.
 */
interface HandoverState {
  version: 1;
  proposals: StoredProposal[];
  claim?: {
    claimedAt: string;
    guardians: StoredClaimEntry[];
    decidedAt: string | null;
  };
}

function isAccess(value: unknown): value is HandoverAccess {
  return (
    typeof value === "string" &&
    (HANDOVER_ACCESS_LEVELS as readonly string[]).includes(value)
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Read the column, refusing anything it does not fully understand. */
export function parseHandoverState(value: unknown): HandoverState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.proposals)) return null;

  const proposals: StoredProposal[] = [];
  for (const entry of raw.proposals) {
    const e = entry as Record<string, unknown> | null;
    if (!e || !isString(e.grantId) || !isString(e.guardianId)) return null;
    if (!isAccess(e.proposal)) return null;
    proposals.push({
      grantId: e.grantId,
      guardianId: e.guardianId,
      proposal: e.proposal,
    });
  }

  if (raw.claim === undefined) return { version: 1, proposals };
  const claim = raw.claim as Record<string, unknown> | null;
  if (!claim || !isString(claim.claimedAt) || !Array.isArray(claim.guardians)) {
    return null;
  }
  if (claim.decidedAt !== null && !isString(claim.decidedAt)) return null;
  const guardians: StoredClaimEntry[] = [];
  for (const entry of claim.guardians) {
    const e = entry as Record<string, unknown> | null;
    if (!e || !isString(e.grantId) || !isString(e.guardianId)) return null;
    if (!isAccess(e.proposal) || !isAccess(e.applied)) return null;
    if (e.currentGrantId !== null && !isString(e.currentGrantId)) return null;
    if (e.decided !== undefined && !isAccess(e.decided)) return null;
    guardians.push({
      grantId: e.grantId,
      guardianId: e.guardianId,
      proposal: e.proposal,
      applied: e.applied,
      currentGrantId: e.currentGrantId,
      ...(e.decided !== undefined ? { decided: e.decided } : {}),
    });
  }
  return {
    version: 1,
    proposals,
    claim: {
      claimedAt: claim.claimedAt,
      guardians,
      decidedAt: claim.decidedAt,
    },
  };
}

function toJson(state: HandoverState): Prisma.InputJsonValue {
  return state as unknown as Prisma.InputJsonValue;
}

/** The proposal for a Guardian grant, or the default when none was named. */
function proposalFor(state: HandoverState, grantId: string): HandoverAccess {
  return (
    state.proposals.find((entry) => entry.grantId === grantId)?.proposal ??
    DEFAULT_HANDOVER_ACCESS
  );
}

async function isActiveGuardian(
  db: Pick<Transaction, "accountGrant">,
  profileId: string,
  guardianId: string | null,
  now: Date,
): Promise<boolean> {
  // A link whose creator's account is gone (`created_by_id` cleared) has no
  // Guardian behind it.
  if (guardianId === null) return false;
  const grant = await db.accountGrant.findFirst({
    where: {
      grantorId: profileId,
      granteeId: guardianId,
      ...activeGuardianWhere(now),
    },
    select: { id: true },
  });
  return grant !== null;
}

function nameOf(user: { displayName: string | null; username: string }) {
  return user.displayName?.trim() || user.username;
}

// ── Guardian side ───────────────────────────────────────────────────────────

export interface CreatedHandover {
  id: string;
  /** The raw token. Returned once, here, and never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Mint the one-time link. Any active Guardian may, not only the profile's
 * creator: Guardians of one record hold the same standing.
 *
 * One proposal per active Guardian is recorded. A Guardian the caller left
 * out is proposed {@link DEFAULT_HANDOVER_ACCESS}; a proposal naming a grant
 * that is not an active Guardian of this profile is refused rather than
 * dropped, because it means the form and the roster disagree.
 */
export async function createHandover(input: {
  profileId: string;
  guardianId: string;
  expiresInDays: number;
  proposals: { grantId: string; proposal: HandoverAccess }[];
  now?: Date;
}): Promise<CreatedHandover> {
  const now = input.now ?? new Date();
  return prisma.$transaction((tx) =>
    withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile?.managedProfileAt) throw new HandoverError("not_found");

      const guardians = await tx.accountGrant.findMany({
        where: { grantorId: profile.id, ...activeGuardianWhere(now) },
        select: { id: true, granteeId: true },
        orderBy: { createdAt: "asc" },
      });
      if (!guardians.some((g) => g.granteeId === input.guardianId)) {
        throw new HandoverError("not_found");
      }
      const known = new Set(guardians.map((g) => g.id));
      if (input.proposals.some((p) => !known.has(p.grantId))) {
        throw new HandoverError("unknown_guardian");
      }

      const proposals: StoredProposal[] = guardians.map((g) => ({
        grantId: g.id,
        guardianId: g.granteeId,
        proposal:
          input.proposals.find((p) => p.grantId === g.id)?.proposal ??
          DEFAULT_HANDOVER_ACCESS,
      }));

      // At most one open link per profile: the partial unique index enforces
      // it, and this is what keeps a second mint from colliding with it.
      const replaced = await tx.managedProfileHandover.updateMany({
        where: { profileId: profile.id, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });

      const token = generateHandoverToken();
      const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);
      const row = await tx.managedProfileHandover.create({
        data: {
          profileId: profile.id,
          createdById: input.guardianId,
          tokenHash: hashHandoverToken(token),
          proposalsJson: toJson({ version: 1, proposals }),
          expiresAt,
        },
        select: { id: true },
      });

      // Filed under the RECORD with the Guardian as the actor, like every
      // other act on a managed profile. No token, no names.
      await auditLog("managed_profile.handover.created", {
        userId: profile.id,
        actorUserId: input.guardianId,
        details: {
          handoverId: row.id,
          expiresAt: expiresAt.toISOString(),
          replaced: replaced.count,
          proposals: proposals.map((p) => ({
            grantId: p.grantId,
            proposal: p.proposal,
          })),
        },
        client: tx,
      });

      return { id: row.id, token, expiresAt };
    }),
  );
}

export interface HandoverStatus {
  open: {
    id: string;
    createdAt: Date;
    expiresAt: Date;
    createdByCaller: boolean;
  } | null;
}

/**
 * The profile's open link, for a Guardian's panel. Never the link itself:
 * only its hash exists. `null` when the caller may not see the profile.
 */
export async function readHandoverStatus(input: {
  profileId: string;
  guardianId: string;
  now?: Date;
}): Promise<HandoverStatus | null> {
  const now = input.now ?? new Date();
  const profile = await prisma.user.findUnique({
    where: { id: input.profileId },
    select: { managedProfileAt: true },
  });
  if (!profile?.managedProfileAt) return null;
  if (
    !(await isActiveGuardian(prisma, input.profileId, input.guardianId, now))
  ) {
    return null;
  }

  const open = await prisma.managedProfileHandover.findFirst({
    where: {
      profileId: input.profileId,
      usedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true, createdAt: true, expiresAt: true, createdById: true },
  });
  // A link whose creator has since lost access cannot be claimed; showing it
  // as open would promise something the claim refuses.
  if (
    !open ||
    !(await isActiveGuardian(prisma, input.profileId, open.createdById, now))
  ) {
    return { open: null };
  }
  return {
    open: {
      id: open.id,
      createdAt: open.createdAt,
      expiresAt: open.expiresAt,
      createdByCaller: open.createdById === input.guardianId,
    },
  };
}

/**
 * Withdraw the open link. Any active Guardian may, with no step-up: taking a
 * link back must never be harder than handing it out.
 */
export async function revokeHandover(input: {
  profileId: string;
  guardianId: string;
  now?: Date;
}): Promise<{ revoked: boolean }> {
  const now = input.now ?? new Date();
  return prisma.$transaction((tx) =>
    withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile?.managedProfileAt) throw new HandoverError("not_found");
      if (!(await isActiveGuardian(tx, profile.id, input.guardianId, now))) {
        throw new HandoverError("not_found");
      }
      const { count } = await tx.managedProfileHandover.updateMany({
        where: { profileId: profile.id, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      if (count > 0) {
        await auditLog("managed_profile.handover.revoked", {
          userId: profile.id,
          actorUserId: input.guardianId,
          details: { count },
          client: tx,
        });
      }
      return { revoked: count > 0 };
    }),
  );
}

// ── Anonymous side ──────────────────────────────────────────────────────────

/**
 * The stored row behind a raw token, by keyed-hash lookup, or null. A token
 * that fails the shape gate costs no HMAC and no query.
 */
async function findHandoverByToken(
  db: Pick<Transaction, "managedProfileHandover">,
  rawToken: string,
) {
  if (!looksLikeHandoverToken(rawToken)) return null;
  const tokenHash = hashHandoverToken(rawToken);
  const row = await db.managedProfileHandover.findUnique({
    where: { tokenHash },
  });
  if (!row || !handoverHashMatches(row.tokenHash, tokenHash)) return null;
  return row;
}

function isOpen(
  row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date,
): boolean {
  return row.usedAt === null && row.revokedAt === null && row.expiresAt > now;
}

export interface HandoverPreview {
  displayName: string | null;
  expiresAt: Date;
  guardians: {
    grantId: string;
    displayName: string;
    proposal: HandoverAccess;
  }[];
}

/**
 * What a link would hand over, or null for every kind of unusable link.
 *
 * Deliberately minimal: the profile's name, the expiry, and who keeps which
 * access. No health data, no date of birth, no usernames — the person holding
 * the link has not proved anything yet beyond holding it.
 */
export async function previewHandover(
  rawToken: string,
  now: Date = new Date(),
): Promise<HandoverPreview | null> {
  const row = await findHandoverByToken(prisma, rawToken);
  if (!row || !isOpen(row, now)) return null;
  const state = parseHandoverState(row.proposalsJson);
  if (!state) return null;

  const profile = await prisma.user.findUnique({
    where: { id: row.profileId },
    select: { displayName: true, managedProfileAt: true },
  });
  if (!profile?.managedProfileAt) return null;
  if (!(await isActiveGuardian(prisma, row.profileId, row.createdById, now))) {
    return null;
  }

  const guardians = await prisma.accountGrant.findMany({
    where: { grantorId: row.profileId, ...activeGuardianWhere(now) },
    select: {
      id: true,
      grantee: { select: { displayName: true, username: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return {
    displayName: profile.displayName,
    expiresAt: row.expiresAt,
    guardians: guardians.map((g) => ({
      grantId: g.id,
      displayName: nameOf(g.grantee),
      proposal: proposalFor(state, g.id),
    })),
  };
}

export interface ClaimedProfile {
  profileId: string;
  username: string;
  displayName: string | null;
  guardians: { guardianId: string; access: HandoverAccess }[];
}

/**
 * Claim the profile behind a link. One transaction; see the module header for
 * everything it does. Throws `HandoverError("invalid")` for every unusable
 * link and `HandoverError("taken")` for a username or email in use.
 *
 * The caller has already hashed the password (Argon2id) and checked its
 * strength: none of that work belongs inside the lock.
 */
export async function claimManagedProfile(input: {
  rawToken: string;
  username: string;
  email: string;
  passwordHash: string;
  ipAddress?: string | null;
  now?: Date;
}): Promise<ClaimedProfile> {
  const now = input.now ?? new Date();
  const found = await findHandoverByToken(prisma, input.rawToken);
  if (!found) throw new HandoverError("invalid");

  try {
    return await prisma.$transaction((tx) =>
      withManagedProfileLock(tx, found.profileId, async (profile) => {
        if (!profile?.managedProfileAt) throw new HandoverError("invalid");

        // Re-read under the lock: a new link, a withdrawal or a second claim
        // that committed while this one waited is seen here.
        const row = await tx.managedProfileHandover.findUnique({
          where: { id: found.id },
        });
        if (!row || !isOpen(row, now)) throw new HandoverError("invalid");
        const state = parseHandoverState(row.proposalsJson);
        if (!state) throw new HandoverError("invalid");
        if (!(await isActiveGuardian(tx, profile.id, row.createdById, now))) {
          throw new HandoverError("invalid");
        }

        // Single use: the conditional update is the claim on the token.
        const consumed = await tx.managedProfileHandover.updateMany({
          where: {
            id: row.id,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) throw new HandoverError("invalid");

        // The new owner's credentials, field by field. The disclaimer and the
        // onboarding were given by a Guardian on the person's behalf; an adult
        // gives both themselves.
        const updated = await tx.user.update({
          where: { id: profile.id },
          data: {
            username: input.username,
            email: input.email,
            passwordHash: input.passwordHash,
            disclaimerAcknowledgedAt: null,
            disclaimerAcknowledgedVersion: null,
            onboardingCompletedAt: null,
          },
          select: { username: true, displayName: true },
        });
        await clearManagedProfileMarker({ profileId: profile.id }, tx);

        const withdrawnInvitations = await withdrawPendingGrantsOfRecord(
          tx,
          profile.id,
          now,
        );

        const guardians = await tx.accountGrant.findMany({
          where: { grantorId: profile.id, ...activeGuardianWhere(now) },
          select: { id: true, granteeId: true, access: true, scopeJson: true },
          orderBy: { createdAt: "asc" },
        });
        const entries: StoredClaimEntry[] = [];
        for (const grant of guardians) {
          const proposal = proposalFor(state, grant.id);
          const settled = await settleHandoverGuardianGrant(tx, {
            recordId: profile.id,
            guardianId: grant.granteeId,
            liveGrant: grant,
            target: proposal,
            now,
          });
          entries.push({
            grantId: grant.id,
            guardianId: grant.granteeId,
            proposal,
            applied: settled.access,
            currentGrantId: settled.grantId,
          });
          // Under the Guardian's OWN account, so their history shows that a
          // record they looked after has gone. No actor: it is not somebody
          // else acting on the Guardian's record.
          await auditLog("managed_profile.handed_over", {
            userId: grant.granteeId,
            actorUserId: null,
            details: {
              profileId: profile.id,
              access: settled.access,
              grantId: settled.grantId,
            },
            client: tx,
          });
        }

        const consent = await withdrawConsentInTransaction(
          tx,
          profile.id,
          consentKindEnum.options,
          now,
        );

        await tx.managedProfileHandover.update({
          where: { id: row.id },
          data: {
            proposalsJson: toJson({
              ...state,
              claim: {
                claimedAt: now.toISOString(),
                guardians: entries,
                decidedAt: null,
              },
            }),
          },
        });

        await auditLog("managed_profile.claimed", {
          userId: profile.id,
          actorUserId: null,
          ipAddress: input.ipAddress ?? null,
          details: {
            handoverId: row.id,
            guardians: entries.map((e) => ({
              grantId: e.grantId,
              access: e.applied,
              newGrantId: e.currentGrantId,
            })),
            withdrawnInvitations,
            consentsWithdrawn: consent.revoked.length,
          },
          client: tx,
        });

        return {
          profileId: profile.id,
          username: updated.username,
          displayName: updated.displayName,
          guardians: entries.map((e) => ({
            guardianId: e.guardianId,
            access: e.applied,
          })),
        };
      }),
    );
  } catch (err) {
    if (isP2002(err)) throw new HandoverError("taken");
    throw err;
  }
}

// ── The new owner's decision ────────────────────────────────────────────────

export interface PendingHandoverGuardian {
  /** The Guardian's grant at the claim; what a decision names. */
  grantId: string;
  displayName: string;
  proposal: HandoverAccess;
  /** The access the Guardian holds now. */
  current: HandoverAccess;
  /**
   * False when the access moved since the claim — the Guardian stepped away,
   * or the owner already changed it under Settings → Shared access — so the
   * decision screen shows it and leaves it alone.
   */
  decidable: boolean;
}

export interface PendingHandoverDecision {
  handoverId: string;
  claimedAt: Date;
  guardians: PendingHandoverGuardian[];
}

async function latestClaimedHandover(
  db: Pick<Transaction, "managedProfileHandover">,
  userId: string,
) {
  return db.managedProfileHandover.findFirst({
    where: { profileId: userId, usedAt: { not: null } },
    orderBy: { usedAt: "desc" },
    select: { id: true, proposalsJson: true },
  });
}

/** Whether the pair's live row is still the one the handover left there. */
function isUntouched(
  entry: StoredClaimEntry,
  live: { id: string } | null,
): boolean {
  return entry.currentGrantId === null
    ? live === null
    : live?.id === entry.currentGrantId;
}

/**
 * Whether a decision is waiting, for the setup flow's front door. The cheap
 * question; {@link readPendingHandoverDecision} is the full answer.
 */
export async function hasPendingHandoverDecision(
  userId: string,
): Promise<boolean> {
  const row = await latestClaimedHandover(prisma, userId);
  const state = row ? parseHandoverState(row.proposalsJson) : null;
  return Boolean(state?.claim && state.claim.decidedAt === null);
}

/**
 * The decision waiting for the new owner, or null when there is none — the
 * account was never a managed profile, or the decision was made.
 */
export async function readPendingHandoverDecision(
  userId: string,
  now: Date = new Date(),
): Promise<PendingHandoverDecision | null> {
  const row = await latestClaimedHandover(prisma, userId);
  if (!row) return null;
  const state = parseHandoverState(row.proposalsJson);
  if (!state?.claim || state.claim.decidedAt !== null) return null;

  const ids = state.claim.guardians.map((e) => e.guardianId);
  const [people, liveGrants] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, username: true },
    }),
    prisma.accountGrant.findMany({
      where: { grantorId: userId, granteeId: { in: ids }, revokedAt: null },
      select: {
        id: true,
        granteeId: true,
        access: true,
        acceptedAt: true,
        revokedAt: true,
        expiresAt: true,
      },
    }),
  ]);

  const guardians: PendingHandoverGuardian[] = [];
  for (const entry of state.claim.guardians) {
    const person = people.find((p) => p.id === entry.guardianId);
    // A Guardian whose account is gone has nothing left to decide.
    if (!person) continue;
    const live =
      liveGrants.find((g) => g.granteeId === entry.guardianId) ?? null;
    const decidable = isUntouched(entry, live);
    guardians.push({
      grantId: entry.grantId,
      displayName: nameOf(person),
      proposal: entry.proposal,
      current: decidable
        ? entry.applied
        : handoverAccessOf(live && isGrantActive(live, now) ? live : null),
      decidable,
    });
  }
  return {
    handoverId: row.id,
    claimedAt: new Date(state.claim.claimedAt),
    guardians,
  };
}

export interface HandoverDecisionResult {
  /** Guardians whose access this decision changed, for their notification. */
  changed: { guardianId: string; access: HandoverAccess }[];
}

/**
 * Record the new owner's final word on each former Guardian.
 *
 * A Guardian the body leaves out keeps the access the claim gave them. One the
 * owner already changed elsewhere, or who stepped away, is left alone. Every
 * change ends a row and writes a new one, as any change of level does.
 */
export async function decideHandover(input: {
  userId: string;
  decisions: { grantId: string; access: HandoverAccess }[];
  now?: Date;
}): Promise<HandoverDecisionResult> {
  const now = input.now ?? new Date();
  return prisma.$transaction((tx) =>
    // The same key every lifecycle act on this record takes. The marker is
    // gone, so nothing here depends on it; the lock orders this against a
    // second decision from another tab.
    withManagedProfileLock(tx, input.userId, async () => {
      const row = await latestClaimedHandover(tx, input.userId);
      const state = row ? parseHandoverState(row.proposalsJson) : null;
      if (!row || !state?.claim || state.claim.decidedAt !== null) {
        throw new HandoverError("no_pending");
      }
      const claim = state.claim;
      // A former Guardian whose account is gone has nothing left to decide:
      // the pending read leaves them out, and a decision that names them
      // anyway is refused like one about a stranger, rather than failing on
      // a grant written for an account that no longer exists.
      const present = new Set(
        (
          await tx.user.findMany({
            where: { id: { in: claim.guardians.map((e) => e.guardianId) } },
            select: { id: true },
          })
        ).map((u) => u.id),
      );
      const known = new Set(
        claim.guardians
          .filter((e) => present.has(e.guardianId))
          .map((e) => e.grantId),
      );
      if (input.decisions.some((d) => !known.has(d.grantId))) {
        throw new HandoverError("unknown_guardian");
      }

      const changed: HandoverDecisionResult["changed"] = [];
      const outcome: {
        grantId: string;
        access: HandoverAccess;
        changed: boolean;
        skipped: boolean;
      }[] = [];
      const guardians: StoredClaimEntry[] = [];
      for (const entry of claim.guardians) {
        if (!present.has(entry.guardianId)) {
          guardians.push(entry);
          outcome.push({
            grantId: entry.grantId,
            access: entry.applied,
            changed: false,
            skipped: true,
          });
          continue;
        }
        const target =
          input.decisions.find((d) => d.grantId === entry.grantId)?.access ??
          entry.applied;
        const live = await tx.accountGrant.findFirst({
          where: {
            grantorId: input.userId,
            granteeId: entry.guardianId,
            revokedAt: null,
          },
          select: { id: true, access: true, scopeJson: true },
        });
        if (!isUntouched(entry, live)) {
          guardians.push(entry);
          outcome.push({
            grantId: entry.grantId,
            access: target,
            changed: false,
            skipped: true,
          });
          continue;
        }
        const settled = await settleHandoverGuardianGrant(tx, {
          recordId: input.userId,
          guardianId: entry.guardianId,
          liveGrant: live,
          target,
          now,
        });
        guardians.push({
          ...entry,
          decided: target,
          currentGrantId: settled.grantId,
        });
        outcome.push({
          grantId: entry.grantId,
          access: target,
          changed: settled.changed,
          skipped: false,
        });
        if (settled.changed) {
          changed.push({ guardianId: entry.guardianId, access: target });
          await auditLog("managed_profile.handover.access_changed", {
            userId: entry.guardianId,
            actorUserId: null,
            details: { profileId: input.userId, access: target },
            client: tx,
          });
        }
      }

      await tx.managedProfileHandover.update({
        where: { id: row.id },
        data: {
          proposalsJson: toJson({
            ...state,
            claim: { ...claim, guardians, decidedAt: now.toISOString() },
          }),
        },
      });
      await auditLog("managed_profile.handover.decided", {
        userId: input.userId,
        details: { handoverId: row.id, decisions: outcome },
        client: tx,
      });
      return { changed };
    }),
  );
}
