/**
 * What the audit trail records for a delegated action, and for a self action.
 *
 * The whole feature rests on one reading: `actorUserId` NULL means the account
 * acted for itself. Every row written before the column existed means that,
 * and every row written after it will mostly mean it too — so a threading rule
 * that stamps an actor where none was acting does not add information, it
 * changes what several years of history says. That reading is what these tests
 * hold, against real rows.
 *
 * Round trips through the real routes, for the reason that cost this project a
 * release: a unit stub proves the code ran, not what landed. Here the question
 * is only ever "which row exists afterwards, and what is in its columns".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

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
import { auditLog, DELEGATED_ACCESS_ACTION } from "@/lib/auth/audit";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `audit-${suffix}`,
      email: `audit-${suffix}@example.test`,
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

/**
 * A delegable route that writes an audit row the way a migrated route does:
 * `userId` from the resolved data scope, and nothing about the actor, because
 * the actor is not the handler's business.
 */
const delegableAction: (request: NextRequest) => Promise<Response> = apiHandler(
  async () => {
    const { user } = await requireRecordAuth("read", "measurements");
    await auditLog("measurement.read", {
      userId: user.id,
      details: { via: "test" },
    });
    return NextResponse.json({ data: { ok: true }, error: null });
  },
);

/** The same handler's self-action case: no switch, same code path. */
function act(): Promise<Response> {
  return delegableAction(
    new NextRequest("http://localhost/api/test/delegable", { method: "GET" }),
  );
}

async function household() {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access: "READ",
    scope: null,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
  const session = await signIn(delegate.id);
  await switchSessionTo(session.id, owner.id);
  return { owner, delegate, session };
}

async function rowsFor(action: string) {
  return getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Poll the trail until `action` carries exactly `count` rows, then return
 * them. The access rows are fire-and-forget, and the old fixed 80 ms grace
 * was a race the assertion lost whenever the runner was busy — which is
 * exactly when CI is slowest and least willing to explain itself. On
 * timeout the poll asserts against the real count, so a genuine regression
 * reports what WAS written rather than a bare timeout.
 */
async function rowsSettled(action: string, count: number) {
  await expect
    .poll(async () => (await rowsFor(action)).length, {
      timeout: 5_000,
      interval: 100,
    })
    .toBe(count);
  return rowsFor(action);
}

/**
 * The ONE remaining fixed grace, for the absence assertion below —
 * "writes nothing when nobody delegates" cannot be polled into existence
 * (there is no value to wait for), so it waits a bounded span and then
 * proves the silence. Widened from the old 80 ms so a busy runner cannot
 * turn a late write into a false pass.
 */
async function settleForAbsence() {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("who the trail says did it", () => {
  it("files a delegated action under the owner, naming the delegate", async () => {
    const { owner, delegate } = await household();

    expect((await act()).status).toBe(200);

    const rows = await rowsFor("measurement.read");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.id);
    expect(rows[0].actorUserId).toBe(delegate.id);
  });

  it("leaves the actor NULL when somebody acts on their own record", async () => {
    // The load-bearing one. NULL is not "we did not know" — it is the
    // statement every historical row already makes, and the same handler,
    // unswitched, has to keep making it.
    const solo = await makeUser("solo");
    await signIn(solo.id);

    expect((await act()).status).toBe(200);

    const rows = await rowsFor("measurement.read");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(solo.id);
    expect(rows[0].actorUserId).toBeNull();
  });

  it("leaves the actor NULL on a row a delegate writes about themselves", async () => {
    // A delegated request that files under the DELEGATE describes the
    // delegate's own act. Stamping the actor there would say "somebody else
    // did this to you" about a person acting on themselves.
    const { delegate } = await household();

    const handler: (request: NextRequest) => Promise<Response> = apiHandler(
      async () => {
        const { actor } = await requireRecordAuth("read", "measurements");
        await auditLog("delegate.own.act", { userId: actor.id });
        return NextResponse.json({ data: { ok: true }, error: null });
      },
    );
    await handler(
      new NextRequest("http://localhost/api/test/delegable", { method: "GET" }),
    );

    const rows = await rowsFor("delegate.own.act");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(delegate.id);
    expect(rows[0].actorUserId).toBeNull();
  });

  it("leaves the actor NULL on a refused delegation", async () => {
    // The refusal row already exists (the resolver writes it). It is the
    // caller's own act — an attempt they made as themselves — and it must not
    // acquire an actor just because the request mentioned another account.
    const delegate = await makeUser("delegate");
    const stranger = await makeUser("stranger");
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, stranger.id);

    expect((await act()).status).toBe(403);

    const rows = await rowsSettled("sharing.access.denied", 1);
    expect(rows[0].userId).toBe(delegate.id);
    expect(rows[0].actorUserId).toBeNull();
  });
});

describe("delegated reads coalesce to one row a day", () => {
  it("writes one row for many reads, and counts them", async () => {
    const { owner, delegate } = await household();

    await act();
    await act();
    await act();

    // Poll on the COUNTED value: the coalesced row exists after the first
    // read, so a length poll would pass while increments are still in
    // flight.
    await expect
      .poll(
        async () => {
          const rows = await rowsFor(DELEGATED_ACCESS_ACTION);
          return rows.length === 1
            ? (JSON.parse(rows[0].details ?? "{}") as { accesses?: number })
                .accesses
            : null;
        },
        { timeout: 5_000, interval: 100 },
      )
      .toBe(3);

    const rows = await rowsFor(DELEGATED_ACCESS_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.id);
    expect(rows[0].actorUserId).toBe(delegate.id);
  });

  it("keeps a second delegate's reads on their own row", async () => {
    // Coalescing is per (owner, delegate, day). Two delegates in one record on
    // one day are two rows — merging them would answer "somebody was in your
    // record" when the owner asked "who".
    const { owner, delegate } = await household();
    const second = await makeUser("second");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: second.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: second.id });

    await act();
    const secondSession = await signIn(second.id);
    await switchSessionTo(secondSession.id, owner.id);
    await act();

    const rows = await rowsSettled(DELEGATED_ACCESS_ACTION, 2);
    expect(rows.map((r) => r.actorUserId).sort()).toEqual(
      [delegate.id, second.id].sort(),
    );
    expect(rows.every((r) => r.userId === owner.id)).toBe(true);
  });

  it("starts a new row on the next day", async () => {
    const { owner, delegate } = await household();

    await act();
    await rowsSettled(DELEGATED_ACCESS_ACTION, 1);

    // Age today's row by a day. The coalescing key is the row's own date, so
    // this is exactly what tomorrow looks like to the next read — and if the
    // key were "the latest row" rather than the day, the next read would still
    // find this one and the trail would grow one row per delegate forever.
    await getPrismaClient().$executeRaw`
      UPDATE audit_logs
      SET created_at = created_at - INTERVAL '1 day'
      WHERE action = ${DELEGATED_ACCESS_ACTION}
    `;

    await act();

    const rows = await rowsSettled(DELEGATED_ACCESS_ACTION, 2);
    expect(rows.every((r) => r.userId === owner.id)).toBe(true);
    expect(rows.every((r) => r.actorUserId === delegate.id)).toBe(true);
  });

  it("writes nothing at all when nobody is delegating", async () => {
    const solo = await makeUser("solo");
    await signIn(solo.id);

    await act();
    await settleForAbsence();

    expect(await rowsFor(DELEGATED_ACCESS_ACTION)).toHaveLength(0);
  });
});

describe("the lifecycle verbs leave their own trail", () => {
  it("records the invitation, the acceptance and the revocation", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");

    await signIn(owner.id);
    const { POST } = await import("@/app/api/account/grants/route");
    const invited = await POST(
      new NextRequest("http://localhost/api/account/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: delegate.username }),
      }),
    );
    const grantId = (await invited.json()).data.id;

    await signIn(delegate.id);
    const accept = await import("@/app/api/account/grants/[id]/accept/route");
    await accept.POST(
      new NextRequest(`http://localhost/api/account/grants/${grantId}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: grantId }) },
    );

    await signIn(owner.id);
    const revokeRoute = await import("@/app/api/account/grants/[id]/route");
    await revokeRoute.DELETE(
      new NextRequest(`http://localhost/api/account/grants/${grantId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: grantId }) },
    );

    const trail = await getPrismaClient().auditLog.findMany({
      where: { action: { startsWith: "sharing.grant." } },
      orderBy: { createdAt: "asc" },
    });
    expect(trail.map((r) => r.action)).toEqual([
      "sharing.grant.invited",
      "sharing.grant.accepted",
      "sharing.grant.revoked",
    ]);
    // Each row files under whoever performed it, acting as themselves. The
    // owner's side of the acceptance is not an audit row at all — it is
    // `acceptedAt` on the grant, which is the durable consent record.
    expect(trail.map((r) => r.userId)).toEqual([
      owner.id,
      delegate.id,
      owner.id,
    ]);
    expect(trail.every((r) => r.actorUserId === null)).toBe(true);
  });
});

/**
 * A view-only delegate sends a query the route cannot parse.
 *
 * This is the sharpest case the activity feed has, and it shipped saying the
 * wrong thing. `GET /api/mood-entries` resolves `requireRecordAuth("read",
 * "mind")` and files `mood-entries.list.validation-failed` through `auditLog`
 * on a malformed query — deliberately through the helper, because that is what
 * stamps `actorUserId` and the row is meant to be attributable. The feed
 * selects every actor-stamped row with no action allowlist, and the verb map
 * had no arm for any `*.validation-failed` action, so the owner was told that
 * a person holding VIEW-ONLY access had made a change in their record.
 *
 * Nothing had changed. Nothing could have: the request was refused at the
 * schema. So the whole round trip is asserted here rather than only the map —
 * that the row lands, that it is attributed, and that the sentence the owner
 * would read is an attempt rather than an act.
 */
describe("a refused read is reported as a refused read", () => {
  it("files an attributable row and renders it as an attempt, not a change", async () => {
    const { owner, delegate } = await household();

    const { GET } = await import("@/app/api/mood-entries/route");
    const response = await GET(
      new NextRequest("http://localhost/api/mood-entries?limit=not-a-number", {
        method: "GET",
      }),
    );
    expect(response.status).toBe(422);

    // The breadcrumb is fire-and-forget, which is the property that made it
    // invisible to a guard reading only awaited calls.
    const rows = await rowsSettled("mood-entries.list.validation-failed", 1);
    expect(rows[0]?.userId).toBe(owner.id);
    expect(rows[0]?.actorUserId).toBe(delegate.id);

    // Which means it reaches the owner's feed: same predicate the route uses.
    const feedRows = await getPrismaClient().auditLog.findMany({
      where: {
        userId: owner.id,
        actorUserId: { not: null },
        NOT: { actorUserId: owner.id },
      },
    });
    expect(feedRows.map((r) => r.action)).toContain(
      "mood-entries.list.validation-failed",
    );

    // And what it says there. The English bundle is read rather than a key
    // asserted, because the defect was the SENTENCE, not the wiring.
    const { recordActivityVerbLine } =
      await import("@/lib/record-activity/activity-verb");
    const en = JSON.parse(
      await readFile(join(process.cwd(), "messages/en.json"), "utf8"),
    ) as Record<string, Record<string, Record<string, string>>>;
    const sentence = recordActivityVerbLine(
      (key, params) =>
        (en.recordSharing.activityVerb[key.split(".").pop()!] ?? key).replace(
          "{name}",
          String(params?.name ?? ""),
        ),
      rows[0]!.action,
      "Alex",
    );

    expect(sentence).not.toContain("made a change");
    expect(sentence).toBe("Alex sent a mood search this record could not read");
  });
});

/**
 * What the owner's activity feed claims, and what it can actually see.
 *
 * Two completeness claims live on this response and the surface states both.
 * They were both wrong in the same direction — too confident — and in opposite
 * ways:
 *
 *   * the copy promised a window ("who entered what stays answerable for N
 *     days") while the query had no date filter at all, so on an instance
 *     whose retention was shortened the view showed rows the sentence said
 *     were gone;
 *   * the query stopped at a hundred rows and said nothing, so an owner who
 *     scrolled to the bottom read the oldest visible line as the beginning.
 *
 * Driven against real rows rather than a mocked Prisma, because both claims
 * are about what the DATABASE returns for a given `where` — a stubbed client
 * would answer whatever the stub was told and prove neither.
 */
describe("the activity feed states its own limits", () => {
  async function feed() {
    const { GET } = await import("@/app/api/account/activity/route");
    const response = await GET();
    expect(response.status).toBe(200);
    return (await response.json()) as {
      data: {
        entries: { action: string }[];
        retentionDays: number;
        truncated: boolean;
      };
      meta: { truncated: boolean; limit: number };
    };
  }

  /** One delegated row, back-dated. */
  async function stampedRow(
    ownerId: string,
    delegateId: string,
    createdAt: Date,
    action = "measurement.update",
  ) {
    await getPrismaClient().auditLog.create({
      data: { userId: ownerId, actorUserId: delegateId, action, createdAt },
    });
  }

  it("does not show a row older than the window it promises", async () => {
    const { owner, delegate } = await household();
    await signIn(owner.id);

    const days = (await feed()).data.retentionDays;
    expect(days).toBeGreaterThan(0);

    const inside = new Date(Date.now() - 60_000);
    const outside = new Date(Date.now() - (days + 2) * 86_400_000);
    await stampedRow(owner.id, delegate.id, inside, "measurement.update");
    await stampedRow(owner.id, delegate.id, outside, "measurement.delete");

    const { data } = await feed();
    const actions = data.entries.map((e) => e.action);
    // The positive control matters more than the absence: a filter that
    // excluded everything would satisfy the second assertion alone.
    expect(actions).toContain("measurement.update");
    expect(actions).not.toContain("measurement.delete");
  });

  it("says when the list is the most recent rows rather than all of them", async () => {
    const { owner, delegate } = await household();
    await signIn(owner.id);

    // Under the ceiling: the list IS everything, and says so.
    for (let i = 0; i < 3; i += 1) {
      await stampedRow(owner.id, delegate.id, new Date(Date.now() - i * 1000));
    }
    const small = await feed();
    expect(small.data.entries).toHaveLength(3);
    // The cap rides the envelope, like every capped list's.
    expect(small.meta.truncated).toBe(false);
    // The field v1.43.6 shipped in `data` stays, deprecated, with the same
    // value.
    expect(small.data.truncated).toBe(false);

    // Over it: same shape, different claim.
    await getPrismaClient().auditLog.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        userId: owner.id,
        actorUserId: delegate.id,
        action: "measurement.update",
        createdAt: new Date(Date.now() - (i + 10) * 1000),
      })),
    });
    const large = await feed();
    expect(large.data.entries).toHaveLength(100);
    expect(large.meta).toMatchObject({ truncated: true, limit: 100 });
    expect(large.data.truncated).toBe(true);
  });
});
