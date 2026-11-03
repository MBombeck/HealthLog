/**
 * The record-session fence against real Postgres, real routes and the real
 * resolver.
 *
 * ## Why a status code is not the proof
 *
 * "The request 409s" passes wherever the fence sits — above the grant lookup,
 * below it, or after the handler has already read the record. What has to be
 * proved is that a refused request did NO WORK against the record, and this
 * file uses the two side effects `resolveSwitchedRecord` performs immediately
 * after admission as the instrument:
 *
 *   * `AccountGrant.lastUsedAt` is stamped by `touchGrantUsage`;
 *   * a day-coalesced `audit_logs` row with `action = 'sharing.record.accessed'`
 *     is written by `recordDelegatedAccess`.
 *
 * Both run only past admission, so their ABSENCE is the negative instrument and
 * their PRESENCE is the positive control. They are fire-and-forget, so the
 * negative assertion is immediate while the positive one polls briefly. Prisma
 * query logging is not an option here: `src/lib/db.ts` builds the client with no
 * `log` config, so `prisma.$on("query")` does not exist.
 *
 * ## The positive controls, which are half the file
 *
 * A fence that refused everything would pass every negative assertion in this
 * plan. So three exemptions are proved explicitly rather than by absence:
 * a Bearer request with no fence header is served (FENCE-AC-10), a cookie
 * session at `record_epoch = 0` with no fence header is served (FENCE-AC-10),
 * and a matching assertion is served with both side effects present
 * (FENCE-AC-04).
 *
 * Break this file by deleting the `assertRecordSessionFence(auth)` line from
 * `requireRecordAuth`: the stale leg fails both on the status and on
 * `lastUsedAt` having moved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest, NextResponse } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";
import {
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_BOOTSTRAP,
  RECORD_FENCE_ERROR_CODE,
  RECORD_SCOPE_HEADER,
  RECORD_SCOPE_SELF,
} from "@/lib/sharing/record-session-fence-contract";
import { pointSessionAtIfUnchanged } from "@/lib/sharing/acting-session";
import {
  acceptGrant,
  inviteGrant,
  revokeGrant,
  revokeGrantAndClearSwitch,
} from "@/lib/sharing/grants";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `fence-${suffix}`,
      email: `fence-${suffix}@example.test`,
      role: "USER",
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function mintToken(userId: string): Promise<string> {
  const raw = `hlk_${userId}-${counter++}`.padEnd(20, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "record-session-fence-test",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  return raw;
}

async function seedWeight(userId: string, value: number) {
  return getPrismaClient().measurement.create({
    data: {
      userId,
      type: "WEIGHT",
      value,
      unit: "kg",
      measuredAt: new Date(),
      source: "MANUAL",
    },
  });
}

/**
 * A delegable read, assembled from the real wrapper and the real resolver so
 * what is under test is the fence rather than one domain's query shape.
 */
const delegableRead: (request: NextRequest) => Promise<Response> = apiHandler(
  async () => {
    const { user, actor } = await requireRecordAuth("read", "measurements");
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id },
      orderBy: { value: "asc" },
    });
    return NextResponse.json({
      data: {
        scopeUserId: user.id,
        actorUserId: actor.id,
        values: rows.map((r) => r.value),
      },
      error: null,
    });
  },
);

/** A delegable WRITE, so a refused mutation can be shown to write nothing. */
const delegableWrite: (request: NextRequest) => Promise<Response> = apiHandler(
  async () => {
    const { user } = await requireRecordAuth("write", "measurements");
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 99,
        unit: "kg",
        measuredAt: new Date(),
        source: "MANUAL",
      },
    });
    return NextResponse.json({ data: { ok: true }, error: null });
  },
);

function callRead(): Promise<Response> {
  return delegableRead(new NextRequest("http://localhost/api/test/delegable"));
}

function callWrite(): Promise<Response> {
  return delegableWrite(
    new NextRequest("http://localhost/api/test/delegable", { method: "POST" }),
  );
}

/** Assert a record context on the next request. */
function assertContext(epoch: number | string, scope: string | null): void {
  headerJar.set(RECORD_EPOCH_HEADER, String(epoch));
  headerJar.set(RECORD_SCOPE_HEADER, scope ?? RECORD_SCOPE_SELF);
}

async function household(access: "READ" | "WRITE" = "READ") {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  await seedWeight(owner.id, 81);
  await seedWeight(delegate.id, 64);
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access,
    scope: null,
  });
  const grant = await acceptGrant({
    grantId: invited.id,
    granteeId: delegate.id,
  });
  return { owner, delegate, grant };
}

/**
 * Point a session at a record OUT OF BAND — the "raw or external switch" of
 * acceptance case 04. No client journal runs, no BroadcastChannel fires; the
 * selector simply moves and the epoch follows it.
 */
async function switchOutOfBand(sessionId: string, target: string | null) {
  await getPrismaClient().session.update({
    where: { id: sessionId },
    data: { actingAsUserId: target },
  });
  const row = await getPrismaClient().session.findUniqueOrThrow({
    where: { id: sessionId },
  });
  return row.recordEpoch;
}

async function grantLastUsedAt(grantId: string): Promise<Date | null> {
  const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
    where: { id: grantId },
  });
  return row.lastUsedAt;
}

async function delegatedAccessRows(ownerId: string, actorId: string) {
  return getPrismaClient().auditLog.findMany({
    where: {
      userId: ownerId,
      actorUserId: actorId,
      action: "sharing.record.accessed",
    },
  });
}

/** The two admission side effects are fire-and-forget; give them a moment. */
async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("FENCE-AC-04 a stale context is refused before any record work", () => {
  it("FENCE-AC-04 refuses a delegated read whose epoch is behind, touching neither the grant nor the record", async () => {
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    const epoch = await switchOutOfBand(session.id, owner.id);

    // The tab formed its intent one transition ago.
    assertContext(epoch - 1, owner.id);

    const res = await callRead();
    const body = await res.json();

    // The instrument comes FIRST, deliberately. Both writes happen only past
    // admission, so their absence is the proof that no grant was looked up and
    // no record was opened — where a status code alone would pass with the
    // fence sitting anywhere, including after the handler had read the record.
    // Asserting the status first would mask this one behind it whenever the
    // fence is removed, which is exactly the case this file exists to catch.
    // Both writes are fire-and-forget, so the assertion is immediate on
    // purpose: a fence placed after the grant lookup would already have
    // stamped them by the time the response was built.
    expect(await grantLastUsedAt(grant.id)).toBeNull();
    expect(await delegatedAccessRows(owner.id, delegate.id)).toHaveLength(0);

    expect(res.status).toBe(409);
    expect(body.meta.errorCode).toBe(RECORD_FENCE_ERROR_CODE);
  });

  it("FENCE-AC-04 refuses a stale delegated WRITE and writes nothing to either record", async () => {
    const { owner, delegate, grant } = await household("WRITE");
    const session = await signIn(delegate.id);
    const epoch = await switchOutOfBand(session.id, owner.id);

    assertContext(epoch - 1, owner.id);

    const res = await callWrite();
    expect(res.status).toBe(409);

    expect(await grantLastUsedAt(grant.id)).toBeNull();
    // One seeded row each, and no third row anywhere.
    const all = await getPrismaClient().measurement.findMany();
    expect(all).toHaveLength(2);
    expect(all.some((m) => m.value === 99)).toBe(false);
  });

  it("FENCE-AC-04 refuses a matching epoch whose SCOPE moved", async () => {
    // Belt and braces: the epoch alone distinguishes transitions, the scope
    // catches a selector that moved to a value the client did not expect.
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    const epoch = await switchOutOfBand(session.id, owner.id);

    assertContext(epoch, "some-other-account");

    const res = await callRead();
    expect(res.status).toBe(409);
    expect(await grantLastUsedAt(grant.id)).toBeNull();
  });

  it("FENCE-AC-04 POSITIVE CONTROL: a matching assertion is served and both side effects land", async () => {
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    const epoch = await switchOutOfBand(session.id, owner.id);

    assertContext(epoch, owner.id);

    const res = await callRead();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.scopeUserId).toBe(owner.id);
    expect(body.data.actorUserId).toBe(delegate.id);
    // The owner's 81 kg row and not the delegate's 64 kg one. An empty list
    // would satisfy a weaker assertion while hiding the failure that matters.
    expect(body.data.values).toEqual([81]);

    // The response echoes the context it was served under.
    expect(res.headers.get(RECORD_EPOCH_HEADER)).toBe(String(epoch));
    expect(res.headers.get(RECORD_SCOPE_HEADER)).toBe(owner.id);

    await waitFor(
      async () => (await grantLastUsedAt(grant.id)) !== null,
      "AccountGrant.lastUsedAt",
    );
    await waitFor(
      async () => (await delegatedAccessRows(owner.id, delegate.id)).length > 0,
      "sharing.record.accessed audit row",
    );
  });
});

describe("FENCE-AC-10 the exemptions, proved rather than assumed", () => {
  it("FENCE-AC-10 serves a Bearer request with no fence header at all", async () => {
    const { owner, delegate } = await household();
    const raw = await mintToken(delegate.id);
    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${raw}`);
    headerJar.set("x-healthlog-account", owner.id);

    const res = await callRead();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.scopeUserId).toBe(owner.id);
    // Nothing is echoed on this transport either: the native contract neither
    // sends nor receives the fence headers.
    expect(res.headers.get(RECORD_EPOCH_HEADER)).toBeNull();
    expect(res.headers.get(RECORD_SCOPE_HEADER)).toBeNull();
  });

  it("FENCE-AC-10 serves a never-switched cookie session with no fence header at all", async () => {
    const delegate = await makeUser("solo");
    await seedWeight(delegate.id, 70);
    await signIn(delegate.id);

    const res = await callRead();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.values).toEqual([70]);
    // The exemption still echoes what it served under, so a fence-aware client
    // has something to validate against from its very first request.
    expect(res.headers.get(RECORD_EPOCH_HEADER)).toBe("0");
    expect(res.headers.get(RECORD_SCOPE_HEADER)).toBe(RECORD_SCOPE_SELF);
  });

  it("FENCE-AC-10 serves a never-switched session that sends the bootstrap sentinel", async () => {
    const delegate = await makeUser("booting");
    await seedWeight(delegate.id, 71);
    await signIn(delegate.id);
    headerJar.set(RECORD_EPOCH_HEADER, RECORD_FENCE_BOOTSTRAP);
    headerJar.set(RECORD_SCOPE_HEADER, RECORD_FENCE_BOOTSTRAP);

    const res = await callRead();
    expect(res.status).toBe(200);
  });

  it("FENCE-AC-10 refuses a HEADERLESS request on a fenced session with the code a pre-fence bundle recovers from", async () => {
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    await switchOutOfBand(session.id, owner.id);
    // No fence headers at all — a bundle that predates the fence.

    const res = await callRead();
    const body = await res.json();

    expect(res.status).toBe(403);
    // The code the deployed bundle's grant-loss bridge already acts on: it
    // leaves the record and hard-navigates, which serves the fence-aware
    // bundle. Handing it the 409 instead would strand it.
    expect(body.meta.errorCode).toBe("sharing.access.denied");
    expect(await grantLastUsedAt(grant.id)).toBeNull();
  });

  it("FENCE-AC-10 keeps a session fenced after it has LEFT a record", async () => {
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    await switchOutOfBand(session.id, owner.id);
    const epoch = await switchOutOfBand(session.id, null);
    expect(epoch).toBe(2);

    // A tab still believing it is inside the owner's record.
    assertContext(1, owner.id);
    expect((await callRead()).status).toBe(409);

    // And the same session, asserting the truth, is served its own record.
    assertContext(2, null);
    const ok = await callRead();
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.values).toEqual([64]);
  });
});

describe("FENCE-AC-08 concurrent switchers resolve to one monotonic outcome", () => {
  it("FENCE-AC-08 lets exactly one of two same-epoch switches land", async () => {
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    // Start INSIDE a record, so both competing targets are genuinely distinct
    // from the current selector. Two tabs racing to a value the row already
    // holds is not a race at all — the trigger declines to move on a no-op
    // write and both callers are correctly told their intent stands, which is
    // the arm asserted separately below.
    const start = await switchOutOfBand(session.id, owner.id);
    expect(start).toBe(1);

    // A real second account: the selector carries a foreign key, so a race
    // between two invented ids would fail on the constraint rather than on the
    // compare-and-set.
    const otherOwner = await makeUser("owner-b");

    const [first, second] = await Promise.all([
      pointSessionAtIfUnchanged(session.id, delegate.id, null, start),
      pointSessionAtIfUnchanged(session.id, delegate.id, otherOwner.id, start),
    ]);

    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(["applied", "stale"]);

    const applied = first.kind === "applied" ? first : second;
    expect(applied.kind).toBe("applied");
    if (applied.kind === "applied") {
      // The epoch handed back is the one the trigger committed, read in the
      // same statement that committed it.
      const row = await getPrismaClient().session.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(applied.epoch).toBe(row.recordEpoch);
      expect(applied.epoch).toBe(start + 1);
    }
  });

  it("FENCE-AC-08 treats a switch to where the session already is as applied, and does not move the epoch", async () => {
    // The trigger declines a no-op write (`IS DISTINCT FROM`), so the epoch
    // stands. The caller is still told `applied`, and that is the honest
    // answer: they asked for the session to be pointed somewhere and it is.
    // Reporting `stale` here would make a client reconcile against a context
    // that never changed.
    const { delegate } = await household();
    const session = await signIn(delegate.id);

    const outcome = await pointSessionAtIfUnchanged(
      session.id,
      delegate.id,
      null,
      0,
    );

    expect(outcome).toEqual({ kind: "applied", epoch: 0 });
  });

  it("FENCE-AC-08 refuses a switch that names an epoch the row has already left", async () => {
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    const start = 0;

    const landed = await pointSessionAtIfUnchanged(
      session.id,
      delegate.id,
      owner.id,
      start,
    );
    expect(landed.kind).toBe("applied");

    // A second tab still holding the pre-switch epoch.
    const stale = await pointSessionAtIfUnchanged(
      session.id,
      delegate.id,
      null,
      start,
    );
    expect(stale.kind).toBe("stale");

    // And the row is where the winner put it, not where the loser wanted it.
    const row = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.actingAsUserId).toBe(owner.id);
  });

  it("FENCE-AC-08 refuses a switch aimed at another user's session", async () => {
    // The CAS does not weaken the ownership pin: a matching epoch on somebody
    // else's session still matches no row.
    const { owner, delegate } = await household();
    const stranger = await makeUser("stranger");
    const session = await signIn(delegate.id);

    const outcome = await pointSessionAtIfUnchanged(
      session.id,
      stranger.id,
      owner.id,
      0,
    );
    expect(outcome.kind).toBe("stale");
  });
});

describe("FENCE-AC-09 the fence refuses after every lifecycle transition", () => {
  it("FENCE-AC-09 refuses the pre-revocation context after a revoke", async () => {
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    const epoch = await switchOutOfBand(session.id, owner.id);

    assertContext(epoch, owner.id);
    expect((await callRead()).status).toBe(200);

    // The verb the sharing panel calls. It clears the selector inside the same
    // transaction that stamps the row, so the epoch moves with it and the tab's
    // context is stale from the very next request.
    await revokeGrantAndClearSwitch({
      grantId: grant.id,
      grantorId: owner.id,
    });

    const res = await callRead();
    expect(res.status).toBe(409);
    expect((await res.json()).meta.errorCode).toBe(RECORD_FENCE_ERROR_CODE);
  });

  it("FENCE-AC-09 still refuses on the grant when a revocation leaves the selector in place", async () => {
    // `revokeGrant` is the bare state transition and clears no session. The
    // fence is not a substitute for the grant check and must not become one:
    // the context is still provable, so the fence passes, and the resolver
    // refuses on the grant exactly as it did before the fence existed.
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    const epoch = await switchOutOfBand(session.id, owner.id);

    assertContext(epoch, owner.id);
    expect((await callRead()).status).toBe(200);

    await revokeGrant({ grantId: grant.id, grantorId: owner.id });

    const res = await callRead();
    expect(res.status).toBe(403);
    expect((await res.json()).meta.errorCode).toBe("sharing.access.denied");
  });

  it("FENCE-AC-09 refuses the pre-deletion context after the owner account is deleted", async () => {
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    const epoch = await switchOutOfBand(session.id, owner.id);

    assertContext(epoch, owner.id);
    expect((await callRead()).status).toBe(200);

    // The referential action, which runs no application code. The epoch moves
    // anyway, because the trigger owns it.
    await getPrismaClient().user.delete({ where: { id: owner.id } });

    expect((await callRead()).status).toBe(409);
  });
});
