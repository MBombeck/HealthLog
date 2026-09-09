/**
 * What a delegation lets somebody do, pinned as a table.
 *
 * The hook itself is one line over `useAuth`; the decision lives in
 * `resolveRecordCapabilities`, which is pure and has exactly three inputs a
 * session can be in. So the contract is enumerated here rather than inferred
 * from a rendered page — and every affordance in the sweep binds one of these
 * two booleans, which is what makes the sweep provable at all.
 *
 * Mutation checks, run:
 *   - return `canManage: true` for a WRITE record → "a delegate may not change
 *     what is already there" goes red.
 *   - return `canAdd: true` for a READ record → "a read-only delegate adds
 *     nothing" goes red.
 *   - make the `!active` branch return `canAdd: false` → "the caller's own
 *     record keeps everything" goes red.
 *   - answer `canManageDomain` from `level === "manage"` instead of the list →
 *     "the vault is never manageable" goes red.
 */
import { describe, expect, it } from "vitest";

import {
  recordContextIsUnproven,
  resolveRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import type { AccountAccessEntry } from "@/lib/sharing/account-access-view";
import { delegatedDomains } from "@/lib/sharing/domain-write-support";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";

const READ_ONLY: AccountAccessEntry = {
  accountId: "acct-owner",
  username: "owner",
  displayName: "Margarethe",
  fullName: null,
  access: "read",
  level: "read",
  sections: null,
  recordKind: "shared",
  canWrite: false,
  writableDomains: [],
  manageableDomains: [],
};

// The lists are what the server publishes for each level over the whole
// record: the same helper `resolveAccountAccess` runs, so the fixture is the
// payload and not a guess at it.
const WRITABLE: AccountAccessEntry = {
  ...READ_ONLY,
  access: "write",
  level: "write",
  canWrite: true,
  writableDomains: delegatedDomains("write", null, "write"),
  manageableDomains: [],
};

const MANAGING: AccountAccessEntry = {
  ...READ_ONLY,
  access: "write",
  level: "manage",
  canWrite: true,
  writableDomains: delegatedDomains("manage", null, "write"),
  manageableDomains: delegatedDomains("manage", null, "manage"),
};

const SCOPED: AccountAccessEntry = {
  ...READ_ONLY,
  sections: ["medications", "labs"],
};

describe("resolveRecordCapabilities", () => {
  it("the caller's own record keeps everything", () => {
    // `null` is not "no access", it is "this is mine". Both an unswitched
    // session and a payload from a server that has never heard of sharing
    // land here, which is why the absent case must be the permissive one.
    const own = resolveRecordCapabilities(null);
    expect(own).toMatchObject({
      inSharedRecord: false,
      canWrite: false,
      canAdd: true,
      canManage: true,
      // No grant, so no level and no narrowing — not a fabricated "manage"
      // over all eight sections, which a consumer would then have to tell
      // apart from a real one.
      level: null,
      sections: null,
      recordKind: "self",
    });
    for (const domain of SHARE_DOMAINS) {
      expect(own.canWriteDomain(domain), domain).toBe(true);
      expect(own.canManageDomain(domain), domain).toBe(true);
    }
    expect(resolveRecordCapabilities(undefined)).toMatchObject({
      inSharedRecord: false,
      canAdd: true,
      canManage: true,
      recordKind: "self",
    });
  });

  it("refuses a malformed published block instead of treating it as own record", () => {
    const refused = resolveRecordCapabilities(null, true);
    expect(refused).toMatchObject({
      inSharedRecord: true,
      canWrite: false,
      canAdd: false,
      canManage: false,
      level: null,
      sections: [],
      recordKind: "shared",
      accessRefused: true,
    });
    for (const domain of SHARE_DOMAINS) {
      expect(refused.canWriteDomain(domain), domain).toBe(false);
      expect(refused.canManageDomain(domain), domain).toBe(false);
    }
  });

  it("a read-only delegate adds nothing", () => {
    const reader = resolveRecordCapabilities(READ_ONLY);
    expect(reader).toMatchObject({
      inSharedRecord: true,
      canWrite: false,
      canAdd: false,
      canManage: false,
      level: "read",
      sections: null,
      recordKind: "shared",
    });
    for (const domain of SHARE_DOMAINS) {
      expect(reader.canWriteDomain(domain), domain).toBe(false);
      expect(reader.canManageDomain(domain), domain).toBe(false);
    }
  });

  it("a delegate may not change what is already there", () => {
    // The asymmetry the whole design rests on: a WRITE grant adds, and that
    // is all it does. Not even to an entry the delegate made a minute ago.
    const writer = resolveRecordCapabilities(WRITABLE);
    expect(writer).toMatchObject({
      inSharedRecord: true,
      canWrite: true,
      canAdd: true,
      canManage: false,
      level: "write",
      sections: null,
      recordKind: "shared",
    });
    // Writable where a WRITE route exists, manageable nowhere.
    expect(writer.canWriteDomain("measurements")).toBe(true);
    expect(writer.canWriteDomain("labs")).toBe(true);
    expect(writer.canWriteDomain("mind")).toBe(false);
    expect(writer.canWriteDomain("documents")).toBe(false);
    for (const domain of SHARE_DOMAINS) {
      expect(writer.canManageDomain(domain), domain).toBe(false);
    }
  });

  it("carries the level and the sections through untouched", () => {
    // The two facts v1.37.0 adds are bound, not interpreted. `sections` is
    // the server's list in the server's order; `level` is the server's word.
    // Nothing here filters, sorts or re-spells either, because the moment
    // this file starts deriving from them it becomes the second program
    // deciding what a delegation covers.
    expect(resolveRecordCapabilities(SCOPED).sections).toEqual([
      "medications",
      "labs",
    ]);
    expect(resolveRecordCapabilities(MANAGING).level).toBe("manage");
  });

  it("hands a manage grant exactly the sections its routes answer for", () => {
    // The v1.37.0 hold-back answered `canManage: false` here until the routes
    // behind the edit and delete controls existed. They exist; the answer is
    // the server's per-section list, and the coarse boolean is "is that list
    // non-empty".
    const manager = resolveRecordCapabilities(MANAGING);
    expect(manager).toMatchObject({
      inSharedRecord: true,
      canWrite: true,
      canAdd: true,
      canManage: true,
      level: "manage",
      sections: null,
      recordKind: "shared",
    });
    expect(manager.canManageDomain("mind")).toBe(true);
    expect(manager.canManageDomain("profile")).toBe(true);
    expect(manager.canManageDomain("labs")).toBe(true);
    expect(manager.canWriteDomain("mind")).toBe(true);
  });

  it("never lets a shared record manage the vault", () => {
    // The vault has no delegated write route, so the server's list never
    // names it — and the hook binds the list rather than the level. Answering
    // from `level === "manage"` would paint the upload control that 403s.
    expect(
      resolveRecordCapabilities(MANAGING).canManageDomain("documents"),
    ).toBe(false);
    expect(
      resolveRecordCapabilities(MANAGING).canWriteDomain("documents"),
    ).toBe(false);
    const claimsEverything: AccountAccessEntry = {
      ...MANAGING,
      manageableDomains: [],
    };
    // An empty list from the server is an empty answer, whatever the level.
    const held = resolveRecordCapabilities(claimsEverything);
    expect(held.canManage).toBe(false);
    expect(held.canManageDomain("mind")).toBe(false);
  });

  it("binds the server's boolean rather than the grant's label", () => {
    // `access` is descriptive; `canWrite` is the resolved decision. A row that
    // says "write" while the server resolved false (lapsed, revoked mid-flight,
    // a level this build does not honour) must read as read-only, because two
    // programs deciding one person's access is how they end up disagreeing.
    const disagreeing: AccountAccessEntry = {
      ...READ_ONLY,
      access: "write",
      canWrite: false,
    };
    expect(resolveRecordCapabilities(disagreeing).canAdd).toBe(false);
    // The same posture for the lists: a scoped WRITE grant is writable only
    // where its list says so, not wherever its level would reach.
    const scopedWriter: AccountAccessEntry = {
      ...WRITABLE,
      sections: ["labs"],
      writableDomains: ["labs"],
    };
    expect(resolveRecordCapabilities(scopedWriter).canWriteDomain("labs")).toBe(
      true,
    );
    expect(
      resolveRecordCapabilities(scopedWriter).canWriteDomain("measurements"),
    ).toBe(false);
  });
});

/**
 * v1.37.0 — the record context has to be PROVABLE before the controls appear.
 *
 * `/api/auth/me` publishes the same question from two angles: `accountAccess.active`
 * is the re-decided answer (it survived a live-grant pass), and `recordSession.scope`
 * is the raw selector the fence compares a request's assertion against. When
 * they disagree the session is pointed at a record the grant no longer opens:
 * every delegable route will refuse, while `active` being null would otherwise
 * make this hook answer "your own record, all controls". That combination
 * paints an add button on a page whose every write is about to 403 — the exact
 * failure `canAdd` exists to end.
 */
describe("an unprovable record context withholds every control", () => {
  it("holds when the raw selector names a record the grant no longer opens", () => {
    expect(
      recordContextIsUnproven({ epoch: 3, scope: "acct-owner" }, null),
    ).toBe(true);
    const held = resolveRecordCapabilities(null, false, false, true);
    expect(held.canAdd).toBe(false);
    expect(held.canManage).toBe(false);
    // REFUSED, not pending. `recordSessionPending` renders a bare spinner with
    // no controls, which is right for a switch in flight and a wedge here: this
    // state reports the same thing on every `/api/auth/me`, so it never ends on
    // its own. `accessRefused` renders the door with the way back out.
    expect(held.accessRefused).toBe(true);
    expect(held.recordSessionPending).toBeUndefined();
  });

  it("routes an EXPIRED grant to the refusal door, not the spinner", () => {
    // The second trigger, and the one that arrives without anybody doing
    // anything: revocation clears the selector inside its transaction, expiry
    // does NOT. So the session stays pointed at a record whose grant has
    // lapsed, `/api/auth/me` resolves `active: null` because the entry no
    // longer survives the live-grant pass, and `recordSession.scope` still
    // names the owner. Every delegable read 403s from here.
    const expired = recordContextIsUnproven(
      { epoch: 3, scope: "acct-owner" },
      null,
    );
    expect(expired).toBe(true);
    const capabilities = resolveRecordCapabilities(null, false, false, expired);
    expect(capabilities.accessRefused).toBe(true);
    expect(capabilities.recordSessionPending).toBeUndefined();
    expect(capabilities.inSharedRecord).toBe(true);
  });

  it("holds when the resolved entry names a record the selector has left", () => {
    // The mirror image: the grant resolved, but the session is back on its own
    // record. Painting the owner's controls here would be the reverse mix-up.
    expect(recordContextIsUnproven({ epoch: 4, scope: null }, READ_ONLY)).toBe(
      true,
    );
  });

  it("agrees when both answers name the same record", () => {
    expect(
      recordContextIsUnproven(
        { epoch: 3, scope: READ_ONLY.accountId },
        READ_ONLY,
      ),
    ).toBe(false);
    expect(recordContextIsUnproven({ epoch: 0, scope: null }, null)).toBe(
      false,
    );
  });

  it("does not hold when there is no context to cross-check", () => {
    // Null is the Bearer transport (no session row, no switch state) and
    // undefined is a server image that predates the field. Neither is a
    // disagreement, and neither is a reason to blank the app for everybody.
    expect(recordContextIsUnproven(null, null)).toBe(false);
    expect(recordContextIsUnproven(undefined, READ_ONLY)).toBe(false);
    // The positive control for the two above: without it, a
    // `recordContextIsUnproven` that always returned false would pass them.
    expect(recordContextIsUnproven({ epoch: 1, scope: "someone" }, null)).toBe(
      true,
    );
  });

  it("leaves every existing arm untouched when the two agree", () => {
    // The fourth argument defaults to false, so every case above this block
    // means exactly what it meant before the fence existed.
    expect(resolveRecordCapabilities(READ_ONLY)).toMatchObject({
      ...resolveRecordCapabilities(READ_ONLY, false, false, false),
      canWriteDomain: expect.any(Function),
      canManageDomain: expect.any(Function),
    });
  });
});
