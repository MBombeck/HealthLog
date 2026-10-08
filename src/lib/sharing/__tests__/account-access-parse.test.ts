import { describe, expect, it } from "vitest";

import {
  parseAccountAccess,
  validateAccountAccessBlock,
} from "../account-access-parse";
import { accountAccessBlockSchema } from "../account-access-schema";

const sharedEntry = {
  accountId: "record-a",
  username: "record-a",
  displayName: "Record A",
  fullName: "Test Full Name",
  access: "read",
  level: "read",
  recordKind: "shared",
  sections: ["labs"],
  canWrite: false,
  writableDomains: [],
  manageableDomains: [],
};

function accessBlock(overrides: Record<string, unknown> = {}) {
  return {
    accounts: [sharedEntry],
    active: sharedEntry,
    recordKind: "shared",
    canSwitch: true,
    ...overrides,
  };
}

describe("parseAccountAccess", () => {
  it("preserves canonical shared payloads, including an empty scope", () => {
    const scoped = parseAccountAccess(accessBlock());
    const empty = parseAccountAccess(
      accessBlock({
        accounts: [{ ...sharedEntry, sections: [] }],
        active: { ...sharedEntry, sections: [] },
      }),
    );

    expect(scoped?.active?.sections).toEqual(["labs"]);
    expect(empty?.active?.sections).toEqual([]);
  });

  it("preserves the canonical manage compatibility fields", () => {
    const manager = {
      ...sharedEntry,
      access: "write",
      level: "manage",
      sections: null,
      canWrite: true,
      writableDomains: ["measurements", "mind"],
      manageableDomains: ["mind"],
    };

    const parsed = parseAccountAccess(
      accessBlock({ accounts: [manager], active: manager }),
    );

    expect(parsed?.active).toMatchObject({
      level: "manage",
      access: "write",
      sections: null,
      canWrite: true,
      writableDomains: ["measurements", "mind"],
      manageableDomains: ["mind"],
    });
  });

  it("keeps the delegated write lists when they are consistent with the grant", () => {
    const writer = {
      ...sharedEntry,
      access: "write",
      level: "write",
      sections: ["labs", "measurements"],
      canWrite: true,
      writableDomains: ["measurements", "labs"],
      manageableDomains: [],
    };
    const parsed = parseAccountAccess(
      accessBlock({ accounts: [writer], active: writer }),
    );
    expect(parsed?.active?.writableDomains).toEqual(["measurements", "labs"]);
    expect(parsed?.active?.manageableDomains).toEqual([]);
  });

  it.each([
    [
      "legacy access and resolved level",
      { access: "write", level: "write", canWrite: true },
      {},
    ],
    ["record kind", { recordKind: "managed" }, { recordKind: "managed" }],
    ["scope", { sections: ["measurements"] }, {}],
    [
      "resolved write capability",
      { access: "write", level: "write", canWrite: true },
      {},
    ],
    ["username", { username: "different-record" }, {}],
    ["display name", { displayName: "Different record" }, {}],
    // v1.37.2 — the owner's full name is part of the entry now, so the two
    // published views of the active record must agree on it like every other
    // field. A parity matcher blind to it would let the banner and the
    // switcher name the same owner differently.
    ["full name", { fullName: "Different name" }, {}],
    // v1.38.12 — the two lists are read by every control, so the two views
    // must agree on them like on every other field.
    [
      "writable domains",
      {
        access: "write",
        level: "write",
        canWrite: true,
        writableDomains: ["labs"],
      },
      {
        accounts: [
          {
            ...sharedEntry,
            access: "write",
            level: "write",
            canWrite: true,
            writableDomains: [],
          },
        ],
      },
    ],
  ])(
    "fails closed when active disagrees with its canonical entry on %s",
    (_field, activeOverrides, blockOverrides) => {
      const active = { ...sharedEntry, ...activeOverrides };
      const block = accessBlock({ active, ...blockOverrides });

      expect(parseAccountAccess(block)).toBeNull();
    },
  );

  it.each([
    ["unknown level", { level: "owner" }],
    ["unknown record kind", { recordKind: "other" }],
    ["unknown section", { sections: ["other"] }],
    ["duplicated section", { sections: ["labs", "labs"] }],
    ["non-array section", { sections: "labs" }],
    ["read marked writable", { canWrite: true }],
    ["write marked read-only", { access: "write", level: "write" }],
    [
      "scoped manage",
      { access: "write", level: "manage", sections: ["labs"], canWrite: true },
    ],
    [
      "manage with read legacy field",
      { access: "read", level: "manage", sections: null, canWrite: true },
    ],
    // v1.38.12 — structural invariants of the two lists. Which sections
    // qualify is the server's table and is not re-decided here; what IS
    // checked is that the lists cannot claim more than the grant.
    ["read grant with a writable domain", { writableDomains: ["labs"] }],
    [
      "write grant with a manageable domain",
      {
        access: "write",
        level: "write",
        canWrite: true,
        writableDomains: ["labs"],
        manageableDomains: ["labs"],
      },
    ],
    [
      "manageable domain that is not writable",
      {
        access: "write",
        level: "manage",
        sections: null,
        canWrite: true,
        writableDomains: ["labs"],
        manageableDomains: ["mind"],
      },
    ],
    [
      "writable domain outside the grant's sections",
      {
        access: "write",
        level: "write",
        canWrite: true,
        writableDomains: ["measurements"],
      },
    ],
    [
      "duplicated writable domain",
      {
        access: "write",
        level: "write",
        canWrite: true,
        writableDomains: ["labs", "labs"],
      },
    ],
    ["unknown writable domain", { writableDomains: ["other"] }],
    ["missing writable domains", { writableDomains: undefined }],
  ])("fails closed for %s entries", (_name, entryOverrides) => {
    const entry = { ...sharedEntry, ...entryOverrides };

    expect(
      parseAccountAccess(accessBlock({ accounts: [entry], active: entry })),
    ).toBeNull();
  });

  it("fails closed for a stale active entry or a contradictory switch block", () => {
    expect(
      parseAccountAccess(
        accessBlock({ active: { ...sharedEntry, accountId: "stale-record" } }),
      ),
    ).toBeNull();
    expect(parseAccountAccess(accessBlock({ canSwitch: false }))).toBeNull();
    expect(
      parseAccountAccess({
        accounts: [],
        active: null,
        recordKind: "self",
        canSwitch: true,
      }),
    ).toBeNull();
  });
});

/**
 * The browser parse carries no Zod (it rides the shell every route shares),
 * so it is a second statement of the published schema. This holds the two to
 * one verdict: over every fixture below, and every single-field breakage of
 * each, the hand-written check accepts exactly what the schema accepts and
 * returns the same stripped value. Change one without the other and this
 * fails with the input that tells them apart.
 */
describe("validateAccountAccessBlock agrees with the published schema", () => {
  const BAD_VALUES: unknown[] = [
    undefined,
    null,
    0,
    1,
    true,
    "",
    "bogus",
    [],
    ["labs"],
    ["labs", "labs"],
    ["nope"],
    {},
  ];

  const managerEntry = {
    ...sharedEntry,
    accountId: "record-m",
    username: "record-m",
    access: "write",
    level: "manage",
    recordKind: "managed",
    sections: null,
    canWrite: true,
    writableDomains: ["measurements", "mind"],
    manageableDomains: ["measurements"],
  };
  const writerEntry = {
    ...sharedEntry,
    accountId: "record-w",
    username: "record-w",
    access: "write",
    level: "write",
    sections: ["labs", "measurements"],
    canWrite: true,
    writableDomains: ["measurements"],
  };

  const bases: Record<string, unknown>[] = [
    accessBlock(),
    { accounts: [], active: null, recordKind: "self", canSwitch: false },
    {
      accounts: [managerEntry, writerEntry],
      active: null,
      recordKind: "self",
      canSwitch: true,
    },
    {
      accounts: [writerEntry],
      active: { ...writerEntry, extra: "stripped" },
      recordKind: "shared",
      canSwitch: true,
    },
  ];

  function variants(): unknown[] {
    const out: unknown[] = [...bases, null, "x", [], 42];
    for (const base of bases) {
      for (const key of Object.keys(base)) {
        for (const bad of BAD_VALUES) out.push({ ...base, [key]: bad });
      }
      const accounts = base.accounts as Record<string, unknown>[];
      accounts.forEach((entry, index) => {
        for (const key of [...Object.keys(entry), "unknownKey"]) {
          for (const bad of BAD_VALUES) {
            const broken = { ...entry, [key]: bad };
            const next = [...accounts];
            next[index] = broken;
            out.push({ ...base, accounts: next });
            if (base.active) out.push({ ...base, active: broken });
          }
        }
      });
    }
    return out;
  }

  it("accepts and rejects the same blocks, with the same output", () => {
    const corpus = variants();
    expect(corpus.length).toBeGreaterThan(500);
    let accepted = 0;
    for (const input of corpus) {
      const zod = accountAccessBlockSchema.safeParse(input);
      const mine = validateAccountAccessBlock(input);
      expect(mine !== null, JSON.stringify(input)).toBe(zod.success);
      if (zod.success) {
        expect(mine, JSON.stringify(input)).toEqual(zod.data);
        accepted += 1;
      }
    }
    // Both arms exercised: the corpus is not all-reject or all-accept.
    expect(accepted).toBeGreaterThan(10);
    expect(accepted).toBeLessThan(corpus.length - 100);
  });
});
