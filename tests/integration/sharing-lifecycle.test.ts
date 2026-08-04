/**
 * The five verbs of account sharing, over the real routes, against real
 * Postgres.
 *
 * Invite, accept, switch, revoke, renounce. Every one of them is a question
 * about which rows exist afterwards, which is why none of it is unit-tested
 * here: a mocked Prisma can show that the route called what it meant to call,
 * and this feature has exactly one failure mode worth catching — the call that
 * was made and did not land. The revocation cleanup is the sharpest case. A
 * response body saying `sessionsCleared: 1` proves nothing; the session row
 * still pointing at the owner's record is the defect.
 *
 * The delegable read handler is assembled here rather than imported because no
 * shipped route declares `requireRecordAuth` yet — the frozen list lands empty
 * on purpose and routes migrate into it later. Everything beneath it is real:
 * the real wrapper, the real resolver, the real grant module, the real
 * database.
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `share-${suffix}`,
      email: `share-${suffix}@example.test`,
      displayName: `Share ${suffix}`,
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
      name: "sharing-lifecycle-test",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  return raw;
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── the routes under test ───────────────────────────────────────────────────

async function listGrants(): Promise<Response> {
  const { GET } = await import("@/app/api/account/grants/route");
  return GET();
}

async function invite(
  identifier: string,
  expiresAt?: string | null,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const { POST } = await import("@/app/api/account/grants/route");
  return POST(
    jsonRequest("http://localhost/api/account/grants", "POST", {
      identifier,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...extra,
    }),
  );
}

async function accept(grantId: string): Promise<Response> {
  const { POST } = await import("@/app/api/account/grants/[id]/accept/route");
  return POST(
    jsonRequest(
      `http://localhost/api/account/grants/${grantId}/accept`,
      "POST",
    ),
    { params: Promise.resolve({ id: grantId }) },
  );
}

async function revoke(grantId: string): Promise<Response> {
  const { DELETE } = await import("@/app/api/account/grants/[id]/route");
  return DELETE(
    jsonRequest(`http://localhost/api/account/grants/${grantId}`, "DELETE"),
    { params: Promise.resolve({ id: grantId }) },
  );
}

async function renounce(grantId: string): Promise<Response> {
  const { POST } = await import("@/app/api/account/grants/[id]/renounce/route");
  return POST(
    jsonRequest(
      `http://localhost/api/account/grants/${grantId}/renounce`,
      "POST",
    ),
    { params: Promise.resolve({ id: grantId }) },
  );
}

async function switchTo(accountId: string | null): Promise<Response> {
  const { POST } = await import("@/app/api/account/switch/route");
  return POST(
    jsonRequest("http://localhost/api/account/switch", "POST", { accountId }),
  );
}

/** A delegable read, exactly as a migrated route builds one. */
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

function readRecord(): Promise<Response> {
  return delegableRead(
    new NextRequest("http://localhost/api/test/delegable", { method: "GET" }),
  );
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

/** The acting-account column on one session row, read straight from the table. */
async function actingAsOf(sessionId: string): Promise<string | null> {
  const row = await getPrismaClient().session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { actingAsUserId: true },
  });
  return row.actingAsUserId;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("the handshake, end to end", () => {
  it("carries a household from invitation to revocation and leaves the right rows", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedWeight(owner.id, 81);
    await seedWeight(delegate.id, 64);

    // ── the owner invites ──
    await signIn(owner.id);
    const invited = await invite(delegate.username);
    expect(invited.status).toBe(201);
    const grantView = (await invited.json()).data;
    expect(grantView.state).toBe("PENDING");
    expect(grantView.access).toBe("READ");
    expect(grantView.account.id).toBe(delegate.id);

    // Pending confers nothing: the delegate cannot switch into a record they
    // have only been offered.
    const delegateSession = await signIn(delegate.id);
    expect((await switchTo(owner.id)).status).toBe(403);
    expect(await actingAsOf(delegateSession.id)).toBeNull();

    // ── the delegate accepts ──
    const accepted = await accept(grantView.id);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).data.state).toBe("ACTIVE");

    const acceptedRow = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: grantView.id },
    });
    expect(acceptedRow.acceptedAt).not.toBeNull();

    // ── the delegate switches in and reads the owner's record ──
    const switched = await switchTo(owner.id);
    expect(switched.status).toBe(200);
    expect((await switched.json()).data.actingAs.accountId).toBe(owner.id);
    expect(await actingAsOf(delegateSession.id)).toBe(owner.id);

    const read = await readRecord();
    expect(read.status).toBe(200);
    const readBody = (await read.json()).data;
    expect(readBody.scopeUserId).toBe(owner.id);
    expect(readBody.actorUserId).toBe(delegate.id);
    // The delegate's own 64 kg row is seeded and must not appear. An empty
    // list would satisfy a weaker assertion while hiding the exact failure
    // this feature exists to avoid.
    expect(readBody.values).toEqual([81]);

    // ── the owner revokes ──
    await signIn(owner.id);
    const revoked = await revoke(grantView.id);
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).data.sessionsCleared).toBe(1);

    // The row survives as the consent record rather than being deleted.
    const revokedRow = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: grantView.id },
    });
    expect(revokedRow.revokedAt).not.toBeNull();
    expect(revokedRow.revokedBy).toBe("GRANTOR");
    expect(revokedRow.acceptedAt).not.toBeNull();

    // The session row, not the response body. A cleanup that ran everywhere
    // except the database would look identical from the outside.
    expect(await actingAsOf(delegateSession.id)).toBeNull();

    // And the delegate's next request is refused on the grant, independently
    // of the session having been cleared.
    cookieJar.set("healthlog_session", delegateSession.id);
    await getPrismaClient().session.update({
      where: { id: delegateSession.id },
      data: { actingAsUserId: owner.id },
    });
    const afterRevoke = await readRecord();
    expect(afterRevoke.status).toBe(403);
    expect((await afterRevoke.json()).meta.errorCode).toBe(
      "sharing.access.denied",
    );
  });

  it("drops the delegate's other sessions when they renounce", async () => {
    // Two browsers, the way a person actually has them: a phone sitting inside
    // the owner's record and a laptop in their own account. Renouncing from
    // the laptop has to evict the phone — a cleanup that only reached the
    // session making the request would leave the other one inside a record
    // whose grant no longer exists.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");

    await signIn(owner.id);
    const grantId = (await (await invite(delegate.email!)).json()).data.id;

    const phone = await signIn(delegate.id);
    await accept(grantId);
    await switchTo(owner.id);
    expect(await actingAsOf(phone.id)).toBe(owner.id);

    const laptop = await signIn(delegate.id);
    const gone = await renounce(grantId);
    expect(gone.status).toBe(200);
    expect((await gone.json()).data.sessionsCleared).toBe(1);
    expect(await actingAsOf(phone.id)).toBeNull();
    expect(await actingAsOf(laptop.id)).toBeNull();

    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: grantId },
    });
    expect(row.revokedBy).toBe("GRANTEE");
  });

  it("refuses a renunciation made from inside the record itself", async () => {
    // Grant management is non-delegable without exception, and the delegate's
    // own renounce is not carved out of that. The browser switches back first
    // — one request, which the client makes on the way — and the fail-closed
    // default stays a default rather than a default with an exception.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);
    const grantId = (await (await invite(delegate.username)).json()).data.id;

    const session = await signIn(delegate.id);
    await accept(grantId);
    await switchTo(owner.id);

    const refused = await renounce(grantId);
    expect(refused.status).toBe(403);
    expect((await refused.json()).meta.errorCode).toBe("sharing.not_permitted");

    // Out of the record, then out of the grant, both instant.
    expect((await switchTo(null)).status).toBe(200);
    expect((await renounce(grantId)).status).toBe(200);
    expect(await actingAsOf(session.id)).toBeNull();
    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: grantId },
    });
    expect(row.revokedBy).toBe("GRANTEE");
  });

  it("clears only the sessions pointing at the record that ended", async () => {
    // Two owners, one delegate with a browser in each. Ending one grant must
    // not evict the other — a cleanup scoped to the delegate alone would pass
    // every single-household test and quietly sign people out of a record
    // nobody revoked.
    const ownerA = await makeUser("owner-a");
    const ownerB = await makeUser("owner-b");
    const delegate = await makeUser("delegate");

    await signIn(ownerA.id);
    const grantA = (await (await invite(delegate.username)).json()).data.id;
    await signIn(ownerB.id);
    const grantB = (await (await invite(delegate.username)).json()).data.id;

    const sessionA = await signIn(delegate.id);
    await accept(grantA);
    await switchTo(ownerA.id);
    const sessionB = await signIn(delegate.id);
    await accept(grantB);
    await switchTo(ownerB.id);

    await signIn(ownerA.id);
    await revoke(grantA);

    expect(await actingAsOf(sessionA.id)).toBeNull();
    expect(await actingAsOf(sessionB.id)).toBe(ownerB.id);
  });
});

describe("who may do what to a grant", () => {
  async function pendingGrant() {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);
    const id = (await (await invite(delegate.username)).json()).data.id;
    return { owner, delegate, id };
  }

  it("refuses an acceptance by anybody but the invited account", async () => {
    const { id } = await pendingGrant();
    const stranger = await makeUser("stranger");
    await signIn(stranger.id);

    const response = await accept(id);
    expect(response.status).toBe(404);
    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id },
    });
    expect(row.acceptedAt).toBeNull();
  });

  it("refuses a revocation by the delegate — renounce is their verb", async () => {
    const { delegate, id } = await pendingGrant();
    await signIn(delegate.id);

    expect((await revoke(id)).status).toBe(404);
    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id },
    });
    expect(row.revokedAt).toBeNull();
  });

  it("refuses a renunciation by the owner — revoke is theirs", async () => {
    const { owner, id } = await pendingGrant();
    await signIn(owner.id);

    expect((await renounce(id)).status).toBe(404);
    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id },
    });
    expect(row.revokedAt).toBeNull();
  });

  it("refuses a second live invitation and allows one after a revocation", async () => {
    const { delegate, id } = await pendingGrant();

    const second = await invite(delegate.username);
    expect(second.status).toBe(409);
    expect((await second.json()).meta.errorCode).toBe(
      "sharing.invite.duplicate",
    );

    await revoke(id);
    const third = await invite(delegate.username);
    expect(third.status).toBe(201);
    const newId = (await third.json()).data.id;
    expect(newId).not.toBe(id);

    // The history piles up rather than being reused: the first row is still
    // there, still revoked, with its own dates.
    const rows = await getPrismaClient().accountGrant.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(id);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[1].revokedAt).toBeNull();
  });

  it("refuses an account sharing with itself", async () => {
    const owner = await makeUser("owner");
    await signIn(owner.id);

    const response = await invite(owner.username);
    expect(response.status).toBe(422);
    expect((await response.json()).meta.errorCode).toBe("sharing.invite.self");
    expect(await getPrismaClient().accountGrant.count()).toBe(0);
  });

  it("says so when the identifier names nobody on this instance", async () => {
    const owner = await makeUser("owner");
    await signIn(owner.id);

    const response = await invite("nobody-here@example.test");
    expect(response.status).toBe(404);
    expect(await getPrismaClient().accountGrant.count()).toBe(0);
  });
});

describe("what an invitation opens, over the real route", () => {
  /**
   * The sections and the third level, from the posted body to the stored
   * column. The unit suite reads the `data` object handed to Prisma; this
   * reads the ROW, which is the only thing that proves the two nulls did not
   * swap places on the way down — a JSON `null` in that column resolves
   * fail-closed to "opens nothing", one keystroke from the value that means
   * "opens everything".
   */
  it("stores the picked sections and hands them back on the grant view", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);

    const response = await invite(delegate.username, undefined, {
      scope: ["labs", "medications"],
    });
    expect(response.status).toBe(201);
    expect((await response.json()).data.scope).toEqual(["medications", "labs"]);

    const row = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: owner.id },
    });
    expect(row.scopeJson).toEqual(["labs", "medications"]);
  });

  it("stores the whole record as a SQL null, not as a JSON null", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);

    expect((await invite(delegate.username)).status).toBe(201);

    // Read through raw SQL: the Prisma client surfaces both nulls as `null`
    // in JS, so the only way to tell "no scope" from "the JSON value null" is
    // to ask the column itself. The distinction is the whole difference
    // between a grant that opens everything and one that opens nothing.
    const rows = await getPrismaClient().$queryRaw<
      { is_null: boolean }[]
    >`SELECT scope_json IS NULL AS is_null FROM account_grants WHERE grantor_id = ${owner.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_null).toBe(true);
  });

  it("refuses an unknown section and writes nothing", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);

    const response = await invite(delegate.username, undefined, {
      scope: ["labs", "bank_details"],
    });
    expect(response.status).toBe(422);
    expect(await getPrismaClient().accountGrant.count()).toBe(0);
  });

  it("refuses a scope beside MANAGE and writes nothing", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);

    const response = await invite(delegate.username, undefined, {
      access: "MANAGE",
      scope: ["labs"],
    });
    expect(response.status).toBe(422);
    expect(await getPrismaClient().accountGrant.count()).toBe(0);
  });

  it("refuses MANAGE over Bearer with a code the client can act on", async () => {
    // The decided consequence of a cookie-only step-up. Not a bug to work
    // around: the native client cannot offer management of a health record,
    // and it is told so in a code rather than by an authentication error on a
    // request that authenticated fine.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const token = await mintToken(owner.id);
    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${token}`);

    const response = await invite(delegate.username, undefined, {
      access: "MANAGE",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).meta.errorCode).toBe(
      "sharing.invite.manage_browser_only",
    );
    expect(await getPrismaClient().accountGrant.count()).toBe(0);
  });

  it("lets the same Bearer caller keep minting the two levels it always could", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const token = await mintToken(owner.id);
    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${token}`);

    const response = await invite(delegate.username, undefined, {
      access: "WRITE",
      scope: ["measurements"],
    });
    expect(response.status).toBe(201);
    expect((await response.json()).data.access).toBe("WRITE");
  });

  it("mints MANAGE from a browser session that carries no second factor", async () => {
    // `requireFreshMfaIfEnrolled` gates the enrolled cohort only. An account
    // with no second factor cannot produce a fresh-factor proof, so gating it
    // would lock it out of a level it is entitled to offer — the same posture
    // account deletion and the encrypted export already take.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);

    const response = await invite(delegate.username, undefined, {
      access: "MANAGE",
    });
    expect(response.status).toBe(201);

    const row = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: owner.id },
    });
    expect(row.access).toBe("MANAGE");
    expect(row.scopeJson).toBeNull();
  });

  it("refuses MANAGE from an enrolled session whose factor has gone stale", async () => {
    // The step-up itself, over the real gate. The session below has a
    // confirmed TOTP secret and a `mfaVerifiedAt` well outside the window, so
    // the only thing standing between it and a manage grant is the gate.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { totpConfirmedAt: new Date() },
    });
    const session = await signIn(owner.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const response = await invite(delegate.username, undefined, {
      access: "MANAGE",
    });
    expect(response.status).toBe(401);
    expect((await response.json()).meta.errorCode).toBe("auth.stepup.required");
    expect(await getPrismaClient().accountGrant.count()).toBe(0);
  });

  it("mints MANAGE once that same session has proved the factor", async () => {
    // The other half, so the leg above proves a GATE rather than a broken
    // route: same account, same enrolment, a fresh stamp.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { totpConfirmedAt: new Date() },
    });
    const session = await signIn(owner.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: new Date() },
    });

    const response = await invite(delegate.username, undefined, {
      access: "MANAGE",
    });
    expect(response.status).toBe(201);
    expect(await getPrismaClient().accountGrant.count()).toBe(1);
  });

  it("does not ask a read invitation for a factor at all", async () => {
    // Same stale-factor account. Reducing the friction to the level that
    // needs it is the point; an owner sharing a reading re-proves nothing.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { totpConfirmedAt: new Date() },
    });
    const session = await signIn(owner.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect((await invite(delegate.username)).status).toBe(201);
  });
});

describe("grant management cannot be reached from inside a switch", () => {
  /**
   * The property the design states as "a delegate must never grant, widen, or
   * transfer". Not enforced by a re-delegation check in the handler — by the
   * mode: bare `requireAuth()` refuses outright while a switch is active, so
   * there is no path through these routes that runs as somebody else.
   */
  async function switchedDelegate() {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const third = await makeUser("third");
    await signIn(owner.id);
    const id = (await (await invite(delegate.username)).json()).data.id;
    await signIn(delegate.id);
    await accept(id);
    await switchTo(owner.id);
    return { owner, delegate, third, id };
  }

  it("refuses an invitation issued while acting as somebody else", async () => {
    const { third } = await switchedDelegate();

    const response = await invite(third.username);
    expect(response.status).toBe(403);
    expect((await response.json()).meta.errorCode).toBe(
      "sharing.not_permitted",
    );
    // One grant in the table: the delegate's own. Nothing was widened.
    expect(await getPrismaClient().accountGrant.count()).toBe(1);
  });

  it("refuses the grant list and the revoke while acting as somebody else", async () => {
    const { id } = await switchedDelegate();

    expect((await listGrants()).status).toBe(403);
    expect((await revoke(id)).status).toBe(403);
    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id },
    });
    expect(row.revokedAt).toBeNull();
  });

  it("still lets the switched session switch back", async () => {
    const { delegate } = await switchedDelegate();
    const session = await getPrismaClient().session.findFirstOrThrow({
      where: { userId: delegate.id, actingAsUserId: { not: null } },
    });

    const back = await switchTo(null);
    expect(back.status).toBe(200);
    expect((await back.json()).data.actingAs).toBeNull();
    expect(await actingAsOf(session.id)).toBeNull();
  });
});

describe("the switch endpoint", () => {
  it("refuses a switch into a grant that is not active", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);
    const lapsing = (
      await (
        await invite(
          delegate.username,
          new Date(Date.now() + 300).toISOString(),
        )
      ).json()
    ).data.id;

    const session = await signIn(delegate.id);
    await accept(lapsing);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const response = await switchTo(owner.id);
    expect(response.status).toBe(403);
    expect((await response.json()).meta.errorCode).toBe(
      "sharing.access.denied",
    );
    expect(await actingAsOf(session.id)).toBeNull();
  });

  it("answers a nonexistent account and an ungranting one with the same bytes", async () => {
    const stranger = await makeUser("stranger");
    const caller = await makeUser("caller");
    await signIn(caller.id);

    const unknown = await switchTo("does-not-exist-at-all");
    const ungranting = await switchTo(stranger.id);

    expect(unknown.status).toBe(ungranting.status);
    expect(await unknown.text()).toBe(await ungranting.text());
  });

  it("refuses over Bearer, where the carrier is the header", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);
    const id = (await (await invite(delegate.username)).json()).data.id;
    const session = await signIn(delegate.id);
    await accept(id);

    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${await mintToken(delegate.id)}`);
    const response = await switchTo(owner.id);
    expect(response.status).toBe(400);
    expect((await response.json()).meta.errorCode).toBe(
      "sharing.switch.wrong_transport",
    );
    // Nothing was stamped on the browser session that happens to exist.
    expect(await actingAsOf(session.id)).toBeNull();
  });
});

describe("the grant list", () => {
  it("shows both directions with the state the resolver would agree with", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const other = await makeUser("other");

    await signIn(owner.id);
    const given = (await (await invite(delegate.username)).json()).data.id;

    await signIn(other.id);
    const received = (await (await invite(owner.username)).json()).data.id;

    await signIn(owner.id);
    const body = (await (await listGrants()).json()).data;

    expect(body.given.map((g: { id: string }) => g.id)).toEqual([given]);
    expect(body.given[0].account.id).toBe(delegate.id);
    expect(body.given[0].state).toBe("PENDING");
    expect(body.received.map((g: { id: string }) => g.id)).toEqual([received]);
    expect(body.received[0].account.id).toBe(other.id);

    // No e-mail addresses in either direction: a grant is not a way to collect
    // the other party's contact details.
    expect(JSON.stringify(body)).not.toContain("@example.test");
  });

  it("keeps ended grants in the list, marked as ended", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await signIn(owner.id);
    const id = (await (await invite(delegate.username)).json()).data.id;
    await revoke(id);

    const body = (await (await listGrants()).json()).data;
    expect(body.given).toHaveLength(1);
    expect(body.given[0].state).toBe("REVOKED");
    expect(body.given[0].revokedBy).toBe("GRANTOR");
  });
});
