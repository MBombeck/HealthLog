/**
 * The account-access block's contract as a Zod schema, for the OpenAPI
 * document. The browser does not import it: its parse is the Zod-free
 * `account-access-parse.ts`, kept out of the shell every route shares, and
 * `account-access-parse.test.ts` holds the two to the same verdicts.
 */
import { z } from "zod/v4";

import { SHARE_DOMAINS } from "./scope";

const accountAccessLevelSchema = z.enum(["read", "write", "manage"]);
const accountRecordKindSchema = z.enum(["shared", "managed"]);
const shareSectionsSchema = z.array(z.enum(SHARE_DOMAINS)).nullable();
const shareDomainListSchema = z.array(z.enum(SHARE_DOMAINS));

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

/** One account-access entry, as OpenAPI publishes it. */
export const accountAccessEntrySchema = z
  .object({
    accountId: z.string().min(1),
    username: z.string().min(1),
    displayName: z.string().nullable(),
    // v1.37.2 — the record owner's full name, shown in front of a delegate on
    // the switcher + banner. A deliberate disclosure to everyone they share
    // with; see `accountLabel`.
    fullName: z.string().nullable(),
    access: z.enum(["read", "write"]),
    level: accountAccessLevelSchema,
    recordKind: accountRecordKindSchema,
    sections: shareSectionsSchema,
    canWrite: z.boolean(),
    // v1.38.12 — the sections the grant can add to / change, resolved
    // server-side. Structural invariants only are checked here; which
    // sections qualify is the server's table and is not re-decided.
    writableDomains: shareDomainListSchema,
    manageableDomains: shareDomainListSchema,
  })
  .superRefine((entry, ctx) => {
    const uniqueSections = new Set(entry.sections ?? []);
    if (uniqueSections.size !== (entry.sections?.length ?? 0)) {
      ctx.addIssue({
        code: "custom",
        message: "Account access sections must not repeat a domain",
        path: ["sections"],
      });
    }

    const isManage = entry.level === "manage";
    if (isManage && (entry.access !== "write" || entry.sections !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "Manage access must use legacy write access and whole scope",
      });
    }

    if (entry.canWrite !== (entry.level !== "read")) {
      ctx.addIssue({
        code: "custom",
        message: "Account access write flag disagrees with its level",
        path: ["canWrite"],
      });
    }

    if (!isManage && entry.access !== entry.level) {
      ctx.addIssue({
        code: "custom",
        message: "Legacy access must agree with the resolved level",
        path: ["access"],
      });
    }

    if (
      hasRepeat(entry.writableDomains) ||
      hasRepeat(entry.manageableDomains)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Delegated write domains must not repeat a domain",
        path: ["writableDomains"],
      });
    }
    if (
      !isSubset(entry.writableDomains, entry.sections) ||
      !isSubset(entry.manageableDomains, entry.sections)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Delegated write domains must lie within the grant's sections",
        path: ["writableDomains"],
      });
    }
    if (!isSubset(entry.manageableDomains, entry.writableDomains)) {
      ctx.addIssue({
        code: "custom",
        message: "Manageable domains must be writable domains",
        path: ["manageableDomains"],
      });
    }
    if (entry.level === "read" && entry.writableDomains.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "A read grant has no writable domains",
        path: ["writableDomains"],
      });
    }
    if (!isManage && entry.manageableDomains.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "Only a manage grant has manageable domains",
        path: ["manageableDomains"],
      });
    }
  });

export const accountAccessBlockSchema = z.object({
  accounts: z.array(accountAccessEntrySchema),
  active: accountAccessEntrySchema.nullable(),
  recordKind: z.enum(["self", "shared", "managed"]),
  canSwitch: z.boolean(),
});
