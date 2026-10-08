/**
 * The browser's parse of the account-access block on `GET /api/auth/me`.
 *
 * Plain TypeScript, no Zod, on purpose. `use-auth.ts` runs this parse on every
 * app boot, so whatever it imports lands in the shell every route shares, and
 * this parse was the shell's only Zod import: about 60 KB gzip on every first
 * paint for one structural check. A tree-shaken `zod/mini` build measured
 * almost the same under Turbopack, because the shared core comes along either
 * way.
 *
 * The Zod schema stays the contract: `account-access-schema.ts` publishes it
 * to OpenAPI, and `account-access-parse.test.ts` runs both over the same
 * corpus of good and broken blocks and fails the moment they disagree on
 * whether a block is accepted or on what comes out of it.
 */
import type {
  AccountAccess,
  AccountAccessEntry,
} from "@/lib/sharing/account-access-view";
import { SHARE_DOMAINS, type ShareDomain } from "@/lib/sharing/scope";

const DOMAINS: ReadonlySet<string> = new Set(SHARE_DOMAINS);

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function domainList(value: unknown): ShareDomain[] | null {
  if (!Array.isArray(value)) return null;
  for (const domain of value) {
    if (typeof domain !== "string" || !DOMAINS.has(domain)) return null;
  }
  return [...(value as ShareDomain[])];
}

function hasRepeat(domains: readonly string[]): boolean {
  return new Set(domains).size !== domains.length;
}

function isSubset(
  inner: readonly string[],
  outer: readonly string[] | null,
): boolean {
  if (outer === null) return true;
  const set = new Set(outer);
  return inner.every((domain) => set.has(domain));
}

/**
 * One entry, checked field by field and copied out with only the fields the
 * contract names (unknown keys are dropped, as the schema strips them), or
 * null. The invariants after the field checks are the schema's refinements.
 */
function parseEntry(value: unknown): AccountAccessEntry | null {
  if (!isRecord(value)) return null;
  const {
    accountId,
    username,
    displayName,
    fullName,
    access,
    level,
    recordKind,
    sections: rawSections,
    canWrite,
    writableDomains: rawWritable,
    manageableDomains: rawManageable,
  } = value;
  if (!isNonEmptyString(accountId) || !isNonEmptyString(username)) return null;
  if (!isNullableString(displayName) || !isNullableString(fullName)) {
    return null;
  }
  if (access !== "read" && access !== "write") return null;
  if (level !== "read" && level !== "write" && level !== "manage") return null;
  if (recordKind !== "shared" && recordKind !== "managed") return null;
  const sections = rawSections === null ? null : domainList(rawSections);
  if (rawSections !== null && sections === null) return null;
  if (typeof canWrite !== "boolean") return null;
  const writableDomains = domainList(rawWritable);
  const manageableDomains = domainList(rawManageable);
  if (writableDomains === null || manageableDomains === null) return null;

  const isManage = level === "manage";
  if (sections !== null && hasRepeat(sections)) return null;
  if (isManage && (access !== "write" || sections !== null)) return null;
  if (canWrite !== (level !== "read")) return null;
  if (!isManage && access !== level) return null;
  if (hasRepeat(writableDomains) || hasRepeat(manageableDomains)) return null;
  if (
    !isSubset(writableDomains, sections) ||
    !isSubset(manageableDomains, sections)
  ) {
    return null;
  }
  if (!isSubset(manageableDomains, writableDomains)) return null;
  if (level === "read" && writableDomains.length > 0) return null;
  if (!isManage && manageableDomains.length > 0) return null;

  return {
    accountId,
    username,
    displayName,
    fullName,
    access,
    level,
    recordKind,
    sections,
    canWrite,
    writableDomains,
    manageableDomains,
  };
}

/**
 * The block's structure, without the cross-entry checks: what the schema
 * accepts, and the same stripped value it returns. Exported for the
 * equivalence test; the app calls {@link parseAccountAccess}.
 */
export function validateAccountAccessBlock(
  value: unknown,
): AccountAccess | null {
  if (!isRecord(value)) return null;
  const {
    accounts: rawAccounts,
    active: rawActive,
    recordKind,
    canSwitch,
  } = value;
  if (!Array.isArray(rawAccounts)) return null;
  const accounts: AccountAccessEntry[] = [];
  for (const raw of rawAccounts) {
    const entry = parseEntry(raw);
    if (!entry) return null;
    accounts.push(entry);
  }
  const active = rawActive === null ? null : parseEntry(rawActive);
  if (rawActive !== null && active === null) return null;
  if (
    recordKind !== "self" &&
    recordKind !== "shared" &&
    recordKind !== "managed"
  ) {
    return null;
  }
  if (typeof canSwitch !== "boolean") return null;
  return { accounts, active, recordKind, canSwitch };
}

/** Both published views of the active record must name the same resolved grant. */
function sameEntry(a: AccountAccessEntry, b: AccountAccessEntry): boolean {
  const sameList = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((domain, index) => domain === y[index]);
  const sameSections =
    a.sections === null || b.sections === null
      ? a.sections === b.sections
      : sameList(a.sections, b.sections);
  return (
    sameList(a.writableDomains, b.writableDomains) &&
    sameList(a.manageableDomains, b.manageableDomains) &&
    a.accountId === b.accountId &&
    a.username === b.username &&
    a.displayName === b.displayName &&
    a.fullName === b.fullName &&
    a.access === b.access &&
    a.level === b.level &&
    a.recordKind === b.recordKind &&
    a.canWrite === b.canWrite &&
    sameSections
  );
}

/** Parse the server-resolved access block as a closed presentation contract. */
export function parseAccountAccess(value: unknown): AccountAccess | null {
  const block = validateAccountAccessBlock(value);
  if (!block) return null;

  const { accounts, active, recordKind, canSwitch } = block;
  const accountIds = new Set(accounts.map((entry) => entry.accountId));
  if (
    accountIds.size !== accounts.length ||
    canSwitch !== accounts.length > 0
  ) {
    return null;
  }

  if (active === null) {
    return recordKind === "self"
      ? { accounts, active: null, recordKind, canSwitch }
      : null;
  }

  if (!accountIds.has(active.accountId) || recordKind !== active.recordKind) {
    return null;
  }

  const canonicalActive = accounts.find(
    (entry) => entry.accountId === active.accountId,
  );
  if (!canonicalActive || !sameEntry(active, canonicalActive)) return null;

  return { accounts, active: canonicalActive, recordKind, canSwitch };
}
