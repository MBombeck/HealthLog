/**
 * v1.36.0 — the shape of the sharing block, and nothing else.
 *
 * Types only, with no VALUE imports, because both ends read them: the route
 * that builds the block (`account-access.ts`, which talks to Postgres) and the
 * client that renders it. Declaring them beside the server code would put a
 * module that imports Prisma on the client's import graph — erased at compile
 * today, one careless value export away from being bundled tomorrow. The
 * boundary is cheaper to keep than to rediscover.
 *
 * The one import below is `import type` from `sharing/scope.ts`, which is a
 * closed list of string literals and imports nothing itself. It is erased
 * whole, so the property above still holds: nothing this file names can pull
 * a server module into a bundle. A value import from anywhere would break it.
 *
 * What these types are FOR is stated once here and holds everywhere they are
 * used: they carry resolved answers. `canWrite` and `canSwitch` are decisions
 * the server has already made; a client that recomputed either from the rest
 * of the payload would be the second program deciding one person's access.
 */
import type { ShareDomain } from "@/lib/sharing/scope";

/** What a grant lets its holder do, resolved. */
export type AccountAccessLevel = "read" | "write" | "manage";

/** One account this caller may act on. */
export interface AccountAccessEntry {
  /** The account whose record it is — the value `POST /api/account/switch` takes. */
  accountId: string;
  username: string;
  displayName: string | null;
  /**
   * The grant's level, as the owner offered it and the caller accepted it.
   *
   * The same value as {@link AccountAccessEntry.level}, under the name the
   * v1.36.0 contract published and shipped clients already read. Both are
   * assigned from one expression in `account-access.ts`, so they cannot come
   * apart; `level` is the name to write new code against.
   */
  access: AccountAccessLevel;
  /**
   * v1.37.0 — the same resolved level, under the name the three-level
   * contract speaks. Read it; never derive it from `canWrite`, and never
   * derive `canWrite` from it.
   */
  level: AccountAccessLevel;
  /**
   * v1.37.0 — which sections of the record this grant opens, or `null` for
   * the entire record.
   *
   * `null` is a first-class answer rather than a missing one: it is what every
   * grant written before this release means, what an owner who does not narrow
   * still gets, and what a MANAGE grant always carries. Render it as "the
   * entire record", never as a legacy state.
   *
   * An EMPTY array is a real answer too, and it means the grant opens nothing:
   * the fail-closed reading of a stored scope this build cannot parse. Render
   * that as nothing. The server will refuse every section for that grant on
   * the next request, and agreeing with it is the only honest option.
   *
   * Resolved server-side, in the consent screen's own reading order.
   */
  sections: ShareDomain[] | null;
  /**
   * May this caller ADD to that record. Resolved server-side. It does not by
   * itself mean edit or delete — a WRITE grant adds and does nothing more, and
   * that stayed true when a third level arrived. A MANAGE grant answers true
   * here as well, and what it additionally admits is said by `level` rather
   * than smuggled into this boolean.
   */
  canWrite: boolean;
}

/** The `accountAccess` block on `GET /api/auth/me`. */
export interface AccountAccess {
  /** Every account this caller may open, newest grant first. */
  accounts: AccountAccessEntry[];
  /**
   * The record this browser is inside right now, resolved to a full entry —
   * not an id the client has to look up. Null when it is in its own record,
   * and always null on the Bearer transport.
   */
  active: AccountAccessEntry | null;
  /** Is there anywhere to switch to. */
  canSwitch: boolean;
}

/**
 * The name to put in front of a person, given what the payload published.
 *
 * `displayName` when the account set one, the username otherwise. This is a
 * presentation fallback and not a derivation of anything the server decided —
 * both values are published, and which of the two reads better is the client's
 * business. Kept here so the banner, the switcher and the sharing panel cannot
 * disagree about what to call somebody.
 */
export function accountLabel(entry: {
  displayName: string | null;
  username: string;
}): string {
  const named = entry.displayName?.trim();
  return named && named.length > 0 ? named : entry.username;
}
