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
import type { AccountAccessLevel } from "@/lib/sharing/account-access-view";
import { SHARE_DOMAINS, type ShareDomain } from "@/lib/sharing/scope";

/** Whether any route in the section declares the need. */
export interface DomainWriteSupport {
  /** At least one route declares `requireRecordAuth("write", domain)`. */
  readonly write: boolean;
  /** At least one route declares `requireRecordAuth("manage", domain)`. */
  readonly manage: boolean;
}

/**
 * The table. Derived from the route files on 2026-09-09 and frozen by the
 * structural guard; the reasons are in the routes, not here.
 */
export const DOMAIN_WRITE_SUPPORT: Readonly<
  Record<ShareDomain, DomainWriteSupport>
> = {
  measurements: { write: true, manage: true },
  medications: { write: true, manage: true },
  labs: { write: true, manage: true },
  profile: { write: true, manage: true },
  illness: { write: true, manage: true },
  // A mood entry and a screener are created at MANAGE, not at WRITE.
  mind: { write: false, manage: true },
  // Every cycle write is a MANAGE route.
  cycle: { write: false, manage: true },
  // The vault is read-only under every grant; upload, filing, sharing and the
  // AI verbs stay with the owner.
  documents: { write: false, manage: false },
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
 * For `need === "write"` the answer is "is there a non-read route in this
 * section the grant satisfies": a WRITE grant reaches the section's `"write"`
 * routes, a MANAGE grant reaches those and its `"manage"` routes as well.
 * That is the `write ⊂ manage` ordering `grantAllows` enforces, stated as
 * lists — a section a manage grant can manage is a section it can write to,
 * so `manageable ⊆ writable` holds for every grant.
 *
 * For `need === "manage"` only a MANAGE grant answers, and only where a route
 * declares the need. The result keeps the consent screen's order.
 */
export function delegatedDomains(
  level: AccountAccessLevel,
  sections: readonly ShareDomain[] | null,
  need: DelegatedWriteNeed,
): ShareDomain[] {
  if (LEVEL_RANK[level] < LEVEL_RANK[need]) return [];
  const opened =
    sections === null ? new Set<ShareDomain>(SHARE_DOMAINS) : new Set(sections);
  return SHARE_DOMAINS.filter((domain) => {
    if (!opened.has(domain)) return false;
    const support = DOMAIN_WRITE_SUPPORT[domain];
    if (need === "manage") return support.manage;
    return support.write || (level === "manage" && support.manage);
  });
}
