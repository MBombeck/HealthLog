/**
 * Which sections of a record accept a delegated write, and at which level.
 *
 * `requireRecordAuth(need, domain)` is declared per route, so the server has
 * always known which sections a WRITE or a MANAGE grant can reach. The client
 * did not: `resolveRecordCapabilities` answered `canManage: false` for every
 * shared record from v1.37.0 on, a hold-back written for the release where the
 * level was published before the routes behind it existed. The routes exist
 * now, and the hold-back kept hiding the add, edit and delete controls on a
 * managed profile whose every write the server accepts (#939).
 *
 * Flipping the boolean would have overshot in the other direction: the vault
 * has no delegated write route at all, so a manage grant that painted the
 * upload control there would paint a control that 403s. The answer is per
 * section and it is the server's: this file is the one table, the account
 * payload publishes the intersection of a grant with it, and the client reads
 * the lists.
 *
 * The values are a property of the routes and nothing else, which is why they
 * are frozen rather than trusted: `domain-write-support-guard.test.ts` scans
 * every `route.ts` under `src/app/api` for `requireRecordAuth("write" |
 * "manage", "<domain>")` and fails when this table and the routes disagree in
 * either direction. Editing a value here without a route to justify it, or
 * adding a delegated write route without editing here, is a red test.
 *
 * `record` is deliberately absent. It is not a section a grant can be narrowed
 * to (`scope.ts`), and a route declaring it reads across sections; nothing a
 * per-section control asks is answered by it.
 */
import type {
  AccountAccessLevel,
  SharedAccountRecordKind,
} from "@/lib/sharing/account-access-view";
import { SHARE_DOMAINS, type ShareDomain } from "@/lib/sharing/scope";

/** Whether any route in the section declares the need. */
export interface DomainWriteSupport {
  /** At least one route declares `requireRecordAuth("write", domain)`. */
  readonly write: boolean;
  /** At least one route declares `requireRecordAuth("manage", domain)`. */
  readonly manage: boolean;
  /**
   * #1403 — at least one route declares `requireRecordAuth("guardian",
   * domain)`: a change only a managed profile's guardian may make under a
   * grant. Reached by a MANAGE grant on a managed record and by nothing on an
   * adult's.
   */
  readonly guardian: boolean;
}

/**
 * The table. Derived from the route files on 2026-09-09 and frozen by the
 * structural guard; the reasons are in the routes, not here.
 */
export const DOMAIN_WRITE_SUPPORT: Readonly<
  Record<ShareDomain, DomainWriteSupport>
> = {
  measurements: { write: true, manage: true, guardian: false },
  medications: { write: true, manage: true, guardian: false },
  labs: { write: true, manage: true, guardian: false },
  profile: { write: true, manage: true, guardian: false },
  illness: { write: true, manage: true, guardian: false },
  // A mood entry and a screener are created at MANAGE, not at WRITE.
  mind: { write: false, manage: true, guardian: false },
  // Every cycle write is a MANAGE route.
  cycle: { write: false, manage: true, guardian: false },
  // #1403 — the vault is read-only under every adult grant. A managed
  // profile's guardian uploads, files, deletes and restores; sharing, sources
  // and the AI verbs stay with the owner.
  documents: { write: false, manage: false, guardian: true },
};

/** The two needs a delegated write can declare. */
export type DelegatedWriteNeed = "write" | "manage";

const LEVEL_RANK: Record<AccountAccessLevel, number> = {
  read: 0,
  write: 1,
  manage: 2,
};

/**
 * The sections a grant can write to, or manage, given its level and scope.
 *
 * `sections === null` is the entire record. A MANAGE grant always carries it
 * (`grants.ts` refuses a scope on a MANAGE invitation), a WRITE grant may.
 *
 * The answer is EXISTENTIAL per section, never per verb: "is there a route in
 * this section at this need the grant satisfies". Three of the four sections
 * that answer `write: true` also carry MANAGE-only creates — an allergy and a
 * family-history entry under `profile`, a water entry and a checkup reminder
 * under `measurements`, a snooze and a re-recorded dose under `medications` —
 * and no list keyed on the section can distinguish them. A control asks the
 * hook for its own verb class instead; the route declarations stay the one
 * place the split is decided.
 *
 * For `need === "write"` the answer is "is there a non-read route in this
 * section the grant satisfies": a WRITE grant reaches the section's `"write"`
 * routes, a MANAGE grant reaches those and its `"manage"` routes as well.
 * That is the `write ⊂ manage` ordering `grantAllows` enforces, stated as
 * lists — a section a manage grant can manage is a section it can write to,
 * so `manageable ⊆ writable` holds for every grant.
 *
 * For `need === "manage"` only a MANAGE grant answers, and only where a route
 * declares the need. The result keeps the consent screen's order.
 *
 * #1403 — `recordKind` adds the guardian routes. On a managed record a MANAGE
 * grant also reaches every section with a `"guardian"` route, in both lists:
 * the vault takes an upload (a create) and a rename, delete and restore (the
 * changes), and the guardian may make them all. On an adult's record the
 * guardian routes refuse at every level, so they add nothing. The default is
 * the adult share, so a caller that does not say which kind of record it is
 * publishes the narrower answer.
 */
export function delegatedDomains(
  level: AccountAccessLevel,
  sections: readonly ShareDomain[] | null,
  need: DelegatedWriteNeed,
  recordKind: SharedAccountRecordKind = "shared",
): ShareDomain[] {
  if (LEVEL_RANK[level] < LEVEL_RANK[need]) return [];
  const opened =
    sections === null ? new Set<ShareDomain>(SHARE_DOMAINS) : new Set(sections);
  const guardian = level === "manage" && recordKind === "managed";
  return SHARE_DOMAINS.filter((domain) => {
    if (!opened.has(domain)) return false;
    const support = DOMAIN_WRITE_SUPPORT[domain];
    if (guardian && support.guardian) return true;
    if (need === "manage") return support.manage;
    return support.write || (level === "manage" && support.manage);
  });
}
