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
 */
import { describe, expect, it } from "vitest";

import { resolveRecordCapabilities } from "@/hooks/use-record-capabilities";
import type { AccountAccessEntry } from "@/lib/sharing/account-access-view";

const READ_ONLY: AccountAccessEntry = {
  accountId: "acct-owner",
  username: "owner",
  displayName: "Margarethe",
  access: "read",
  level: "read",
  sections: null,
  canWrite: false,
};

const WRITABLE: AccountAccessEntry = {
  ...READ_ONLY,
  access: "write",
  level: "write",
  canWrite: true,
};

const MANAGING: AccountAccessEntry = {
  ...READ_ONLY,
  access: "manage",
  level: "manage",
  canWrite: true,
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
    expect(resolveRecordCapabilities(null)).toEqual({
      inSharedRecord: false,
      canWrite: false,
      canAdd: true,
      canManage: true,
      // No grant, so no level and no narrowing — not a fabricated "manage"
      // over all eight sections, which a consumer would then have to tell
      // apart from a real one.
      level: null,
      sections: null,
    });
    expect(resolveRecordCapabilities(undefined)).toEqual(
      resolveRecordCapabilities(null),
    );
  });

  it("a read-only delegate adds nothing", () => {
    expect(resolveRecordCapabilities(READ_ONLY)).toEqual({
      inSharedRecord: true,
      canWrite: false,
      canAdd: false,
      canManage: false,
      level: "read",
      sections: null,
    });
  });

  it("a delegate may not change what is already there", () => {
    // The asymmetry the whole design rests on: a WRITE grant adds, and that
    // is all it does. Not even to an entry the delegate made a minute ago.
    expect(resolveRecordCapabilities(WRITABLE)).toEqual({
      inSharedRecord: true,
      canWrite: true,
      canAdd: true,
      canManage: false,
      level: "write",
      sections: null,
    });
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

  it("does not hand a manage grant the affordances its routes cannot answer yet", () => {
    // The deliberate gap, pinned so it cannot close by accident. MANAGE will
    // bring the edit and delete controls back, and it does so in the release
    // where the routes behind them answer — not in the one that merely
    // publishes the level. A `canManage: true` here today would paint
    // controls that 403, which is the exact failure these booleans exist to
    // prevent.
    expect(resolveRecordCapabilities(MANAGING)).toEqual({
      inSharedRecord: true,
      canWrite: true,
      canAdd: true,
      canManage: false,
      level: "manage",
      sections: null,
    });
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
  });
});
