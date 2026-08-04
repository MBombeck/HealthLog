/**
 * v1.36.0 — how a grant row reaches a client.
 *
 * One shape for every sharing route, because five endpoints each shaping the
 * same row their own way is five chances for the panel to render "active" on a
 * row the resolver has already stopped honouring.
 *
 * `state` is the important field and it is not stored anywhere: it comes from
 * `grantState()`, the same function the resolver's own predicate is built on.
 * A serialiser that derived it here from `revokedAt`/`acceptedAt` would be the
 * second decider this feature spends most of its design avoiding — and it
 * would drift in the dangerous direction, showing a grant as ended while the
 * resolver still admitted it, or the reverse.
 *
 * What is NOT published: the other party's e-mail. The owner typed an
 * identifier to invite somebody and does not need it echoed; the delegate
 * never asked for the owner's. Handing every party to a grant a durable
 * address for every other party is reach the grant was never meant to confer.
 */
import {
  grantState,
  normaliseScope,
  type GrantState,
} from "@/lib/sharing/grants";
import { SHARE_DOMAINS, type ShareDomain } from "@/lib/sharing/scope";
import type { AccountGrant } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

/** The other party to a grant, as far as anyone is told about them. */
export interface GrantParty {
  id: string;
  username: string;
  displayName: string | null;
}

/**
 * v1.37.0 — the stored scope as a client can read it.
 *
 * `null` is the entire record and stays null all the way to the screen: it is
 * the answer every grant carries unless somebody narrowed one, and flattening
 * it into "all eight sections" would turn a first-class value into a list that
 * looks like a choice nobody made.
 *
 * The order is {@link SHARE_DOMAINS}' own, which is the consent screen's
 * reading order — not the order the keys happened to be stored in. Two grants
 * over the same sections therefore serialise identically, so a diff of two
 * payloads means what it looks like.
 *
 * Everything else about the value is decided by `normaliseScope`, including
 * the fail-closed reading of a blob this build cannot parse: that resolves to
 * the empty set, and an empty array is published rather than papered over.
 * `[]` on the wire says "this grant opens nothing", which is exactly what the
 * resolver will tell the delegate on their next request, and a client that
 * rendered it as "everything" would be the second program deciding somebody's
 * access.
 *
 * The one place a stored scope becomes a published list, so the grant panel
 * and the account payload cannot disagree about what a grant opens.
 */
export function resolveGrantSections(
  scopeJson: Prisma.JsonValue | null,
): ShareDomain[] | null {
  const scope = normaliseScope(scopeJson);
  if (scope === null) return null;
  return SHARE_DOMAINS.filter((domain) => scope.has(domain));
}

export interface GrantView {
  id: string;
  /** The account on the other end: the delegate on a given grant, the owner on a received one. */
  account: GrantParty;
  access: AccountGrant["access"];
  /**
   * Which sections of the record the grant opens, or null for the whole of
   * it. Published so the delegate can read what they are accepting BEFORE the
   * accept button, and so the owner's panel can say what each live grant
   * reaches without opening it.
   */
  scope: ShareDomain[] | null;
  state: GrantState;
  invitedAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: AccountGrant["revokedBy"];
}

/** The columns a party needs, so a caller can `select` exactly them. */
export const GRANT_PARTY_SELECT = {
  id: true,
  username: true,
  displayName: true,
} as const;

export function toGrantView(
  grant: AccountGrant,
  account: GrantParty,
  now: Date = new Date(),
): GrantView {
  return {
    id: grant.id,
    account,
    access: grant.access,
    scope: resolveGrantSections(grant.scopeJson),
    state: grantState(grant, now),
    invitedAt: grant.invitedAt.toISOString(),
    acceptedAt: grant.acceptedAt?.toISOString() ?? null,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    revokedBy: grant.revokedBy,
  };
}
