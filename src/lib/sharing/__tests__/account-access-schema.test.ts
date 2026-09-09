import { describe, expect, it } from "vitest";

import { parseAccountAccess } from "../account-access-schema";

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
