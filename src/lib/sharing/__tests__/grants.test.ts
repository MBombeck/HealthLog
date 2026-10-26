/**
 * The account-grant state machine, tested where it is pure.
 *
 * Everything that asserts what lands in the database lives in
 * `tests/integration/account-grant-lifecycle.test.ts` against real Postgres —
 * the partial unique index, the conditional-update claims and both cascade
 * directions are properties of the database, and a fake client that ignores
 * `where` would report all three as working.
 *
 * What is left here is the decision itself: given a row, what does it confer?
 * That question has no database in it, and it is the one the resolver asks on
 * every single request.
 */
import { describe, expect, it } from "vitest";

import { inviteGrant } from "@/lib/sharing/grants";
import {
  grantAllows,
  grantCoversDomain,
  grantState,
  isGrantActive,
  normaliseScope,
  type GrantLifecycle,
} from "@/lib/sharing/grant-access";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";
import { Prisma } from "@/generated/prisma/client";
import type { AccountGrant } from "@/generated/prisma/client";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const EARLIER = new Date("2026-08-01T12:00:00.000Z");
const LATER = new Date("2026-08-03T12:00:00.000Z");

function grant(overrides: Partial<GrantLifecycle> = {}): GrantLifecycle {
  return {
    acceptedAt: EARLIER,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("grantState", () => {
  it("is ACTIVE once accepted, with no end date", () => {
    expect(grantState(grant(), NOW)).toBe("ACTIVE");
  });

  it("is PENDING until the delegate accepts", () => {
    expect(grantState(grant({ acceptedAt: null }), NOW)).toBe("PENDING");
  });

  it("is EXPIRED once the lapse instant has arrived", () => {
    // The named instant is the first instant the grant no longer holds, the
    // same boundary the Bearer-token expiry uses.
    expect(grantState(grant({ expiresAt: NOW }), NOW)).toBe("EXPIRED");
    expect(grantState(grant({ expiresAt: EARLIER }), NOW)).toBe("EXPIRED");
    expect(grantState(grant({ expiresAt: LATER }), NOW)).toBe("ACTIVE");
  });

  it("is EXPIRED rather than PENDING for an invitation that lapsed", () => {
    // The distinction is load-bearing: an invitation past its date can no
    // longer be accepted, and calling it PENDING would say the opposite.
    expect(
      grantState(grant({ acceptedAt: null, expiresAt: EARLIER }), NOW),
    ).toBe("EXPIRED");
  });

  it("is REVOKED even when it also sat past its expiry", () => {
    // Somebody ended it. The record says so, rather than attributing the end
    // to a calendar.
    expect(
      grantState(grant({ revokedAt: EARLIER, expiresAt: EARLIER }), NOW),
    ).toBe("REVOKED");
  });

  it("is REVOKED for a pending invitation the owner withdrew", () => {
    expect(
      grantState(grant({ acceptedAt: null, revokedAt: EARLIER }), NOW),
    ).toBe("REVOKED");
  });
});

describe("isGrantActive", () => {
  it("confers nothing while pending", () => {
    expect(isGrantActive(grant({ acceptedAt: null }), NOW)).toBe(false);
  });

  it("confers nothing once revoked", () => {
    expect(isGrantActive(grant({ revokedAt: EARLIER }), NOW)).toBe(false);
  });

  it("confers nothing once expired", () => {
    expect(isGrantActive(grant({ expiresAt: EARLIER }), NOW)).toBe(false);
  });

  it("stops conferring the moment the clock passes the expiry", () => {
    // Live, not swept: the same unchanged row answers differently as the
    // clock moves, with nothing having run in between.
    const lapsing = grant({ expiresAt: NOW });
    expect(isGrantActive(lapsing, EARLIER)).toBe(true);
    expect(isGrantActive(lapsing, NOW)).toBe(false);
  });

  it("confers access when accepted, live and unexpired", () => {
    expect(isGrantActive(grant({ expiresAt: LATER }), NOW)).toBe(true);
  });
});

describe("grantAllows", () => {
  it("lets a READ grant read and refuses it a write", () => {
    const read = { ...grant(), access: "READ" as const };
    expect(grantAllows(read, "read", NOW)).toBe(true);
    expect(grantAllows(read, "write", NOW)).toBe(false);
  });

  it("lets a WRITE grant do both", () => {
    const write = { ...grant(), access: "WRITE" as const };
    expect(grantAllows(write, "read", NOW)).toBe(true);
    expect(grantAllows(write, "write", NOW)).toBe(true);
  });

  it("refuses a WRITE grant that is not active", () => {
    // The level never outranks the state. A revoked WRITE grant is a revoked
    // grant.
    const revoked = {
      ...grant({ revokedAt: EARLIER }),
      access: "WRITE" as const,
    };
    expect(grantAllows(revoked, "read", NOW)).toBe(false);
    expect(grantAllows(revoked, "write", NOW)).toBe(false);
  });

  it("refuses a pending grant at every level", () => {
    for (const access of ["READ", "WRITE"] as const) {
      const pending = { ...grant({ acceptedAt: null }), access };
      expect(grantAllows(pending, "read", NOW)).toBe(false);
      expect(grantAllows(pending, "write", NOW)).toBe(false);
    }
  });
});

/**
 * The level the caller offered is the level the row is written with.
 *
 * A capture client rather than a database: what is asserted here is the `data`
 * object this module hands the client, which is the one thing a fake can see
 * honestly. That the column then holds the value, that the enum accepts it and
 * that the partial unique index still applies are properties of Postgres and
 * live in `tests/integration/account-grant-lifecycle.test.ts` — a fake that
 * returned whatever it was given would report all three as working.
 *
 * There is no upgrade test because there is no upgrade: no function in this
 * module raises the level of a row that exists, and the way to a wider grant
 * is a new invitation the delegate accepts again.
 */
describe("inviteGrant", () => {
  function captureDb(): {
    db: Pick<Prisma.TransactionClient, "accountGrant" | "auditLog">;
    writes: Array<{
      access: string;
      grantorId: string;
      granteeId: string;
      scopeJson: unknown;
    }>;
  } {
    const writes: Array<{
      access: string;
      grantorId: string;
      granteeId: string;
      scopeJson: unknown;
    }> = [];
    const db = {
      accountGrant: {
        // No expired live-pair row in these fixtures, so the pre-create sweep
        // closes nothing and the audit branch is never reached.
        updateMany: async () => ({ count: 0 }),
        create: async (args: {
          data: {
            access: string;
            grantorId: string;
            granteeId: string;
            scopeJson: unknown;
          };
        }) => {
          writes.push(args.data);
          return { id: "grant-1", ...args.data } as unknown as AccountGrant;
        },
      },
    } as unknown as Pick<Prisma.TransactionClient, "accountGrant" | "auditLog">;
    return { db, writes };
  }

  it("writes the level it was given", async () => {
    for (const access of ["READ", "WRITE"] as const) {
      const { db, writes } = captureDb();
      const row = await inviteGrant(
        { grantorId: "owner", granteeId: "delegate", access, scope: null },
        db,
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].access).toBe(access);
      expect(row.access).toBe(access);
    }
  });

  it("still refuses a self-grant before anything is written", async () => {
    const { db, writes } = captureDb();
    await expect(
      inviteGrant(
        { grantorId: "solo", granteeId: "solo", access: "WRITE", scope: null },
        db,
      ),
    ).rejects.toMatchObject({ code: "self_grant" });
    expect(writes).toHaveLength(0);
  });

  it("confers the offered level only after acceptance", () => {
    // The two halves of the write consent, as the state machine sees them: the
    // owner's is the row, the delegate's is `acceptedAt`. Neither alone is
    // enough, and the pending row proves it.
    const offered = {
      revokedAt: null,
      expiresAt: null,
      access: "WRITE" as const,
    };
    expect(grantAllows({ ...offered, acceptedAt: null }, "write", NOW)).toBe(
      false,
    );
    expect(grantAllows({ ...offered, acceptedAt: EARLIER }, "write", NOW)).toBe(
      true,
    );
  });
});

/**
 * v1.37.0 — the third level.
 *
 * `grantAllows` is a total order over three levels now, and the one comparison
 * that carries the level's meaning is the one that must NOT hold: an accepted
 * WRITE grant carries a consent to add, and nothing about it carries a consent
 * to rewrite or remove.
 */
describe("grantAllows, at MANAGE", () => {
  it("lets a MANAGE grant do all three", () => {
    const manage = { ...grant(), access: "MANAGE" as const };
    expect(grantAllows(manage, "read", NOW)).toBe(true);
    expect(grantAllows(manage, "write", NOW)).toBe(true);
    expect(grantAllows(manage, "manage", NOW)).toBe(true);
  });

  it("refuses a WRITE grant the manage need", () => {
    const write = { ...grant(), access: "WRITE" as const };
    expect(grantAllows(write, "write", NOW)).toBe(true);
    expect(grantAllows(write, "manage", NOW)).toBe(false);
  });

  it("refuses a READ grant the manage need", () => {
    expect(grantAllows({ ...grant(), access: "READ" }, "manage", NOW)).toBe(
      false,
    );
  });

  it("refuses every need on a MANAGE grant that is not active", () => {
    // The state outranks the level, at the top of the order as at the bottom.
    for (const ended of [
      grant({ revokedAt: EARLIER }),
      grant({ acceptedAt: null }),
      grant({ expiresAt: EARLIER }),
    ]) {
      const dead = { ...ended, access: "MANAGE" as const };
      expect(grantAllows(dead, "read", NOW)).toBe(false);
      expect(grantAllows(dead, "write", NOW)).toBe(false);
      expect(grantAllows(dead, "manage", NOW)).toBe(false);
    }
  });
});

/**
 * The fail-closed normaliser.
 *
 * This is the one function in the feature whose failure mode is silent and
 * wide: a value it misreads as permissive opens sections the owner never
 * ticked, on every request, with nothing to see. So the tests below are
 * mostly about garbage, and every one of them asserts the same thing — that
 * a value the function cannot read opens NOTHING.
 */
describe("normaliseScope", () => {
  it("reads NULL as the entire record", () => {
    // Not a default standing in for a missing answer: it is the answer every
    // grant written before the column existed was consented as.
    expect(normaliseScope(null)).toBeNull();
  });

  it("reads a well-formed array as exactly those sections", () => {
    const scope = normaliseScope(["labs", "medications"]);
    expect(scope).not.toBeNull();
    expect([...(scope as ReadonlySet<string>)].sort()).toEqual([
      "labs",
      "medications",
    ]);
  });

  it("accepts every member of the production vocabulary", () => {
    // Non-zero proof for the negatives below: the function CAN say yes, to
    // each of the eight, so a wholesale refusal would fail here rather than
    // read as caution.
    expect(SHARE_DOMAINS.length).toBeGreaterThan(0);
    for (const domain of SHARE_DOMAINS) {
      expect([...(normaliseScope([domain]) as ReadonlySet<string>)]).toEqual([
        domain,
      ]);
    }
  });

  it("resolves every malformed value to the empty set", () => {
    const garbage: Prisma.JsonValue[] = [
      "garbage",
      "",
      42,
      true,
      false,
      {},
      { measurements: true },
      [],
      ["measurements", "not-a-domain"],
      ["not-a-domain"],
      ["record"],
      [null],
      [1],
      [["measurements"]],
      [{ key: "measurements" }],
    ];

    for (const blob of garbage) {
      const scope = normaliseScope(blob);
      // Not null — null is "everything", and that is the answer this function
      // must never give to something it could not read.
      expect(scope, JSON.stringify(blob)).not.toBeNull();
      expect((scope as ReadonlySet<string>).size, JSON.stringify(blob)).toBe(0);
    }
  });

  it("gives no partial credit to a half-recognisable set", () => {
    // The tempting reading is "honour what we understand". It is the wrong
    // one: a set written in a shape this file does not understand is not a
    // consent to guess at.
    const scope = normaliseScope(["labs", "medications", "unknown"]);
    expect((scope as ReadonlySet<string>).has("labs")).toBe(false);
    expect((scope as ReadonlySet<string>).size).toBe(0);
  });
});

describe("grantCoversDomain", () => {
  it("covers every section, and the record, when the scope is NULL", () => {
    for (const domain of SHARE_DOMAINS) {
      expect(grantCoversDomain({ scopeJson: null }, domain)).toBe(true);
    }
    expect(grantCoversDomain({ scopeJson: null }, "record")).toBe(true);
  });

  it("covers the sections it names and no others", () => {
    const scoped = { scopeJson: ["medications"] };
    expect(grantCoversDomain(scoped, "medications")).toBe(true);
    expect(grantCoversDomain(scoped, "measurements")).toBe(false);
    expect(grantCoversDomain(scoped, "labs")).toBe(false);
  });

  it("never covers the record, however wide the scope", () => {
    // The invariant. A route declaring `record` reads across sections, and
    // there is no honest answer to one of those for a delegate who was given
    // part of a record — a score that says 70 to the owner and 64 to the
    // delegate is a support case and a clinical hazard. Even a scope naming
    // all eight sections is refused: it is a narrowing, and a narrowing is
    // not the whole.
    expect(grantCoversDomain({ scopeJson: [...SHARE_DOMAINS] }, "record")).toBe(
      false,
    );
  });

  it("covers nothing at all when the stored scope is unreadable", () => {
    const broken = { scopeJson: "garbage" };
    for (const domain of SHARE_DOMAINS) {
      expect(grantCoversDomain(broken, domain)).toBe(false);
    }
    expect(grantCoversDomain(broken, "record")).toBe(false);
  });

  it("does not cover a section that postdates the invitation", () => {
    // A grant written when the vocabulary was shorter opens what it named and
    // nothing added since, which is what makes a new section a consent
    // question rather than a schema question.
    expect(grantCoversDomain({ scopeJson: ["labs"] }, "cycle")).toBe(false);
  });
});

describe("inviteGrant, on scope", () => {
  function captureScopeDb(): {
    db: Pick<Prisma.TransactionClient, "accountGrant" | "auditLog">;
    writes: Array<{ scopeJson: unknown }>;
  } {
    const writes: Array<{ scopeJson: unknown }> = [];
    const db = {
      accountGrant: {
        updateMany: async () => ({ count: 0 }),
        create: async (args: { data: { scopeJson: unknown } }) => {
          writes.push(args.data);
          return { id: "grant-1", ...args.data } as unknown as AccountGrant;
        },
      },
    } as unknown as Pick<Prisma.TransactionClient, "accountGrant" | "auditLog">;
    return { db, writes };
  }

  const pair = { grantorId: "owner", granteeId: "delegate" } as const;

  it("writes SQL NULL, not the JSON value null, for the entire record", () => {
    // One keystroke apart and opposite in meaning: a stored JSON `null` is not
    // an array, so it would resolve to the empty set — a grant that opens
    // nothing, written by the path meant to open everything.
    const { db, writes } = captureScopeDb();
    return inviteGrant({ ...pair, access: "READ", scope: null }, db).then(
      () => {
        expect(writes).toHaveLength(1);
        expect(writes[0].scopeJson).toBe(Prisma.DbNull);
        expect(writes[0].scopeJson).not.toBeNull();
      },
    );
  });

  it("refuses duplicate sections rather than widening their meaning", async () => {
    const { db, writes } = captureScopeDb();
    await expect(
      inviteGrant(
        { ...pair, access: "WRITE", scope: ["labs", "medications", "labs"] },
        db,
      ),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(writes).toHaveLength(0);
  });

  it("refuses a scope that cannot mean anything, before anything is written", async () => {
    const refused = [
      { access: "READ" as const, scope: [] },
      {
        access: "READ" as const,
        scope: ["not-a-domain"] as unknown as ["labs"],
      },
      { access: "READ" as const, scope: ["record"] as unknown as ["labs"] },
      // Whole-record by construction: management of part of a record is a
      // boundary the product does not promise, so this file does not store it.
      { access: "MANAGE" as const, scope: ["labs" as const] },
    ];

    for (const input of refused) {
      const { db, writes } = captureScopeDb();
      await expect(
        inviteGrant({ ...pair, ...input }, db),
        JSON.stringify(input),
      ).rejects.toMatchObject({ code: "invalid_scope" });
      // The refusal did not apply: nothing reached the table.
      expect(writes, JSON.stringify(input)).toHaveLength(0);
    }
  });

  it("still mints a MANAGE grant when no scope is named", async () => {
    // The negative above is about the pairing, not about the level. Without
    // this leg the four refusals could all be "MANAGE is refused", which is
    // not the rule.
    const { db, writes } = captureScopeDb();
    await inviteGrant({ ...pair, access: "MANAGE", scope: null }, db);
    expect(writes).toHaveLength(1);
    expect(writes[0].scopeJson).toBe(Prisma.DbNull);
  });
});
