/**
 * The acting-account resolver against real Postgres.
 *
 * The unit suite proves the arms. This file proves the two things a unit suite
 * cannot, because both are about which ROWS come back:
 *
 *   * **Substitution.** Under a valid switch the handler's `where` clause is
 *     built from the owner's id and returns the owner's measurements — not a
 *     mock's idea of them, and demonstrably not the delegate's own, which are
 *     seeded alongside so a resolver that quietly served the caller their own
 *     record would show up as the wrong ids rather than as an empty list.
 *   * **Nothing is cached.** A revocation lands between two requests inside one
 *     test and the second one 403s. Anything memoised — on the session, in the
 *     process, on the token — would let the first request's verdict survive
 *     into the second, and the owner's revoke button would mean "at some point
 *     later" instead of "now".
 *
 * Both arms run against REAL shipped routes, and since the route migration they
 * exercise both sides of the boundary rather than one:
 *
 *   * `GET /api/measurements` is delegable now. Un-switched it must answer
 *     exactly what it answered before the resolver existed, which is the
 *     do-no-harm claim and the one worth the most.
 *   * `GET /api/share-links` is refused, permanently and by design — a delegate
 *     must never mint a door that outlives their own revocation. It is what a
 *     route that never declared a mode does under a switch. Naming a
 *     permanently-refused route rather than a merely-unmigrated one is
 *     deliberate: this arm broke once already when the route it pointed at
 *     became delegable, and a route that can never join the list cannot break
 *     it the same way twice.
 *
 * The delegable handler below is still assembled here rather than imported. A
 * shipped route would work, but it would bind this file to one domain's query
 * shape, and what is under test is the resolver. Everything beneath it is real:
 * the real `apiHandler`, the real resolver, the real grant module, the real
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

import {
  ACCOUNT_SELECTOR_HEADER,
  apiHandler,
  requireRecordAuth,
} from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";
import { acceptGrant, inviteGrant, revokeGrant } from "@/lib/sharing/grants";
import { bodyWithoutRequestId } from "@/__tests__/helpers/error-envelope";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `acting-${suffix}`,
      email: `acting-${suffix}@example.test`,
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
      name: "acting-account-test",
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
 * A delegable read handler: the real wrapper, the real resolver, and a `where`
 * clause built from the resolved data-scope user exactly as a migrated route
 * builds one.
 */
const delegableRead: (request: NextRequest) => Promise<Response> = apiHandler(
  async () => {
    const { user, actor, grantId } = await requireRecordAuth(
      "read",
      "measurements",
    );
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id },
      orderBy: { value: "asc" },
    });
    return NextResponse.json({
      data: {
        scopeUserId: user.id,
        actorUserId: actor.id,
        grantId,
        values: rows.map((r) => r.value),
      },
      error: null,
    });
  },
);

function call(method = "GET"): Promise<Response> {
  return delegableRead(
    new NextRequest("http://localhost/api/test/delegable", { method }),
  );
}

/** Owner and delegate, an accepted grant, and one measurement each. */
async function household() {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  await seedWeight(owner.id, 81);
  await seedWeight(delegate.id, 64);
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access: "READ",
    scope: null,
  });
  const grant = await acceptGrant({
    grantId: invited.id,
    granteeId: delegate.id,
  });
  return { owner, delegate, grant };
}

/** Point the delegate's browser session at the owner's record. */
async function switchTo(sessionId: string, ownerId: string | null) {
  await getPrismaClient().session.update({
    where: { id: sessionId },
    data: { actingAsUserId: ownerId },
  });
  await assertCurrentContext(sessionId);
}

/**
 * v1.37.0 — attach the record-session assertion the shipped browser client
 * attaches to every same-origin request.
 *
 * Without it every switched case in this file would be exercising the fence's
 * pre-fence-bundle arm rather than the resolver arm it was written for: a
 * session pointed at a record is fenced, and a request carrying no assertion is
 * refused with 403 before the resolver decides anything. The assertion is read
 * back off the row rather than computed, so it is truthful by construction.
 */
async function assertCurrentContext(sessionId: string) {
  const row = await getPrismaClient().session.findUniqueOrThrow({
    where: { id: sessionId },
  });
  headerJar.set("x-healthlog-record-epoch", String(row.recordEpoch));
  headerJar.set("x-healthlog-record-scope", row.actingAsUserId ?? "self");
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("acting-account resolver — substitution", () => {
  it("returns the OWNER's rows to a switched delegate, not the delegate's own", async () => {
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    const body = await (await call()).json();
    expect(body.data.scopeUserId).toBe(owner.id);
    expect(body.data.actorUserId).toBe(delegate.id);
    expect(body.data.grantId).toBe(grant.id);
    // The delegate's own 64 kg row exists and must not be in this answer. An
    // empty list would have passed a weaker assertion while hiding the exact
    // failure this feature has to avoid.
    expect(body.data.values).toEqual([81]);
  });

  it("substitutes over the Bearer selector too", async () => {
    const { owner, delegate } = await household();
    const raw = await mintToken(delegate.id);
    headerJar.set("authorization", `Bearer ${raw}`);
    headerJar.set(ACCOUNT_SELECTOR_HEADER, owner.id);

    const body = await (await call()).json();
    expect(body.data.scopeUserId).toBe(owner.id);
    expect(body.data.values).toEqual([81]);
  });

  it("stamps the grant as used", async () => {
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    await call();
    // Fire-and-forget, so give the stamp a tick to land before reading it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: grant.id },
    });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("serves the caller their own rows when nothing is switched", async () => {
    const { delegate } = await household();
    await signIn(delegate.id);

    const body = await (await call()).json();
    expect(body.data.scopeUserId).toBe(delegate.id);
    expect(body.data.grantId).toBeNull();
    expect(body.data.values).toEqual([64]);
  });
});

describe("acting-account resolver — the decision is never cached", () => {
  it("refuses the request after the one that came before it succeeded", async () => {
    const { owner, delegate, grant } = await household();
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    const first = await call();
    expect(first.status).toBe(200);
    expect((await first.json()).data.values).toEqual([81]);

    await revokeGrant({ grantId: grant.id, grantorId: owner.id });

    const second = await call();
    expect(second.status).toBe(403);
    expect((await second.json()).meta.errorCode).toBe("sharing.access.denied");
  });

  it("stops on expiry with nothing having swept anything", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedWeight(owner.id, 81);
    // Far enough ahead that accepting, signing in and switching cannot
    // outrun it on a loaded runner, and well inside the session's minute.
    const expiresAt = new Date(Date.now() + 30_000);
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
      expiresAt,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    expect((await call()).status).toBe(200);
    // The row does not change. Only the clock the resolver reads moves, to
    // the instant the grant names: the first one it no longer holds.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(expiresAt);
      expect((await call()).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses the moment the grant is only pending", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    expect((await call()).status).toBe(403);
  });
});

describe("acting-account resolver — do no harm", () => {
  it("leaves an un-switched request on a real delegable route exactly as it was", async () => {
    const user = await makeUser("solo");
    await seedWeight(user.id, 72);
    await signIn(user.id);

    const { GET } = await import("@/app/api/measurements/route");
    const response = await GET(
      new NextRequest("http://localhost/api/measurements?type=WEIGHT"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.data.measurements.map((m: { value: number }) => m.value),
    ).toEqual([72]);
  });

  it("serves the owner's rows on that route once the caller has switched", async () => {
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    const { GET } = await import("@/app/api/measurements/route");
    const response = await GET(
      new NextRequest("http://localhost/api/measurements?type=WEIGHT"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // The owner's 81 kg, and — the failure that matters — not the delegate's
    // own 64 kg, which is seeded alongside it.
    expect(
      body.data.measurements.map((m: { value: number }) => m.value),
    ).toEqual([81]);
  });

  it("refuses a route that never declared a mode, and serves nobody's rows", async () => {
    // `GET /api/share-links` is permanently non-delegable: a delegate who
    // could mint a clinician link would hold a door that survives the owner
    // revoking their access. It resolves through the bare `requireAuth`
    // default arm, which is what makes the refusal structural rather than a
    // check somebody remembered to write.
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    const { GET } = await import("@/app/api/share-links/route");
    const response = await GET();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.meta.errorCode).toBe("sharing.not_permitted");
    expect(body.data).toBeNull();
    expect(owner.id).not.toBe(delegate.id);
  });
});

describe("acting-account resolver — refusals do not enumerate", () => {
  it("answers a nonexistent account and a stranger's account with the same bytes", async () => {
    const { delegate } = await household();
    const stranger = await makeUser("stranger");
    await seedWeight(stranger.id, 99);
    const raw = await mintToken(delegate.id);
    headerJar.set("authorization", `Bearer ${raw}`);

    headerJar.set(ACCOUNT_SELECTOR_HEADER, "cmnosuchaccount000000000x");
    const missing = await call();
    const missingBody = await bodyWithoutRequestId(missing);

    headerJar.set(ACCOUNT_SELECTOR_HEADER, stranger.id);
    const present = await call();
    const presentBody = await bodyWithoutRequestId(present);

    expect(missing.status).toBe(403);
    expect(present.status).toBe(403);
    expect(missingBody).toBe(presentBody);
  });
});

describe("acting-account resolver — the cookie-only helpers", () => {
  it("resolves the actor under a live switch, against the real session row", async () => {
    // The unit suite asserts this with `getSession` mocked, which cannot catch
    // the one edit that would break it: `getSession` itself substituting the
    // owner. Here the row is real, the switch is real, and the grant behind it
    // is valid — so the only reason these helpers answer with the delegate is
    // that `getSession` still answers "who is calling".
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    const { requireAdmin, requireCookieAuth } =
      await import("@/lib/api-handler");
    const cookieCtx = await requireCookieAuth();
    expect(cookieCtx.user.id).toBe(delegate.id);

    // The delegate is not an admin; the refusal proves the role was read off
    // the caller's row and not the record owner's.
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { role: "ADMIN" },
    });
    await expect(requireAdmin()).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("acting-account resolver — the carrier column", () => {
  it("puts the delegate's browser back in its own account when the owner is deleted", async () => {
    const { owner, delegate } = await household();
    const session = await signIn(delegate.id);
    await switchTo(session.id, owner.id);

    await getPrismaClient().user.delete({ where: { id: owner.id } });

    const row = await getPrismaClient().session.findUnique({
      where: { id: session.id },
    });
    // The session survives (it belongs to the delegate) with the switch
    // cleared. A CASCADE here would have signed the delegate out of their own
    // account because somebody else deleted theirs.
    expect(row).not.toBeNull();
    expect(row!.actingAsUserId).toBeNull();

    // The deletion also moved the record epoch, so a browser still asserting
    // the pre-deletion context is refused by the fence — that transition is
    // proved in `tests/integration/record-session-fence.test.ts`. What THIS
    // test is about is the column, so it reconciles first (the browser's own
    // `/api/auth/me` bootstrap) and then reads.
    await assertCurrentContext(session.id);
    const body = await (await call()).json();
    expect(body.data.scopeUserId).toBe(delegate.id);
  });
});
