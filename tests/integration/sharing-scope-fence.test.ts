/**
 * v1.37.0 — the section fence, driven as routes against real Postgres.
 *
 * A scoped grant opens the sections it names and leaves the rest unanswered.
 * That sentence is one line of code in the resolver and fifty-seven
 * classifications on the call sites, and the classifications are the part a
 * machine cannot check: the guard freezes the domain a module declares against
 * a literal transcribed from the same table a human read, so a domain assigned
 * wrongly in both places agrees with itself perfectly. It would look like
 * nothing, anywhere, while a delegate scoped to medications quietly read the
 * labs.
 *
 * So this file drives one representative route per section, in-scope and
 * out-of-scope, through the shipped GET exports and the shipped grant
 * transitions. Sixteen legs plus the record-wide pair. What that buys is not
 * proof that every one of the fifty-seven is right — it is proof that the
 * mechanism separates the sections at all, per section, so a wholesale failure
 * (the resolver ignoring the scope, the normaliser reading a set as
 * permissive, one section's routes classified into another's) cannot be
 * silent. The per-module classification stays a review question and says so in
 * the guard.
 *
 * Evidence over verdict, throughout: the in-scope leg asserts the route was
 * REACHED, the out-of-scope leg asserts the refusal AND its audit reason. A
 * file that only asserted the refusals would pass against a resolver that
 * refused everything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

import { SHARE_DOMAINS } from "@/lib/sharing/scope";
import type { ShareDomain } from "@/lib/sharing/scope";
import { bodyWithoutRequestId } from "@/__tests__/helpers/error-envelope";

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

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: `scope-${suffix}`,
      email: `scope-${suffix}@example.test`,
      displayName: `Scope ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      // The cycle probe sits behind its own module gate, which derives from
      // the account's gender when the toggle is NULL. Opted in explicitly so
      // that a 403 from that route means the section fence and not the module
      // gate — two masks, both real, and this file is about one of them.
      gender: "FEMALE",
    },
  });
  await getPrismaClient().cycleProfile.create({
    data: { userId: user.id, cycleTrackingEnabled: true },
  });
  return user;
}

async function signIn(userId: string) {
  return getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
}

/**
 * A live, accepted grant with the delegate's browser already inside the
 * owner's record.
 *
 * Minted through the shipped `inviteGrant` / `acceptGrant` rather than by
 * writing the row: the scope column's write path is part of what is under
 * test, and a row this file wrote itself would keep passing after the invite
 * path stopped storing what it was given.
 */
async function switchInto(
  ownerId: string,
  delegateId: string,
  scope: ShareDomain[] | null,
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: ownerId,
    granteeId: delegateId,
    access: "READ",
    scope,
  });
  const grant = await acceptGrant({
    grantId: invited.id,
    granteeId: delegateId,
  });
  const session = await signIn(delegateId);
  cookieJar.set("healthlog_session", session.id);
  await switchSessionTo(session.id, ownerId);
  return grant;
}

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

async function drive(handler: Handler, url: string): Promise<Response> {
  return handler(new NextRequest(`http://localhost${url}`, { method: "GET" }), {
    params: Promise.resolve({}),
  });
}

/**
 * The sharing refusals filed for this caller so far.
 *
 * The resolver writes them fire-and-forget — the 403 is what protects the
 * record and an audit write that failed must never turn it into a 500 — so
 * the row lands a moment after the response does. Everything here therefore
 * settles first. Without the settle the positive legs below would read an
 * empty table and agree with themselves, which is the exact failure this
 * repository keeps rediscovering: a check that cannot fail.
 */
async function readRefusals(callerId: string): Promise<{ reason?: string }[]> {
  const rows = await getPrismaClient().auditLog.findMany({
    where: { userId: callerId, action: "sharing.access.denied" },
    orderBy: { createdAt: "asc" },
  });
  // `details` is stored as a JSON STRING on this table, not a JSON object —
  // matching it as an object would compare against a string and fail, or, with
  // a looser matcher, pass against anything.
  return rows.map((row) =>
    typeof row.details === "string"
      ? (JSON.parse(row.details) as { reason?: string })
      : ((row.details ?? {}) as { reason?: string }),
  );
}

/**
 * The refusal audit row is written WITHOUT being awaited (`auditRefusal` in
 * `src/lib/api-handler.ts` drops the promise on purpose, so the audit write
 * never delays the 403 a caller is waiting on). The row therefore lands some
 * time after the response returns, and the two assertions here need opposite
 * treatment of that gap.
 *
 * A fixed 150 ms wait served both until a slow CI runner missed it and the
 * positive case read an empty table, which reads exactly like "the section
 * reached the wire" — the one thing this file exists to catch. So the
 * positive case polls until the row appears, and only the absence case pays
 * a fixed wait, which is what makes an absence claim mean anything.
 */
const REFUSAL_APPEAR_TIMEOUT_MS = 5_000;
const REFUSAL_ABSENCE_WAIT_MS = 750;

/** The most recent refusal, waited for. Fails the test when none arrives. */
async function lastRefusal(callerId: string): Promise<{ reason?: string }> {
  const deadline = Date.now() + REFUSAL_APPEAR_TIMEOUT_MS;
  for (;;) {
    const rows = await readRefusals(callerId);
    if (rows.length > 0) return rows[rows.length - 1];
    if (Date.now() >= deadline) {
      throw new Error(
        `no sharing.access.denied audit row for ${callerId} within ${REFUSAL_APPEAR_TIMEOUT_MS} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every refusal on file, after a wait long enough for a late write. */
async function refusals(callerId: string): Promise<{ reason?: string }[]> {
  await new Promise((resolve) => setTimeout(resolve, REFUSAL_ABSENCE_WAIT_MS));
  return readRefusals(callerId);
}

/** No refusal was recorded. Waits before concluding that. */
async function noRefusal(callerId: string): Promise<boolean> {
  return (await refusals(callerId)).length === 0;
}

/* -------------------------------------------------------------------------- */
/* One representative route per section                                       */
/* -------------------------------------------------------------------------- */

interface Probe {
  url: string;
  call: () => Promise<Response>;
}

const PROBES: Record<ShareDomain | "record", Probe> = {
  measurements: {
    url: "/api/measurements",
    call: async () =>
      drive(
        (await import("@/app/api/measurements/route")).GET as Handler,
        "/api/measurements",
      ),
  },
  medications: {
    url: "/api/medications",
    call: async () =>
      drive(
        (await import("@/app/api/medications/route")).GET as Handler,
        "/api/medications",
      ),
  },
  labs: {
    url: "/api/labs",
    call: async () =>
      drive((await import("@/app/api/labs/route")).GET as Handler, "/api/labs"),
  },
  profile: {
    url: "/api/allergies",
    call: async () =>
      drive(
        (await import("@/app/api/allergies/route")).GET as Handler,
        "/api/allergies",
      ),
  },
  illness: {
    url: "/api/illness/episodes",
    call: async () =>
      drive(
        (await import("@/app/api/illness/episodes/route")).GET as Handler,
        "/api/illness/episodes",
      ),
  },
  mind: {
    url: "/api/mood-entries",
    call: async () =>
      drive(
        (await import("@/app/api/mood-entries/route")).GET as Handler,
        "/api/mood-entries",
      ),
  },
  cycle: {
    url: "/api/cycle/cycles",
    call: async () =>
      drive(
        (await import("@/app/api/cycle/cycles/route")).GET as Handler,
        "/api/cycle/cycles",
      ),
  },
  documents: {
    url: "/api/documents/inbound",
    call: async () =>
      drive(
        (await import("@/app/api/documents/inbound/route")).GET as Handler,
        "/api/documents/inbound",
      ),
  },
  record: {
    url: "/api/dashboard/widgets",
    call: async () =>
      drive(
        (await import("@/app/api/dashboard/widgets/route")).GET as Handler,
        "/api/dashboard/widgets",
      ),
  },
};

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("the probe set covers the vocabulary", () => {
  it("has one route per section, plus the record-wide case", () => {
    // The non-zero half. Every leg below iterates this table, so a table that
    // lost a section would silently stop testing it — and a section added to
    // the production enum without a probe would go untested from birth.
    expect(SHARE_DOMAINS.length).toBeGreaterThan(0);
    expect(Object.keys(PROBES).sort()).toEqual(
      [...SHARE_DOMAINS, "record"].sort(),
    );
  });
});

describe("a scoped grant opens the sections it names", () => {
  it.each(SHARE_DOMAINS)("%s answers when the grant names it", async (open) => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await switchInto(owner.id, delegate.id, [open]);

    const response = await PROBES[open].call();

    // Reached, not merely "not 403": a route that answered 500 would satisfy
    // an inequality against 403 and prove nothing about the fence.
    expect(response.status, PROBES[open].url).toBe(200);
    expect(await noRefusal(delegate.id)).toBe(true);
  });

  it.each(SHARE_DOMAINS)(
    "%s is the only section that answers",
    async (open) => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await switchInto(owner.id, delegate.id, [open]);

      const closed = [...SHARE_DOMAINS, "record" as const].filter(
        (d) => d !== open,
      );
      // Non-zero: the loop below must actually run.
      expect(closed.length).toBeGreaterThan(0);

      for (const domain of closed) {
        const response = await PROBES[domain].call();
        expect(response.status, PROBES[domain].url).toBe(403);
        const body = await response.json();
        expect(body.meta?.errorCode, PROBES[domain].url).toBe(
          "sharing.access.denied",
        );
        // The reason is the audit row's, never the caller's. If the section
        // ever reaches the wire this assertion is the one that has to move,
        // which is the point of asserting it here rather than on the body.
        expect(
          await lastRefusal(delegate.id),
          PROBES[domain].url,
        ).toMatchObject({ reason: "out_of_scope" });
      }
    },
  );
});

describe("a NULL scope still opens the whole record", () => {
  it.each([...SHARE_DOMAINS, "record" as const])(
    "%s answers exactly as it did before scoping existed",
    async (domain) => {
      // The no-regression leg. Every grant in the product today is this one,
      // and the release is byte-identical for all of them.
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await switchInto(owner.id, delegate.id, null);

      const response = await PROBES[domain].call();
      expect(response.status, PROBES[domain].url).toBe(200);
      expect(await noRefusal(delegate.id)).toBe(true);
    },
  );
});

describe("an unreadable scope opens nothing", () => {
  it("refuses every section, including one the garbage names", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const grant = await switchInto(owner.id, delegate.id, ["medications"]);

    // Planted directly, because the invite path refuses to write it — which is
    // the point: the read side has to hold on its own, against a value that
    // reached the column by a route this application does not have (a restore
    // from an older shape, a hand-edited row, a future writer with a bug).
    await getPrismaClient().$executeRawUnsafe(
      `UPDATE account_grants SET scope_json = '"medications"'::jsonb WHERE id = $1`,
      grant.id,
    );

    for (const domain of [...SHARE_DOMAINS, "record" as const]) {
      const response = await PROBES[domain].call();
      expect(response.status, PROBES[domain].url).toBe(403);
      expect(await lastRefusal(delegate.id), PROBES[domain].url).toMatchObject({
        reason: "out_of_scope",
      });
    }
  });

  it("refuses even the section a well-formed set would have opened", async () => {
    // The sharpest form of the same claim, and the one that separates
    // fail-closed from fail-open: the string spells a real section name. A
    // normaliser that reached for anything it recognised inside a value it
    // could not parse would let this through.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const grant = await switchInto(owner.id, delegate.id, ["medications"]);

    // Evidence first: the grant works before the column is corrupted, so the
    // refusal below is the corruption and not the fixture.
    expect((await PROBES.medications.call()).status).toBe(200);

    await getPrismaClient().$executeRawUnsafe(
      `UPDATE account_grants SET scope_json = '["medications", "not-a-section"]'::jsonb WHERE id = $1`,
      grant.id,
    );

    expect((await PROBES.medications.call()).status).toBe(403);
    expect(await lastRefusal(delegate.id)).toMatchObject({
      reason: "out_of_scope",
    });
  });
});

describe("the refusal does not distinguish itself", () => {
  it("says the same bytes as a caller who was granted nothing", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await switchInto(owner.id, delegate.id, ["medications"]);
    const outOfScope = await PROBES.labs.call();
    const outOfScopeBody = await bodyWithoutRequestId(outOfScope);

    // A stranger naming the same record. Different story, same answer.
    const stranger = await makeUser("stranger");
    const session = await signIn(stranger.id);
    cookieJar.set("healthlog_session", session.id);
    await switchSessionTo(session.id, owner.id);
    const noGrant = await PROBES.labs.call();

    expect(outOfScope.status).toBe(noGrant.status);
    expect(outOfScopeBody).toBe(await bodyWithoutRequestId(noGrant));
    expect(outOfScopeBody).not.toContain("scope");

    // …and the operator's trail tells them apart, which is the half that has
    // to keep working while the wire stays silent.
    expect(await lastRefusal(stranger.id)).toMatchObject({
      reason: "no_active_grant",
    });
  });
});
