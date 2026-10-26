/**
 * What an account grant MEANS at a given instant: its state, whether it
 * permits a need, whether it covers a section of the record, and the live
 * grant for a pair. Pure predicates plus one read and one fire-and-forget
 * stamp, and nothing that changes a grant.
 *
 * The transitions that DO change a grant (invite, accept, revoke, renounce,
 * the managed-profile handover) are in `./grants.ts` and decide through the
 * predicates here, so the resolver and the CRUD surface cannot carry two
 * ideas of "active". They live apart because the transitions reach into the
 * managed-profile lifecycle and the OAuth connect target, and those two read
 * a live grant themselves: with the predicates in the same module, every
 * reader of a grant was part of one import cycle.
 */
import { prisma } from "@/lib/db";
import { ENTIRE_RECORD, isShareDomain } from "@/lib/sharing/scope";
import type { ShareDomain, ShareScope } from "@/lib/sharing/scope";
import type { Prisma } from "@/generated/prisma/client";
import type {
  AccountGrant,
  AccountGrantAccess,
} from "@/generated/prisma/client";

/** The slice of a grant row the pure predicates read. */
export interface GrantLifecycle {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * What a grant currently is.
 *
 * Ordering matters and is stated rather than left to the reader: a revoked
 * grant reads REVOKED even if it also sat past its expiry, because somebody
 * ended it and the record should say so. An invitation past its expiry reads
 * EXPIRED rather than PENDING, because it can no longer be accepted. Only
 * ACTIVE confers anything.
 */
export type GrantState = "REVOKED" | "EXPIRED" | "PENDING" | "ACTIVE";

/** What a caller needs the grant to permit. */
export type GrantNeed = "read" | "write" | "manage";

/**
 * The narrow client slice these functions need, so a caller can pass a
 * transaction handle. Same shape as `issue-token.ts`.
 */
export type GrantDb = Pick<
  Prisma.TransactionClient,
  "accountGrant" | "auditLog"
>;

// ── The state machine, pure ─────────────────────────────────────────────────

/** What this grant is, at `now`. */
export function grantState(
  grant: GrantLifecycle,
  now: Date = new Date(),
): GrantState {
  if (grant.revokedAt !== null) return "REVOKED";
  // `<=` matches the Bearer-token expiry comparison: the instant named is the
  // first instant the grant no longer holds.
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "EXPIRED";
  if (grant.acceptedAt === null) return "PENDING";
  return "ACTIVE";
}

/**
 * Does this grant confer anything right now?
 *
 * The one predicate the resolver asks. Deliberately derived from
 * {@link grantState} rather than re-listing the conditions, so a fourth
 * terminal state can never be added without this answering for it.
 */
export function isGrantActive(
  grant: GrantLifecycle,
  now: Date = new Date(),
): boolean {
  return grantState(grant, now) === "ACTIVE";
}

/**
 * The three levels, ordered. Higher reaches everything lower.
 *
 * A total order rather than a set of capabilities per level, because that is
 * what the consent screen says out loud: view, view and add, manage. Written
 * as two tables rather than as a chain of comparisons so that a fourth level
 * cannot be added without deciding where it sits — an unlisted key does not
 * typecheck, and the exhaustiveness is the point of the `Record` type.
 */
const ACCESS_RANK: Record<AccountGrantAccess, number> = {
  READ: 0,
  WRITE: 1,
  MANAGE: 2,
};

const NEED_RANK: Record<GrantNeed, number> = {
  read: 0,
  write: 1,
  manage: 2,
};

/**
 * Does this grant permit what the caller is about to do?
 *
 * Active first, then the level. A READ grant permits reads only; a WRITE grant
 * permits both, because write access to a record without read access describes
 * nothing anyone asked for; a MANAGE grant permits all three, because managing
 * a record it cannot read or add to describes nothing either. The state
 * outranks the level in both directions: a revoked MANAGE grant permits
 * nothing at all, and no level survives an expiry.
 *
 * The comparison is `>=` on the ranks above and not equality, and the
 * difference matters in exactly one direction: a WRITE grant must never
 * satisfy `"manage"`. That is the whole of the third level's meaning — an
 * accepted WRITE grant carries a consent to add, and nothing about it carries
 * a consent to rewrite or remove.
 */
export function grantAllows(
  grant: GrantLifecycle & { access: AccountGrantAccess },
  need: GrantNeed,
  now: Date = new Date(),
): boolean {
  if (!isGrantActive(grant, now)) return false;
  return ACCESS_RANK[grant.access] >= NEED_RANK[need];
}

// ── Scope ───────────────────────────────────────────────────────────────────

/** The slice of a grant row the scope predicate reads. */
export interface GrantScope {
  scopeJson: Prisma.JsonValue | null;
}

/**
 * What a stored scope actually opens.
 *
 * `null` — the whole record. Not a default standing in for a missing answer:
 * it is the answer every grant written before the column existed was consented
 * as, and the answer an owner who ticks "entire record" gives today. It is a
 * first-class value everywhere, never a legacy badge.
 *
 * A set — those sections and nothing else, `record` included (see
 * {@link grantCoversDomain}).
 */
export type ResolvedScope = ReadonlySet<ShareDomain> | null;

const EMPTY_SCOPE: ReadonlySet<ShareDomain> = new Set<ShareDomain>();

/**
 * Turn the stored blob into what it opens, refusing anything it cannot read.
 *
 * Fail-closed, and this is the deliberate inverse of `normalisePrefs` in the
 * module gate: that one resolves a malformed preference blob to "everything
 * on", because a presentation preference nobody can read should not hide a
 * person's own data from them. This one answers an authorization question, so
 * a value it cannot read resolves to the EMPTY set — every section refused,
 * including any the garbage might have happened to name. Both directions are
 * "do the safe thing with a value we do not understand"; they only look
 * opposite because the safe thing differs.
 *
 * What counts as unreadable is deliberately wide: anything that is not an
 * array, an empty array, an array holding a key outside the vocabulary, an
 * array holding a non-string. There is no partial credit — a set that is half
 * recognisable is a set somebody wrote in a shape this file does not
 * understand, and honouring the half we recognise would be guessing at
 * consent. `record` is not a member of the vocabulary, so a stored `["record"]`
 * is unreadable too, which is the correct reading: a scope that means "no
 * scope" is a thing the invite path refuses to write, and one that reached
 * the column by any other route opens nothing.
 */
export function normaliseScope(stored: Prisma.JsonValue | null): ResolvedScope {
  if (stored === null || stored === undefined) return null;
  if (!Array.isArray(stored) || stored.length === 0) return EMPTY_SCOPE;

  const domains = new Set<ShareDomain>();
  for (const entry of stored) {
    if (!isShareDomain(entry)) return EMPTY_SCOPE;
    // A scope is a subset, not merely an array of recognisable values. A
    // duplicated key is malformed rather than a second consent to the same
    // domain, so it receives no partial credit.
    if (domains.has(entry)) return EMPTY_SCOPE;
    domains.add(entry);
  }
  return domains;
}

/**
 * Does this grant open the section the route declared?
 *
 * Three rules, and the second is the one that carries the invariant:
 *
 *   * A NULL scope covers everything, `record` included. That is what every
 *     grant in the product was until this release and what most will stay.
 *   * A non-NULL scope NEVER covers `record`. A route that declares `record`
 *     reads across sections — a health score, a digest, an achievement set —
 *     and there is no honest way to answer one of those for a delegate who was
 *     given part of a record. A score that says 70 to the owner and 64 to the
 *     delegate is a support case and a clinical hazard, so the scoped delegate
 *     does not get a filtered answer, they get no answer.
 *   * Otherwise, membership. A key that postdates the invitation is not in the
 *     stored set and so is not covered, which is why a new section is a
 *     consent question rather than a schema question.
 *
 * The level is a separate question, asked by {@link grantAllows}. This one
 * knows nothing about READ, WRITE or MANAGE — and MANAGE rows carry a NULL
 * scope by construction, so it answers true for them by the first rule rather
 * than by a special case.
 */
export function grantCoversDomain(
  grant: GrantScope,
  domain: ShareScope,
): boolean {
  const scope = normaliseScope(grant.scopeJson);
  if (scope === null) return true;
  if (domain === ENTIRE_RECORD) return false;
  return scope.has(domain);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * The grant that lets `granteeId` act on `grantorId`'s record right now, or
 * null.
 *
 * The query narrows on `revokedAt: null` only — which the partial unique index
 * makes at most one row — and every other condition is decided by
 * {@link isGrantActive}. That split is deliberate: a SQL predicate spelling out
 * "accepted and not expired" beside a TypeScript predicate spelling out the
 * same thing is two places deciding one question, and the copy that drifts is
 * the one nobody reads. Here the database narrows and the state machine
 * decides.
 */
export async function findActiveGrant(
  pair: { grantorId: string; granteeId: string },
  db: GrantDb = prisma,
  now: Date = new Date(),
): Promise<AccountGrant | null> {
  const live = await db.accountGrant.findFirst({
    where: {
      grantorId: pair.grantorId,
      granteeId: pair.granteeId,
      revokedAt: null,
    },
  });
  if (!live) return null;
  return isGrantActive(live, now) ? live : null;
}

/**
 * Stamp `lastUsedAt` on a grant that was just exercised.
 *
 * Fire-and-forget, the `ApiToken.lastUsedAt` posture (`bearer.ts`): the request
 * that triggered it must not wait, and a failure to record the use must not
 * fail the read. The promise is returned so a test can await it; production
 * callers deliberately do not.
 */
export function touchGrantUsage(
  grantId: string,
  db: GrantDb = prisma,
): Promise<void> {
  return db.accountGrant
    .update({ where: { id: grantId }, data: { lastUsedAt: new Date() } })
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Whether the request resolved under `grantId` may `need` over `domain` —
 * the question a READ answers when it publishes an action the caller may or
 * may not be allowed to take (`canEndCourse` on the medication reads).
 *
 * `null` is the record's owner, who may do everything the record allows. A
 * grant is re-read here rather than trusted from the resolver because the
 * resolver only proved the level the READ route declared; the action the
 * read advertises is declared on another route at another level, and the
 * answer has to be the one that route would give.
 */
export async function grantIdAllows(
  grantId: string | null,
  need: GrantNeed,
  domain: ShareScope,
  db: GrantDb = prisma,
  now: Date = new Date(),
): Promise<boolean> {
  if (grantId === null) return true;
  const grant = await db.accountGrant.findUnique({ where: { id: grantId } });
  if (!grant) return false;
  return grantAllows(grant, need, now) && grantCoversDomain(grant, domain);
}
