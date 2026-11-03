/**
 * The eleven delegated writes, driven as routes, against real Postgres.
 *
 * Same construction as `sharing-delegable-routes.test.ts` and for the same
 * reason: every case imports the shipped `POST` export and calls it, so the
 * real `apiHandler`, the real `requireRecordAuth`, the real grant table and
 * the real Prisma writes are what answer. A test that rebuilt a handler would
 * be testing its own copy of a substitution that happens above the handler
 * body, and would keep passing after the route stopped performing it.
 *
 * The grant is minted through `inviteGrant` + `acceptGrant` rather than
 * hand-planted, because "a WRITE grant exists" and "a WRITE grant can be
 * created by the invitation flow this release ships" are different claims and
 * the second is the one a caregiver depends on.
 *
 * Five questions per verb:
 *
 *   1. a delegate with a live WRITE grant writes into the OWNER's record —
 *      the row lands under the owner and NOT under the delegate;
 *   2. the same delegate under a READ grant is refused
 *      `sharing.access.denied`, and no row is written;
 *   3. a caller who was never granted anything is refused the same way;
 *   4. after revocation the very NEXT request is refused — no re-login, no
 *      cache window;
 *   5. a caller who has not switched gets exactly what they got before.
 *
 * (5) is the regression that matters most. Eleven verbs changed; a person who
 * shares nothing must not be able to tell.
 *
 * Beyond the five, three properties that are specific rather than structural:
 * the audit row carries `userId = owner` AND `actorUserId = delegate` (the
 * pipe, not just the ends — `actingActorFor` reads the wide-event context, so
 * a stamped row proves the context was set); the side-effect rate bucket keys
 * on the ACTOR; and both intake routes hand the OWNER and the ACTOR to the
 * notification helper rather than one id twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

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

/**
 * The one collaborator this file stubs, and only at the seam it is testing.
 *
 * What the helper DOES — the cascade, the preference row, the ledger, the
 * self-refusal, the snooze refusal — is proved end to end against the real
 * dispatcher in `delegated-intake-notification.test.ts`. What that file cannot
 * see is whether the two intake routes hand it the owner and the actor the
 * right way round, because the helper's own self-refusal makes an
 * `ownerId === actorId` mix-up look exactly like a self-write: silent. So this
 * file asserts the arguments the routes pass, which is the half of the pipe
 * the other file leaves open.
 */
const notifyDelegatedIntake = vi.fn(async (_input: unknown) => {});
vi.mock("@/lib/notifications/delegated-intake", () => ({
  notifyDelegatedIntake: (input: unknown) => notifyDelegatedIntake(input),
}));

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `dw-${suffix}`,
      email: `dw-${suffix}@example.test`,
      displayName: `DW ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
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
 * A live grant at the named level, accepted, with the delegate's session
 * already inside the owner's record.
 *
 * Through `inviteGrant` / `acceptGrant` — the shipped transitions — so a
 * release that could not actually mint a WRITE grant would fail here rather
 * than pass against a row this file wrote itself.
 */
async function switchInto(
  ownerId: string,
  delegateId: string,
  access: "READ" | "WRITE" | "MANAGE",
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: ownerId,
    granteeId: delegateId,
    access,
    scope: null,
  });
  const grant = await acceptGrant({
    grantId: invited.id,
    granteeId: delegateId,
  });
  expect(grant.access).toBe(access);
  expect(grant.acceptedAt).not.toBeNull();

  const session = await signIn(delegateId);
  await switchSessionTo(session.id, ownerId);
  return { grant, session };
}

/** A session inside a record nobody ever shared with this caller. */
async function claimWithoutGrant(ownerId: string, callerId: string) {
  const session = await signIn(callerId);
  await switchSessionTo(session.id, ownerId);
}

async function revoke(grantId: string, ownerId: string) {
  const { revokeGrant } = await import("@/lib/sharing/grants");
  await revokeGrant({ grantId, grantorId: ownerId });
}

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

function postRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(
  handler: Handler,
  url: string,
  body: unknown,
  params: Record<string, string> = {},
): Promise<Response> {
  return handler(postRequest(url, body), { params: Promise.resolve(params) });
}

async function payload(response: Response): Promise<{
  data: unknown;
  error: unknown;
  meta?: { errorCode?: string };
}> {
  return response.json();
}

/** The stable refusal, asserted by code rather than by status alone. */
async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  expect((await payload(response)).meta?.errorCode).toBe(
    "sharing.access.denied",
  );
}

const ISO = "2026-07-15T08:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* The shape of a delegated-write case                                        */
/* -------------------------------------------------------------------------- */

interface WriteCase<C> {
  /** Rows the write depends on, created under the record it will land in. */
  prepare?: (recordOwnerId: string) => Promise<C>;
  /** Drive the shipped POST export against the current session. */
  call: (ctx: C) => Promise<Response>;
  /** The status a successful write answers with. */
  ok: number;
  /** The action the happy path files through `auditLog`. */
  auditAction: string;
  /** How many rows this verb has written under a given account. */
  count: (userId: string) => Promise<number>;
}

/**
 * The five legs, run against one verb.
 *
 * `prepare` runs against whichever account the write is aimed at, so the
 * delegated legs build their prerequisites under the OWNER — a delegate
 * pointing at a metric or a medication of their own is a different test, and
 * the read suite already pins that it 404s.
 */
function writeContract<C>(name: string, c: WriteCase<C>) {
  const prepare = c.prepare ?? (async () => undefined as C);

  describe(name, () => {
    it("writes into the owner's record under a live WRITE grant", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const ctx = await prepare(owner.id);

      await switchInto(owner.id, delegate.id, "WRITE");
      const response = await c.call(ctx);

      expect(response.status).toBe(c.ok);
      // Under the owner, and under nobody else. Asserting the owner's count
      // alone would pass on a handler that wrote a row to each account.
      expect(await c.count(owner.id)).toBe(1);
      expect(await c.count(delegate.id)).toBe(0);
    });

    it("files the audit row under the owner and names the delegate as actor", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const ctx = await prepare(owner.id);

      await switchInto(owner.id, delegate.id, "WRITE");
      expect((await c.call(ctx)).status).toBe(c.ok);

      const row = await getPrismaClient().auditLog.findFirst({
        where: { action: c.auditAction },
        orderBy: { createdAt: "desc" },
      });
      // The row exists at all — the audit assertion below is worthless
      // against a null, and `toBe(undefined)` would pass on one.
      expect(row, `no ${c.auditAction} row was written`).not.toBeNull();
      expect(row?.userId).toBe(owner.id);
      expect(row?.actorUserId).toBe(delegate.id);
    });

    it("refuses the same delegate under a READ grant, and writes nothing", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const ctx = await prepare(owner.id);

      await switchInto(owner.id, delegate.id, "READ");
      await expectDenied(await c.call(ctx));

      expect(await c.count(owner.id)).toBe(0);
      expect(await c.count(delegate.id)).toBe(0);
    });

    it("refuses a caller who names a record they were never granted", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      const ctx = await prepare(owner.id);

      await claimWithoutGrant(owner.id, stranger.id);
      await expectDenied(await c.call(ctx));

      expect(await c.count(owner.id)).toBe(0);
      expect(await c.count(stranger.id)).toBe(0);
    });

    it("refuses the next request after the grant is revoked", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const ctx = await prepare(owner.id);

      const { grant } = await switchInto(owner.id, delegate.id, "WRITE");
      expect((await c.call(ctx)).status).toBe(c.ok);

      // No sign-out, no new session, no cache flush. The same browser, the
      // next request. The refusal comes from the resolver, above the handler
      // body, so replaying the identical request is the sharpest form of the
      // question: the ONLY thing that changed is the grant.
      await revoke(grant.id, owner.id);
      await expectDenied(await c.call(ctx));
      expect(await c.count(owner.id)).toBe(1);
    });

    it("is unchanged for a caller who has not switched", async () => {
      const plain = await makeUser("plain");
      const ctx = await prepare(plain.id);
      await signIn(plain.id);

      const response = await c.call(ctx);
      expect(response.status).toBe(c.ok);
      expect(await c.count(plain.id)).toBe(1);

      // And the row is filed as their own act: `actorUserId` stays null, which
      // is what every row written before the column existed already means.
      const row = await getPrismaClient().auditLog.findFirst({
        where: { action: c.auditAction },
        orderBy: { createdAt: "desc" },
      });
      expect(row?.userId).toBe(plain.id);
      expect(row?.actorUserId).toBeNull();
    });
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  notifyDelegatedIntake.mockClear();
});

/* -------------------------------------------------------------------------- */
/* 1 — measurements, single and batch                                          */
/* -------------------------------------------------------------------------- */

const countMeasurements = (userId: string) =>
  getPrismaClient().measurement.count({ where: { userId } });

writeContract("POST /api/measurements — single", {
  call: async () => {
    const { POST } = await import("@/app/api/measurements/route");
    return post(POST as Handler, "/api/measurements", {
      type: "WEIGHT",
      value: 81,
      measuredAt: ISO,
    });
  },
  ok: 201,
  auditAction: "measurement.create",
  count: countMeasurements,
});

writeContract("POST /api/measurements — batch", {
  call: async () => {
    const { POST } = await import("@/app/api/measurements/route");
    return post(POST as Handler, "/api/measurements", [
      { type: "WEIGHT", value: 81, measuredAt: ISO },
    ]);
  },
  ok: 201,
  auditAction: "measurement.create.batch",
  count: countMeasurements,
});

/* -------------------------------------------------------------------------- */
/* 2 — labs, and the biomarker the free-text path mints                        */
/* -------------------------------------------------------------------------- */

writeContract("POST /api/labs", {
  call: async () => {
    const { POST } = await import("@/app/api/labs/route");
    return post(POST as Handler, "/api/labs", {
      analyte: "HbA1c",
      value: 5.2,
      unit: "mmol/L",
      takenAt: ISO,
    });
  },
  ok: 201,
  auditAction: "labResult.create",
  count: (userId) => getPrismaClient().labResult.count({ where: { userId } }),
});

describe("POST /api/labs — the marker the free-text path mints", () => {
  it("joins the OWNER's catalogue, not the delegate's", async () => {
    // A result added to somebody's record whose marker landed on the helper's
    // account would leave the owner with a reading they cannot chart. The
    // mint is a second write, under a second table, on the same request.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await switchInto(owner.id, delegate.id, "WRITE");

    const { POST } = await import("@/app/api/labs/route");
    const response = await post(POST as Handler, "/api/labs", {
      analyte: "Ferritin",
      value: 120,
      unit: "µg/L",
      takenAt: ISO,
    });
    expect(response.status).toBe(201);

    const markers = await getPrismaClient().biomarker.findMany({
      select: { userId: true, name: true },
    });
    expect(markers).toEqual([{ userId: owner.id, name: "Ferritin" }]);

    const result = await getPrismaClient().labResult.findFirstOrThrow({});
    expect(result.userId).toBe(owner.id);
    expect(result.biomarkerId).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — biomarkers                                                             */
/* -------------------------------------------------------------------------- */

writeContract("POST /api/biomarkers", {
  call: async () => {
    const { POST } = await import("@/app/api/biomarkers/route");
    return post(POST as Handler, "/api/biomarkers", {
      name: "Ferritin",
      unit: "µg/L",
    });
  },
  ok: 201,
  auditAction: "biomarker.create",
  count: (userId) => getPrismaClient().biomarker.count({ where: { userId } }),
});

/* -------------------------------------------------------------------------- */
/* 4 + 5 — allergies and family history, admitted at MANAGE                    */
/* -------------------------------------------------------------------------- */

/**
 * The MANAGE contract, and why the WRITE one will not do.
 *
 * `writeContract` above asserts that a WRITE grant writes. A route that
 * declares `requireRecordAuth("manage", …)` must REFUSE a WRITE grant, so the
 * two contracts differ in their first leg and agree on every other: the row
 * lands under the owner and under nobody else, the audit row is filed under the
 * owner with the delegate named as actor, the refusals are the stable
 * `sharing.access.denied`, revocation takes effect on the very next request,
 * and an unswitched owner is unaffected.
 *
 * Two legs are new coverage rather than a rewrite, and they are the reason this
 * block exists. Nothing in the repository drove a MANAGE delegate against
 * either of these routes before, and nothing drove a Guardian against them at
 * all — the routes had admitted the write since the level shipped while the
 * only form that posts to them was classified unavailable, so the permission
 * had no reachable caller. Plan 13 opened the surface; these are the legs that
 * say the write it leads to actually lands.
 *
 * What this block replaces is a `refusedWriteContract` whose legs asserted
 * `sharing.not_permitted` — the refusal a route that declares NO sharing mode
 * returns. These routes declare one, so a READ or WRITE delegate gets
 * `sharing.access.denied` instead, and those four assertions had been failing
 * against the shipped routes for a release.
 */
function manageWriteContract<C>(name: string, c: WriteCase<C>) {
  const prepare = c.prepare ?? (async () => undefined as C);

  describe(name, () => {
    it("writes into the owner's record under a live MANAGE grant", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const ctx = await prepare(owner.id);

      await switchInto(owner.id, delegate.id, "MANAGE");
      const response = await c.call(ctx);

      expect(response.status).toBe(c.ok);
      // Under the owner, and under nobody else.
      expect(await c.count(owner.id)).toBe(1);
      expect(await c.count(delegate.id)).toBe(0);
    });

    it("writes into a managed profile for its Guardian", async () => {
      // The population the surface exists for, driven through the shipped
      // creation service rather than a hand-planted grant: a Guardian is a
      // MANAGE holder on a credential-less record, and this is the only place
      // in the suite that puts one against these routes.
      const guardian = await makeUser("guardian");
      const { createManagedProfile } =
        await import("@/lib/managed-profiles/create");
      const { profile } = await createManagedProfile({
        creatorId: guardian.id,
        displayName: "Managed profile",
        dateOfBirth: null,
        locale: "de",
        timezone: "Europe/Berlin",
      });
      const ctx = await prepare(profile.id);

      const session = await signIn(guardian.id);
      await switchSessionTo(session.id, profile.id);

      expect((await c.call(ctx)).status).toBe(c.ok);
      expect(await c.count(profile.id)).toBe(1);
      expect(await c.count(guardian.id)).toBe(0);
    });

    it("files the audit row under the owner and names the delegate as actor", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const ctx = await prepare(owner.id);

      await switchInto(owner.id, delegate.id, "MANAGE");
      expect((await c.call(ctx)).status).toBe(c.ok);

      const row = await getPrismaClient().auditLog.findFirst({
        where: { action: c.auditAction },
        orderBy: { createdAt: "desc" },
      });
      expect(row, `no ${c.auditAction} row was written`).not.toBeNull();
      expect(row?.userId).toBe(owner.id);
      expect(row?.actorUserId).toBe(delegate.id);
    });

    for (const access of ["READ", "WRITE"] as const) {
      it(`refuses a ${access} delegate with sharing.access.denied, and writes nothing`, async () => {
        const owner = await makeUser("owner");
        const delegate = await makeUser("delegate");
        const ctx = await prepare(owner.id);

        await switchInto(owner.id, delegate.id, access);
        // The insufficient-level refusal, not the undeclared-mode one. The
        // route names a mode; what the delegate lacks is the level.
        await expectDenied(await c.call(ctx));

        expect(await c.count(owner.id)).toBe(0);
        expect(await c.count(delegate.id)).toBe(0);
      });
    }

    it("refuses a caller who names a record they were never granted", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      const ctx = await prepare(owner.id);

      await claimWithoutGrant(owner.id, stranger.id);
      await expectDenied(await c.call(ctx));

      expect(await c.count(owner.id)).toBe(0);
      expect(await c.count(stranger.id)).toBe(0);
    });

    it("refuses the next request after the grant is revoked", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const ctx = await prepare(owner.id);

      const { grant } = await switchInto(owner.id, delegate.id, "MANAGE");
      expect((await c.call(ctx)).status).toBe(c.ok);

      await revoke(grant.id, owner.id);
      await expectDenied(await c.call(ctx));
      expect(await c.count(owner.id)).toBe(1);
    });

    it("is unchanged for a caller who has not switched", async () => {
      const plain = await makeUser("plain");
      const ctx = await prepare(plain.id);
      await signIn(plain.id);

      const response = await c.call(ctx);
      expect(response.status).toBe(c.ok);
      expect(await c.count(plain.id)).toBe(1);

      const row = await getPrismaClient().auditLog.findFirst({
        where: { action: c.auditAction },
        orderBy: { createdAt: "desc" },
      });
      expect(row?.userId).toBe(plain.id);
      expect(row?.actorUserId).toBeNull();
    });
  });
}

manageWriteContract("POST /api/allergies", {
  call: async () => {
    const { POST } = await import("@/app/api/allergies/route");
    return post(POST as Handler, "/api/allergies", {
      substance: "Penicillin",
      category: "MEDICATION",
      severity: "SEVERE",
    });
  },
  ok: 201,
  auditAction: "allergy.create",
  count: (userId) => getPrismaClient().allergy.count({ where: { userId } }),
});

manageWriteContract("POST /api/family-history", {
  call: async () => {
    const { POST } = await import("@/app/api/family-history/route");
    return post(POST as Handler, "/api/family-history", {
      relationship: "MOTHER",
      condition: "Type 2 diabetes",
    });
  },
  ok: 201,
  auditAction: "family-history.create",
  count: (userId) =>
    getPrismaClient().familyHistoryEntry.count({ where: { userId } }),
});

/* -------------------------------------------------------------------------- */
/* 6 — illness episodes, and the module gate that follows the record          */
/* -------------------------------------------------------------------------- */

writeContract("POST /api/illness/episodes", {
  call: async () => {
    const { POST } = await import("@/app/api/illness/episodes/route");
    return post(POST as Handler, "/api/illness/episodes", {
      label: "Influenza",
      type: "INFECTION",
    });
  },
  ok: 201,
  auditAction: "illness.episode.create",
  count: (userId) =>
    getPrismaClient().illnessEpisode.count({ where: { userId } }),
});

describe("POST /api/illness/episodes — the module gate", () => {
  it("refuses when the OWNER switched illness tracking off, whatever the delegate set", async () => {
    // The recorded decision: the module map governs which parts of a RECORD
    // exist, so it is read off the record. A delegate who runs the module on
    // their own account does not thereby gain an episode surface inside
    // somebody else's.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { illness: false } },
    });
    await getPrismaClient().user.update({
      where: { id: delegate.id },
      data: { modulePreferencesJson: { illness: true } },
    });

    await switchInto(owner.id, delegate.id, "WRITE");
    const { POST } = await import("@/app/api/illness/episodes/route");
    const response = await post(POST as Handler, "/api/illness/episodes", {
      label: "Influenza",
      type: "INFECTION",
    });

    expect(response.status).toBe(403);
    expect((await payload(response)).meta?.errorCode).toBe("illness.disabled");
    expect(
      await getPrismaClient().illnessEpisode.count({
        where: { userId: owner.id },
      }),
    ).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 7 — custom-metric entries, the third that is NOT delegable                 */
/* -------------------------------------------------------------------------- */

/**
 * The contract for a route that declares NO sharing mode at all.
 *
 * Its legs assert `sharing.not_permitted` — the refusal the carrier collects
 * before any grant is consulted — which is a different fact from
 * `sharing.access.denied` and is what makes the pair worth keeping apart. A
 * route that names a mode and refuses a level answers the second; a route that
 * names nothing answers the first, and a WRITE grant makes no difference to it.
 *
 * v1.37.0 — allergies and family history left this helper for
 * `manageWriteContract` above, in the same diff as the surface that made their
 * admitted writes reachable. One caller remains.
 */
function refusedWriteContract<C = undefined>(
  name: string,
  c: {
    /** Seed whatever the write needs, owned by the RECORD. Mirrors `writeContract`. */
    prepare?: (recordOwnerId: string) => Promise<C>;
    call: (ctx: C) => Promise<Response>;
    ok: number;
    count: (userId: string) => Promise<number>;
  },
) {
  const prepare = c.prepare ?? (async () => undefined as C);

  describe(name, () => {
    for (const access of ["READ", "WRITE"] as const) {
      it(`refuses a delegate holding a ${access} grant, and writes nothing`, async () => {
        const owner = await makeUser("owner");
        const delegate = await makeUser("delegate");
        const ctx = await prepare(owner.id);

        await switchInto(owner.id, delegate.id, access);
        const response = await c.call(ctx);

        // The undeclared-mode refusal, not the no-grant one: the route names
        // no sharing mode at all, so the carrier is refused before any grant
        // is consulted. A WRITE grant makes no difference, which is the point.
        expect(response.status).toBe(403);
        expect((await payload(response)).meta?.errorCode).toBe(
          "sharing.not_permitted",
        );

        // Neither account, not just not the owner's — a handler that fell
        // back to the caller would have written a row somewhere.
        expect(await c.count(owner.id)).toBe(0);
        expect(await c.count(delegate.id)).toBe(0);
      });
    }

    it("still lets the owner write it themselves", async () => {
      const owner = await makeUser("owner");
      const ctx = await prepare(owner.id);
      await signIn(owner.id);

      const response = await c.call(ctx);

      expect(response.status).toBe(c.ok);
      expect(await c.count(owner.id)).toBe(1);
    });
  });
}

/**
 * The third withdrawal, one release after the other two, and the delay is what
 * makes it worth a paragraph: the rule that removed allergies and family
 * history fitted this route exactly and was applied to two of the three.
 *
 * The only surface that posts a tracked value is the entry form on
 * `/custom-metrics/{id}`, which is not a shared-record destination — the shell
 * renders "not part of what was shared" there before the form mounts, and
 * `custom-metric-list.tsx` said so in its own comment while returning null. So
 * the permission shipped named on the consent screen, in six languages, with
 * nothing behind it.
 *
 * The GET arm stays delegable and the read suite pins it. Re-admitting means
 * the same three moves the block above names, in the same diff as the surface
 * that makes it reachable.
 */
refusedWriteContract<string>("POST /api/custom-metrics/[id]/entries", {
  prepare: async (recordOwnerId) => {
    const metric = await getPrismaClient().customMetric.create({
      data: { userId: recordOwnerId, name: "Water", unit: "ml" },
    });
    return metric.id;
  },
  call: async (metricId) => {
    const { POST } =
      await import("@/app/api/custom-metrics/[id]/entries/route");
    return post(
      POST as Handler,
      `/api/custom-metrics/${metricId}/entries`,
      { value: 250, measuredAt: ISO },
      { id: metricId },
    );
  },
  ok: 201,
  count: (userId) =>
    getPrismaClient().customMetricEntry.count({ where: { userId } }),
});

/* -------------------------------------------------------------------------- */
/* 8 — medication side effects, and the actor-keyed bucket                    */
/* -------------------------------------------------------------------------- */

async function seedMedication(userId: string, name = "Statin") {
  return getPrismaClient().medication.create({
    data: { userId, name, dose: "10mg" },
  });
}

writeContract<string>("POST /api/medications/[id]/side-effects", {
  prepare: async (recordOwnerId) => (await seedMedication(recordOwnerId)).id,
  call: async (medicationId) => {
    const { POST } =
      await import("@/app/api/medications/[id]/side-effects/route");
    return post(
      POST as Handler,
      `/api/medications/${medicationId}/side-effects`,
      { entry: "NAUSEA", severity: 3 },
      { id: medicationId },
    );
  },
  ok: 201,
  auditAction: "medication.sideEffect.create",
  count: (userId) =>
    getPrismaClient().medicationSideEffect.count({ where: { userId } }),
});

describe("POST /api/medications/[id]/side-effects — the bucket follows the actor", () => {
  it("spends the delegate's allowance in ONE bucket across two records", async () => {
    // The single condition on which this verb was admitted. On the record key
    // a delegate could exhaust the owner's allowance and lock them out of
    // their own log, and could collect a fresh one by switching records. The
    // `rate_limits` rows are read from the table rather than inferred from a
    // 429, because a key that is merely wrong still answers 201.
    const first = await makeUser("owner");
    const second = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const firstMed = await seedMedication(first.id, "First");
    const secondMed = await seedMedication(second.id, "Second");

    const { POST } =
      await import("@/app/api/medications/[id]/side-effects/route");

    await switchInto(first.id, delegate.id, "WRITE");
    expect(
      (
        await post(
          POST as Handler,
          `/api/medications/${firstMed.id}/side-effects`,
          { entry: "NAUSEA", severity: 3 },
          { id: firstMed.id },
        )
      ).status,
    ).toBe(201);

    await switchInto(second.id, delegate.id, "WRITE");
    expect(
      (
        await post(
          POST as Handler,
          `/api/medications/${secondMed.id}/side-effects`,
          { entry: "NAUSEA", severity: 2 },
          { id: secondMed.id },
        )
      ).status,
    ).toBe(201);

    const rows = await getPrismaClient().rateLimit.findMany({
      where: { key: { startsWith: "medication-side-effect:post:" } },
    });
    // One bucket, the delegate's, holding both requests. Two buckets — one per
    // record — is the failure this asserts against, and it looks identical
    // from the response side.
    expect(rows.map((r) => r.key)).toEqual([
      `medication-side-effect:post:${delegate.id}`,
    ]);
    expect(rows[0]?.count).toBe(2);
  });

  it("still keys on the caller when nobody has switched", async () => {
    const plain = await makeUser("plain");
    const med = await seedMedication(plain.id);
    await signIn(plain.id);

    const { POST } =
      await import("@/app/api/medications/[id]/side-effects/route");
    expect(
      (
        await post(
          POST as Handler,
          `/api/medications/${med.id}/side-effects`,
          { entry: "NAUSEA", severity: 1 },
          { id: med.id },
        )
      ).status,
    ).toBe(201);

    const rows = await getPrismaClient().rateLimit.findMany({
      where: { key: { startsWith: "medication-side-effect:post:" } },
    });
    expect(rows.map((r) => r.key)).toEqual([
      `medication-side-effect:post:${plain.id}`,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 9 — adding a medication, with its nested schedule                          */
/* -------------------------------------------------------------------------- */

writeContract("POST /api/medications", {
  call: async () => {
    const { POST } = await import("@/app/api/medications/route");
    return post(POST as Handler, "/api/medications", {
      name: "Metformin",
      dose: "500mg",
      schedules: [{ windowStart: "08:00", windowEnd: "10:00" }],
    });
  },
  ok: 201,
  auditAction: "medication.create",
  count: (userId) => getPrismaClient().medication.count({ where: { userId } }),
});

describe("POST /api/medications — the nested schedule", () => {
  it("lands under the owner, because a medication nobody scheduled reminds nobody", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await switchInto(owner.id, delegate.id, "WRITE");

    const { POST } = await import("@/app/api/medications/route");
    const response = await post(POST as Handler, "/api/medications", {
      name: "Metformin",
      dose: "500mg",
      schedules: [{ windowStart: "08:00", windowEnd: "10:00" }],
    });
    expect(response.status).toBe(201);

    const medication = await getPrismaClient().medication.findFirstOrThrow({
      include: { schedules: true },
    });
    expect(medication.userId).toBe(owner.id);
    expect(medication.schedules).toHaveLength(1);
    expect(medication.schedules[0]?.windowStart).toBe("08:00");
    // The schedule hangs off the medication rather than off a user id, so the
    // only way it could reach the wrong account is through the medication —
    // asserted above — but the count under the delegate is the cheap proof
    // that nothing was mirrored.
    expect(
      await getPrismaClient().medication.count({
        where: { userId: delegate.id },
      }),
    ).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 10 / 11 — marking a dose                                                    */
/* -------------------------------------------------------------------------- */

/** A medication of `userId` with one pending slot on it. */
async function seedPendingDose(userId: string) {
  const medication = await seedMedication(userId, "Insulin");
  const event = await getPrismaClient().medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: medication.id,
      scheduledFor: new Date(),
    },
  });
  return { medicationId: medication.id, intakeId: event.id };
}

writeContract<{ medicationId: string; intakeId: string }>(
  "POST /api/medications/intake",
  {
    prepare: seedPendingDose,
    call: async ({ intakeId }) => {
      const { POST } = await import("@/app/api/medications/intake/route");
      return post(POST as Handler, "/api/medications/intake", {
        intakeId,
        status: "taken",
      });
    },
    ok: 200,
    auditAction: "medications.intake.update",
    // The slot row is seeded, so what this counts is the marking: the number
    // of the account's intake events that now carry a `takenAt`.
    count: (userId) =>
      getPrismaClient().medicationIntakeEvent.count({
        where: { userId, takenAt: { not: null } },
      }),
  },
);

/**
 * The two transitions the same route can express that are NOT marking a dose.
 *
 * `POST /api/medications/intake` is admitted because a caregiver standing next
 * to the patient has to be able to say the tablet went down. It is an update,
 * though, and the body can carry two other things.
 *
 * Snoozing writes `snoozedUntil` on the OWNER's medication row, and the
 * reminder cron skips a medication for as long as that stamp is in the future.
 * The field takes any future instant, the owner is deliberately not notified of
 * a delegated snooze, and the activity feed renders the whole family as
 * "marked a dose" — so before this was closed, a delegate could switch the
 * owner's medication reminders off for years and every surface built to make
 * delegation visible would have called it marking a dose.
 *
 * Flipping an already-resolved event is the second: taken to skipped rewrites
 * the owner's compliance history and refunds inventory, and the consent screen
 * promises that changing what is already there stays with the owner.
 *
 * Both assert the DATA, not only the status: a 403 that had already written
 * `snoozedUntil` would be worse than no refusal at all, because it would read
 * as protection.
 */
describe("POST /api/medications/intake — what a delegate may NOT do with it", () => {
  it("refuses to snooze the owner's reminders, and writes no stamp", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { medicationId, intakeId } = await seedPendingDose(owner.id);

    await switchInto(owner.id, delegate.id, "WRITE");
    const { POST } = await import("@/app/api/medications/intake/route");
    const response = await post(POST as Handler, "/api/medications/intake", {
      intakeId,
      status: "snoozed",
      snoozedUntil: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString(),
    });

    expect(response.status).toBe(403);
    expect((await payload(response)).meta?.errorCode).toBe(
      "sharing.not_permitted",
    );

    // The reminder cron reads this column and skips the medication while it is
    // in the future. It has to still be null.
    const med = await getPrismaClient().medication.findUniqueOrThrow({
      where: { id: medicationId },
      select: { snoozedUntil: true },
    });
    expect(med.snoozedUntil).toBeNull();
  });

  it("refuses to flip a dose the owner already recorded, and leaves it alone", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { intakeId } = await seedPendingDose(owner.id);

    // The owner took it themselves.
    const takenAt = new Date(Date.now() - 3_600_000);
    await getPrismaClient().medicationIntakeEvent.update({
      where: { id: intakeId },
      data: { takenAt },
    });

    await switchInto(owner.id, delegate.id, "WRITE");
    const { POST } = await import("@/app/api/medications/intake/route");
    const response = await post(POST as Handler, "/api/medications/intake", {
      intakeId,
      status: "skipped",
    });

    expect(response.status).toBe(403);

    const event =
      await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow({
        where: { id: intakeId },
        select: { takenAt: true, skipped: true },
      });
    expect(event.skipped).toBe(false);
    expect(event.takenAt?.toISOString()).toBe(takenAt.toISOString());
  });

  it("still lets the owner snooze their own reminder", async () => {
    const owner = await makeUser("owner");
    const { medicationId, intakeId } = await seedPendingDose(owner.id);
    await signIn(owner.id);

    const until = new Date(Date.now() + 1_800_000);
    const { POST } = await import("@/app/api/medications/intake/route");
    const response = await post(POST as Handler, "/api/medications/intake", {
      intakeId,
      status: "snoozed",
      snoozedUntil: until.toISOString(),
    });

    expect(response.status).toBe(200);
    const med = await getPrismaClient().medication.findUniqueOrThrow({
      where: { id: medicationId },
      select: { snoozedUntil: true },
    });
    expect(med.snoozedUntil?.toISOString()).toBe(until.toISOString());
  });
});

/**
 * The way round the sibling route's refusal, closed.
 *
 * `POST /api/medications/intake` refuses a delegate changing a dose the owner
 * already recorded. This route reaches the same rows through the slot upsert,
 * so without the same rule it was simply the other door: an explicit skip
 * posted onto a taken slot flipped the outcome and refunded the inventory the
 * take had consumed.
 *
 * The rule compares OUTCOMES rather than refusing every write onto an actioned
 * slot, and the third case is why. A double tap, an offline replay and a retry
 * after a partial batch all re-post the SAME decision, and a caregiver hits all
 * three; refusing those would make the feature unreliable exactly when somebody
 * is standing in a kitchen with a pill box.
 *
 * Each case asserts the ROW, not only the status. A 403 that had already
 * written the flip would be worse than no refusal at all, because it would read
 * as protection.
 */
describe("POST /api/medications/[id]/intake — the slot upsert is not a way round", () => {
  /**
   * A medication with a real schedule window, and one dose in it the owner
   * already recorded.
   *
   * The window is the part that took three attempts to get right. A "taken"
   * write on this route does not honour the `scheduledFor` in the body: it
   * resolves the slot by BAND from `takenAt`, so an unscheduled medication has
   * no slot to converge onto, the write lands as a standalone ad-hoc row, and
   * the canonical slot upsert is never called at all. Every assertion about
   * what the upsert refuses then passes whatever the upsert does. The window is
   * anchored two hours back so the dose is in the past (a forward `takenAt` is
   * a 422 before any of this) and outside the route's 60 s dedup window.
   */
  async function seedTakenSlot(ownerId: string) {
    const medication = await seedMedication(ownerId, "Insulin");
    const slot = new Date(Date.now() - 2 * 3_600_000);
    slot.setMinutes(0, 0, 0);
    // The window is stated in the record owner's own zone, not in UTC.
    const localHour = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      hour12: false,
    }).format(slot);
    await getPrismaClient().medicationSchedule.create({
      data: {
        medicationId: medication.id,
        windowStart: `${localHour}:00`,
        windowEnd: `${localHour}:45`,
      },
    });
    const event = await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: ownerId,
        medicationId: medication.id,
        scheduledFor: slot,
        takenAt: slot,
      },
    });
    return { medicationId: medication.id, slot, eventId: event.id };
  }

  async function postIntake(
    medicationId: string,
    body: Record<string, unknown>,
  ) {
    const { POST } = await import("@/app/api/medications/[id]/intake/route");
    return post(
      POST as Handler,
      `/api/medications/${medicationId}/intake`,
      body,
      { id: medicationId },
    );
  }

  it("refuses a delegate flipping the owner's taken dose to skipped", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { medicationId, slot, eventId } = await seedTakenSlot(owner.id);

    await switchInto(owner.id, delegate.id, "WRITE");
    const response = await postIntake(medicationId, {
      skipped: true,
      scheduledFor: slot.toISOString(),
    });

    expect(response.status).toBe(403);
    expect((await payload(response)).meta?.errorCode).toBe(
      "sharing.not_permitted",
    );

    const row = await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow(
      { where: { id: eventId }, select: { takenAt: true, skipped: true } },
    );
    expect(row.skipped).toBe(false);
    expect(row.takenAt).not.toBeNull();
  });

  it("still accepts a delegate re-posting the same decision", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { medicationId, slot, eventId } = await seedTakenSlot(owner.id);

    await switchInto(owner.id, delegate.id, "WRITE");
    const response = await postIntake(medicationId, {
      takenAt: new Date().toISOString(),
      scheduledFor: slot.toISOString(),
    });

    expect([200, 201]).toContain(response.status);
    const row = await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow(
      { where: { id: eventId }, select: { skipped: true, takenAt: true } },
    );
    expect(row.skipped).toBe(false);
    expect(row.takenAt).not.toBeNull();
  });

  it("refuses to move the time on a dose the owner already recorded", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { medicationId, slot, eventId } = await seedTakenSlot(owner.id);

    await switchInto(owner.id, delegate.id, "WRITE");
    // Inside the window, so the band binds this onto the slot the owner
    // already recorded rather than opening an ad-hoc row beside it. Five
    // minutes late is what a second tap looks like.
    const movedTo = new Date(slot.getTime() + 5 * 60_000);
    const replay = {
      takenAt: movedTo.toISOString(),
      doseTaken: "two tablets",
      idempotencyKey: "delegated-same-outcome-replay",
    };
    const response = await postIntake(medicationId, replay);

    // Same decision, so this is not a refusal: it answers, and it answers with
    // the row that is already there. What it must never do is move the record.
    expect([200, 201]).toContain(response.status);
    const replayResponse = await postIntake(medicationId, replay);
    expect([200, 201]).toContain(replayResponse.status);

    const all = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { userId: owner.id },
      select: { id: true, takenAt: true, scheduledFor: true, doseTaken: true },
    });
    // One row, not two: the write converged onto the owner's dose instead of
    // opening a second one beside it. Without this the case below would pass
    // on an ad-hoc row while the owner's record sat untouched next to it.
    expect(all).toHaveLength(1);
    const row = await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow(
      {
        where: { id: eventId },
        select: {
          takenAt: true,
          scheduledFor: true,
          doseTaken: true,
          skipped: true,
        },
      },
    );
    expect(row.takenAt?.toISOString()).toBe(slot.toISOString());
    expect(row.scheduledFor.toISOString()).toBe(slot.toISOString());
    expect(row.doseTaken).toBeNull();
    expect(row.skipped).toBe(false);
  });

  it("still lets the owner correct their own dose", async () => {
    const owner = await makeUser("owner");
    const { medicationId, slot, eventId } = await seedTakenSlot(owner.id);
    await signIn(owner.id);

    const response = await postIntake(medicationId, {
      skipped: true,
      scheduledFor: slot.toISOString(),
    });

    expect([200, 201]).toContain(response.status);
    const row = await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow(
      { where: { id: eventId }, select: { skipped: true } },
    );
    expect(row.skipped).toBe(true);
  });
});

writeContract<{ medicationId: string; intakeId: string }>(
  "POST /api/medications/[id]/intake",
  {
    prepare: async (recordOwnerId) => ({
      medicationId: (await seedMedication(recordOwnerId, "Insulin")).id,
      intakeId: "",
    }),
    call: async ({ medicationId }) => {
      const { POST } = await import("@/app/api/medications/[id]/intake/route");
      return post(
        POST as Handler,
        `/api/medications/${medicationId}/intake`,
        { takenAt: new Date().toISOString() },
        { id: medicationId },
      );
    },
    ok: 201,
    auditAction: "medication.intake",
    count: (userId) =>
      getPrismaClient().medicationIntakeEvent.count({
        where: { userId, takenAt: { not: null } },
      }),
  },
);

describe("marking a dose — what the owner is told, and what the rollup recomputed", () => {
  it("hands the OWNER and the ACTOR to the notification, not one id twice", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { medicationId, intakeId } = await seedPendingDose(owner.id);
    await switchInto(owner.id, delegate.id, "WRITE");

    const { POST } = await import("@/app/api/medications/intake/route");
    expect(
      (
        await post(POST as Handler, "/api/medications/intake", {
          intakeId,
          status: "taken",
        })
      ).status,
    ).toBe(200);

    expect(notifyDelegatedIntake).toHaveBeenCalledTimes(1);
    expect(notifyDelegatedIntake).toHaveBeenCalledWith({
      ownerId: owner.id,
      actorId: delegate.id,
      medicationId,
      status: "taken",
    });
  });

  it("carries the skip through the per-medication arm", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const medication = await seedMedication(owner.id, "Insulin");
    await switchInto(owner.id, delegate.id, "WRITE");

    const { POST } = await import("@/app/api/medications/[id]/intake/route");
    expect(
      (
        await post(
          POST as Handler,
          `/api/medications/${medication.id}/intake`,
          { skipped: true, scheduledFor: new Date().toISOString() },
          { id: medication.id },
        )
      ).status,
    ).toBe(201);

    expect(notifyDelegatedIntake).toHaveBeenCalledWith({
      ownerId: owner.id,
      actorId: delegate.id,
      medicationId: medication.id,
      status: "skipped",
    });
  });

  it("still calls it with one id when nobody has switched", async () => {
    // The helper refuses on self, so this call is a no-op — but it has to be
    // MADE with `actorId === ownerId`, or the refusal is being reached for the
    // wrong reason.
    const plain = await makeUser("plain");
    const { medicationId, intakeId } = await seedPendingDose(plain.id);
    await signIn(plain.id);

    const { POST } = await import("@/app/api/medications/intake/route");
    expect(
      (
        await post(POST as Handler, "/api/medications/intake", {
          intakeId,
          status: "taken",
        })
      ).status,
    ).toBe(200);

    expect(notifyDelegatedIntake).toHaveBeenCalledWith({
      ownerId: plain.id,
      actorId: plain.id,
      medicationId,
      status: "taken",
    });
  });
});
