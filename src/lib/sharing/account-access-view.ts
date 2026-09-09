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

/** The two values published by the original account-access contract. */
export type LegacyAccountAccessLevel = "read" | "write";

/** The server-resolved kind of record a presentation is naming. */
export type AccountRecordKind = "self" | "shared" | "managed";
export type SharedAccountRecordKind = Exclude<AccountRecordKind, "self">;

/**
 * Read the portion of an account-access entry that an older whole-record
 * client understands. A scoped entry is refused rather than guessed at.
 */
export function decodeLegacyWholeRecordAccess(
  value: unknown,
): LegacyAccountAccessLevel | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as { access?: unknown; sections?: unknown };
  if (entry.access !== "read" && entry.access !== "write") return null;
  if (entry.sections !== undefined && entry.sections !== null) return null;
  return entry.access;
}

/** One account this caller may act on. */
export interface AccountAccessEntry {
  /** The account whose record it is — the value `POST /api/account/switch` takes. */
  accountId: string;
  username: string;
  displayName: string | null;
  /**
   * v1.37.2 — the record owner's full name, when they have set one. Shown in
   * front of a delegate on the switcher and the banner, ahead of the greeting
   * name, so the person whose record they are entering reads as who they are
   * rather than by a nickname. See {@link accountLabel} for the deliberate
   * disclosure this carries; it is a maintainer decision, not an oversight.
   */
  fullName: string | null;
  /**
   * The grant's level, as the owner offered it and the caller accepted it.
   *
   * The same value as {@link AccountAccessEntry.level}, under the name the
   * v1.36.0 contract published and shipped clients already read. Both are
   * assigned from one expression in `account-access.ts`, so they cannot come
   * apart; `level` is the name to write new code against.
   */
  access: LegacyAccountAccessLevel;
  /**
   * v1.37.0 — the same resolved level, under the name the three-level
   * contract speaks. Read it; never derive it from `canWrite`, and never
   * derive `canWrite` from it.
   */
  level: AccountAccessLevel;
  /**
   * What kind of record this is. This is presentation metadata only; it is
   * resolved by the server and never accepted as an authorization input.
   */
  recordKind: SharedAccountRecordKind;
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
  /**
   * v1.38.12 — the sections this grant can add to, resolved server-side from
   * the grant's level and scope against the delegated write routes that
   * exist (`domain-write-support.ts`). In the consent screen's order. Empty
   * for a READ grant, and empty for any section whose routes accept no
   * delegated write at all — the vault, today.
   *
   * A list rather than a boolean because the answer differs per section, and
   * the client's per-control question is "this section", never "any".
   */
  writableDomains: ShareDomain[];
  /**
   * v1.38.12 — the sections this grant can change: edit, delete, restore,
   * bulk-act, and the creates a WRITE grant does not cover. A subset of
   * {@link AccountAccessEntry.writableDomains} by construction, and empty
   * below MANAGE.
   */
  manageableDomains: ShareDomain[];
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
  /** The server-resolved kind of the record currently in view. */
  recordKind?: AccountRecordKind;
  /** Is there anywhere to switch to. */
  canSwitch: boolean;
}

/**
 * The name to put in front of a person, given what the payload published.
 *
 * `fullName` when it is set, `displayName` next, the username last. All three
 * are published; which reads best is the client's business, not a derivation
 * of anything the server decided. Kept here so the banner, the switcher and
 * the sharing panel cannot disagree about what to call somebody.
 *
 * `fullName` is optional on the argument on purpose: only the account-access
 * entry carries it, so the switcher and the banner prefer it while the
 * grant-view and actor shapes that never had it keep falling back to the
 * greeting name exactly as before.
 *
 * v1.37.2 — the record owner's full name is shown to anyone they share with,
 * read-only included; maintainer decision 2026-08-08. It is patient-identity
 * data that until now stayed behind a MANAGE-gated export, so a future reader
 * should not "tighten" this back as a leak: it is the intended behaviour, not
 * an accident of the label falling through to it.
 */
export function accountLabel(entry: {
  displayName: string | null;
  username: string;
  fullName?: string | null;
}): string {
  const full = entry.fullName?.trim();
  if (full && full.length > 0) return full;
  const named = entry.displayName?.trim();
  return named && named.length > 0 ? named : entry.username;
}
