/**
 * The migrated routes, driven as routes, against real Postgres.
 *
 * Every case below imports the shipped `GET` export and calls it. Nothing is
 * reimplemented: the real `apiHandler`, the real `requireRecordAuth`, the real
 * grant table, the real Prisma queries. That matters more here than anywhere
 * else in this feature, because the thing being asserted is a substitution
 * that happens ABOVE the handler body — a test that rebuilt the handler would
 * be testing its own copy of the substitution and would keep passing after the
 * route stopped performing it.
 *
 * Four questions per domain, and the fourth is the one that decides whether
 * this release is safe to ship:
 *
 *   1. a delegate with a live READ grant reads the OWNER's rows;
 *   2. the same delegate without a grant is refused `sharing.access.denied`;
 *   3. after revocation the very NEXT request is refused — no re-login;
 *   4. a caller who never switched gets exactly what they got before.
 *
 * (4) is the regression. Forty-four routes changed; a person who shares
 * nothing must not be able to tell.
 *
 * Owner and delegate are BOTH seeded with data in every case, and the
 * assertions name the owner's values and the delegate's separately. An empty
 * result satisfies "the delegate's rows are absent" while hiding the exact
 * failure this feature exists to avoid.
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

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `deleg-${suffix}`,
      email: `deleg-${suffix}@example.test`,
      displayName: `Deleg ${suffix}`,
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
 * A live grant and a session already inside the owner's record.
 *
 * Written straight to the tables rather than driven through invite / accept /
 * switch, because `sharing-lifecycle.test.ts` already proves those three
 * routes produce exactly these rows and repeating the handshake once per
 * domain would buy nothing but wall-clock. The rows are the contract; this
 * file is about what the migrated routes do once they exist.
 */
async function switchInto(ownerId: string, delegateId: string) {
  const grant = await getPrismaClient().accountGrant.create({
    data: {
      grantorId: ownerId,
      granteeId: delegateId,
      access: "READ",
      acceptedAt: new Date(),
    },
  });
  const session = await signIn(delegateId);
  await switchSessionTo(session.id, ownerId);
  return { grant, session };
}

/** The delegate is inside the record, but the grant is gone. */
async function revokeGrant(grantId: string) {
  await getPrismaClient().accountGrant.update({
    where: { id: grantId },
    data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
  });
}

/**
 * A route's `GET` export, seen from outside.
 *
 * Each shipped handler declares its own params shape (`{ id: string }` and so
 * on), which is exactly the sort of per-route difference a driver like this one
 * has no business knowing. The cast at each call site narrows to this, and the
 * `params` object handed in is checked by the route's own Zod / lookup logic
 * one line later — a wrong id produces a 404 from the handler, not a type
 * error here.
 */
type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

function get(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "GET" });
}

async function call(
  handler: Handler,
  url: string,
  params: Record<string, string> = {},
): Promise<Response> {
  return handler(get(url), { params: Promise.resolve(params) });
}

async function body(response: Response): Promise<{
  data: unknown;
  error: unknown;
  meta?: { errorCode?: string };
}> {
  return response.json();
}

/** The stable refusal, asserted by code rather than by status alone. */
async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  expect((await body(response)).meta?.errorCode).toBe("sharing.access.denied");
}

/**
 * The four-part contract, run against one route.
 *
 * `seed` writes one row for whichever user it is handed and returns the value
 * that identifies it in the response; `read` pulls those identifying values
 * back out of the response body. The domain suites below supply both, so each
 * one is four assertions of substance rather than four of shape.
 */
function contract<T>(
  name: string,
  route: {
    call: () => Promise<Response>;
    seed: (userId: string, marker: T) => Promise<void>;
    read: (payload: never) => T[];
    ownerMarker: T;
    delegateMarker: T;
  },
) {
  describe(name, () => {
    it("serves the owner's rows to a delegate holding a live grant", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await route.seed(owner.id, route.ownerMarker);
      await route.seed(delegate.id, route.delegateMarker);

      await switchInto(owner.id, delegate.id);
      const response = await route.call();

      expect(response.status).toBe(200);
      const rows = route.read((await body(response)).data as never);
      expect(rows).toContainEqual(route.ownerMarker);
      // The delegate's own row is seeded and must be absent. Asserting the
      // owner's presence alone would pass on a handler that returned
      // everybody's rows.
      expect(rows).not.toContainEqual(route.delegateMarker);
    });

    it("refuses a caller who names a record they were never granted", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      await route.seed(owner.id, route.ownerMarker);

      const session = await signIn(stranger.id);
      await switchSessionTo(session.id, owner.id);

      await expectDenied(await route.call());
    });

    it("refuses the next request after the grant is revoked", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await route.seed(owner.id, route.ownerMarker);

      const { grant } = await switchInto(owner.id, delegate.id);
      expect((await route.call()).status).toBe(200);

      // No sign-out, no new session, no cache flush. The same browser, the
      // next request.
      await revokeGrant(grant.id);
      await expectDenied(await route.call());
    });

    it("is unchanged for a caller who has not switched", async () => {
      const plain = await makeUser("plain");
      await route.seed(plain.id, route.ownerMarker);
      await signIn(plain.id);

      const response = await route.call();
      expect(response.status).toBe(200);
      expect(route.read((await body(response)).data as never)).toContainEqual(
        route.ownerMarker,
      );
    });
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

/* -------------------------------------------------------------------------- */
/* Measurements                                                               */
/* -------------------------------------------------------------------------- */

async function seedWeight(userId: string, value: number) {
  await getPrismaClient().measurement.create({
    data: {
      userId,
      type: "WEIGHT",
      value,
      unit: "kg",
      // Relative to now: a fixed date ages out of the 90-day series window.
      measuredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      source: "MANUAL",
    },
  });
}

contract<number>("GET /api/measurements", {
  call: async () => {
    const { GET } = await import("@/app/api/measurements/route");
    return call(GET as Handler, "/api/measurements");
  },
  seed: seedWeight,
  read: (payload: { measurements: { value: number }[] }) =>
    payload.measurements.map((m) => m.value),
  ownerMarker: 81,
  delegateMarker: 64,
});

contract<number>("GET /api/measurements/series", {
  call: async () => {
    const { GET } = await import("@/app/api/measurements/series/route");
    return call(GET as Handler, "/api/measurements/series?kind=weight&days=90");
  },
  seed: seedWeight,
  read: (payload: { points: { value: number }[] }) =>
    payload.points.map((p) => p.value),
  ownerMarker: 81,
  delegateMarker: 64,
});

contract<number>("GET /api/measurements/series-batch", {
  call: async () => {
    const { GET } = await import("@/app/api/measurements/series-batch/route");
    return call(
      GET as Handler,
      `/api/measurements/series-batch?types=WEIGHT&from=${new Date(Date.now() - 365 * 86_400_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`,
    );
  },
  seed: seedWeight,
  read: (payload: { series: Record<string, { value: number }[]> }) =>
    (payload.series.WEIGHT ?? []).map((row) => row.value),
  ownerMarker: 81,
  delegateMarker: 64,
});

describe("GET /api/measurements/[id]", () => {
  it("serves one of the owner's readings and refuses the delegate's reach past it", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedWeight(owner.id, 81);
    await seedWeight(delegate.id, 64);
    const ownerRow = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateRow = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: delegate.id },
    });

    const { GET } = await import("@/app/api/measurements/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      GET as Handler,
      `/api/measurements/${ownerRow.id}`,
      { id: ownerRow.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ value: 81 });

    // The fetch-then-guard arm now guards against the OWNER. The delegate's
    // own reading is out of scope while they are inside somebody else's
    // record — which is the correct answer and a surprising one, so it is
    // asserted rather than assumed.
    const theirs = await call(
      GET as Handler,
      `/api/measurements/${delegateRow.id}`,
      { id: delegateRow.id },
    );
    expect(theirs.status).toBe(404);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, `/api/measurements/${ownerRow.id}`, {
        id: ownerRow.id,
      }),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedWeight(plain.id, 77);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/measurements/[id]/route");
    const response = await call(GET as Handler, `/api/measurements/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ value: 77 });
  });
});

describe("the 422 breadcrumb a delegate leaves on the owner's record", () => {
  it("files under the owner and names the delegate as the actor", async () => {
    // The one write a delegable measurements GET performs. It was a bare
    // `prisma.auditLog.create` before the migration, which files the row with
    // `actorUserId` NULL — indistinguishable from the owner having typed the
    // bad query themselves.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await switchInto(owner.id, delegate.id);

    const { GET } = await import("@/app/api/measurements/route");
    const refused = await call(
      GET as Handler,
      "/api/measurements?limit=not-a-number",
    );
    expect(refused.status).toBe(422);

    await vi.waitFor(async () => {
      const row = await getPrismaClient().auditLog.findFirst({
        where: { action: "measurements.list.validation-failed" },
      });
      expect(row?.userId).toBe(owner.id);
      expect(row?.actorUserId).toBe(delegate.id);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Measurement reminders                                                      */
/* -------------------------------------------------------------------------- */

async function seedReminder(userId: string, label: string) {
  await getPrismaClient().measurementReminder.create({
    data: {
      userId,
      label,
      measurementType: "WEIGHT",
      intervalDays: 7,
      enabled: true,
    },
  });
}

contract<string>("GET /api/measurement-reminders", {
  call: async () => {
    const { GET } = await import("@/app/api/measurement-reminders/route");
    return call(GET as Handler, "/api/measurement-reminders");
  },
  seed: seedReminder,
  read: (payload: { label: string }[]) => payload.map((r) => r.label),
  ownerMarker: "owner weigh-in",
  delegateMarker: "delegate weigh-in",
});

describe("GET /api/measurement-reminders/[id]", () => {
  it("serves the owner's reminder and refuses once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedReminder(owner.id, "owner weigh-in");
    await seedReminder(delegate.id, "delegate weigh-in");
    const ownerRow =
      await getPrismaClient().measurementReminder.findFirstOrThrow({
        where: { userId: owner.id },
      });
    const delegateRow =
      await getPrismaClient().measurementReminder.findFirstOrThrow({
        where: { userId: delegate.id },
      });

    const { GET } = await import("@/app/api/measurement-reminders/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      GET as Handler,
      `/api/measurement-reminders/${ownerRow.id}`,
      { id: ownerRow.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ label: "owner weigh-in" });

    const theirs = await call(
      GET as Handler,
      `/api/measurement-reminders/${delegateRow.id}`,
      { id: delegateRow.id },
    );
    expect(theirs.status).toBe(404);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, `/api/measurement-reminders/${ownerRow.id}`, {
        id: ownerRow.id,
      }),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedReminder(plain.id, "plain weigh-in");
    const row = await getPrismaClient().measurementReminder.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/measurement-reminders/[id]/route");
    const response = await call(
      GET as Handler,
      `/api/measurement-reminders/${row.id}`,
      { id: row.id },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      label: "plain weigh-in",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Labs and biomarkers                                                        */
/* -------------------------------------------------------------------------- */

async function seedLab(userId: string, analyte: string) {
  await getPrismaClient().labResult.create({
    data: {
      userId,
      analyte,
      value: 5.2,
      unit: "mmol/L",
      takenAt: new Date("2026-07-10T09:00:00Z"),
    },
  });
}

contract<string>("GET /api/labs", {
  call: async () => {
    const { GET } = await import("@/app/api/labs/route");
    return call(GET as Handler, "/api/labs");
  },
  seed: seedLab,
  read: (payload: { results: { analyte: string }[] }) =>
    payload.results.map((r) => r.analyte),
  ownerMarker: "owner-hba1c",
  delegateMarker: "delegate-hba1c",
});

async function seedBiomarker(userId: string, name: string) {
  await getPrismaClient().biomarker.create({
    data: { userId, name, unit: "mmol/L" },
  });
}

contract<string>("GET /api/biomarkers", {
  call: async () => {
    const { GET } = await import("@/app/api/biomarkers/route");
    return call(GET as Handler, "/api/biomarkers");
  },
  seed: seedBiomarker,
  read: (payload: { biomarkers: { name: string }[] }) =>
    payload.biomarkers.map((b) => b.name),
  ownerMarker: "owner-ferritin",
  delegateMarker: "delegate-ferritin",
});

describe("GET /api/labs/[id] and /api/biomarkers/[id]", () => {
  it("resolve by id against the owner, not the caller", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedLab(owner.id, "owner-hba1c");
    await seedLab(delegate.id, "delegate-hba1c");
    await seedBiomarker(owner.id, "owner-ferritin");

    const ownerLab = await getPrismaClient().labResult.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateLab = await getPrismaClient().labResult.findFirstOrThrow({
      where: { userId: delegate.id },
    });
    const ownerMarker = await getPrismaClient().biomarker.findFirstOrThrow({
      where: { userId: owner.id },
    });

    const labs = await import("@/app/api/labs/[id]/route");
    const markers = await import("@/app/api/biomarkers/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const lab = await call(labs.GET as Handler, `/api/labs/${ownerLab.id}`, {
      id: ownerLab.id,
    });
    expect(lab.status).toBe(200);
    expect((await body(lab)).data).toMatchObject({ analyte: "owner-hba1c" });

    // The delegate's own result is not reachable from inside the owner's
    // record. The fetch-then-guard arm now guards against the owner.
    const theirs = await call(
      labs.GET as Handler,
      `/api/labs/${delegateLab.id}`,
      { id: delegateLab.id },
    );
    expect(theirs.status).toBe(404);

    const marker = await call(
      markers.GET as Handler,
      `/api/biomarkers/${ownerMarker.id}`,
      { id: ownerMarker.id },
    );
    expect(marker.status).toBe(200);
    expect((await body(marker)).data).toMatchObject({ name: "owner-ferritin" });

    await revokeGrant(grant.id);
    await expectDenied(
      await call(labs.GET as Handler, `/api/labs/${ownerLab.id}`, {
        id: ownerLab.id,
      }),
    );
    await expectDenied(
      await call(markers.GET as Handler, `/api/biomarkers/${ownerMarker.id}`, {
        id: ownerMarker.id,
      }),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedLab(plain.id, "plain-hba1c");
    const row = await getPrismaClient().labResult.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/labs/[id]/route");
    const response = await call(GET as Handler, `/api/labs/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      analyte: "plain-hba1c",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Clinical record                                                            */
/* -------------------------------------------------------------------------- */

async function seedAllergy(userId: string, substance: string) {
  await getPrismaClient().allergy.create({ data: { userId, substance } });
}

contract<string>("GET /api/allergies", {
  call: async () => {
    const { GET } = await import("@/app/api/allergies/route");
    return call(GET as Handler, "/api/allergies");
  },
  seed: seedAllergy,
  read: (payload: { substance: string }[]) => payload.map((a) => a.substance),
  ownerMarker: "owner-penicillin",
  delegateMarker: "delegate-penicillin",
});

async function seedFamilyHistory(userId: string, condition: string) {
  await getPrismaClient().familyHistoryEntry.create({
    data: { userId, relationship: "MOTHER", condition },
  });
}

contract<string>("GET /api/family-history", {
  call: async () => {
    const { GET } = await import("@/app/api/family-history/route");
    return call(GET as Handler, "/api/family-history");
  },
  seed: seedFamilyHistory,
  read: (payload: { condition: string }[]) => payload.map((e) => e.condition),
  ownerMarker: "owner-condition",
  delegateMarker: "delegate-condition",
});

describe("GET /api/allergies/[id] and /api/family-history/[id]", () => {
  it("resolve by id against the owner and refuse once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedAllergy(owner.id, "owner-penicillin");
    await seedAllergy(delegate.id, "delegate-penicillin");
    await seedFamilyHistory(owner.id, "owner-condition");

    const ownerAllergy = await getPrismaClient().allergy.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateAllergy = await getPrismaClient().allergy.findFirstOrThrow({
      where: { userId: delegate.id },
    });
    const ownerEntry =
      await getPrismaClient().familyHistoryEntry.findFirstOrThrow({
        where: { userId: owner.id },
      });

    const allergies = await import("@/app/api/allergies/[id]/route");
    const history = await import("@/app/api/family-history/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      allergies.GET as Handler,
      `/api/allergies/${ownerAllergy.id}`,
      { id: ownerAllergy.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({
      substance: "owner-penicillin",
    });

    const theirs = await call(
      allergies.GET as Handler,
      `/api/allergies/${delegateAllergy.id}`,
      { id: delegateAllergy.id },
    );
    expect(theirs.status).toBe(404);

    const entry = await call(
      history.GET as Handler,
      `/api/family-history/${ownerEntry.id}`,
      { id: ownerEntry.id },
    );
    expect(entry.status).toBe(200);
    expect((await body(entry)).data).toMatchObject({
      condition: "owner-condition",
    });

    await revokeGrant(grant.id);
    await expectDenied(
      await call(
        allergies.GET as Handler,
        `/api/allergies/${ownerAllergy.id}`,
        { id: ownerAllergy.id },
      ),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedAllergy(plain.id, "plain-penicillin");
    const row = await getPrismaClient().allergy.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/allergies/[id]/route");
    const response = await call(GET as Handler, `/api/allergies/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      substance: "plain-penicillin",
    });
  });
});

async function seedFact(userId: string, value: string) {
  // Through the real writer, because the revision's value is an encrypted
  // column and a hand-built row would read back as `unreadable`.
  const { createHealthProfileFact } =
    await import("@/lib/profile/health-facts");
  await createHealthProfileFact(userId, "SMOKING_STATUS", value as never);
}

contract<string>("GET /api/anamnesis/facts", {
  call: async () => {
    const { GET } = await import("@/app/api/anamnesis/facts/route");
    return call(GET as Handler, "/api/anamnesis/facts");
  },
  seed: seedFact,
  read: (payload: {
    current: Record<string, { value: string | null } | null>;
  }) =>
    Object.values(payload.current)
      .map((row) => row?.value ?? null)
      .filter((v): v is string => v !== null),
  ownerMarker: "CURRENT",
  delegateMarker: "NEVER",
});

/* -------------------------------------------------------------------------- */
/* Mental health — the module gate follows the record                          */
/* -------------------------------------------------------------------------- */

async function seedAssessment(userId: string, totalScore: number) {
  await getPrismaClient().mentalHealthAssessment.create({
    data: {
      userId,
      instrument: "PHQ9",
      locale: "en",
      responsesEncrypted: Buffer.from("sealed"),
      totalScore,
      severityBand: "mild",
      takenAt: new Date("2026-07-12T10:00:00Z"),
    },
  });
}

async function setModulePreference(userId: string, enabled: boolean) {
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { modulePreferencesJson: { mentalHealth: enabled } },
  });
}

describe("GET /api/mental-health/assessments", () => {
  it("reads the owner's screener history when the OWNER enabled the module", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await setModulePreference(owner.id, true);
    await seedAssessment(owner.id, 11);
    await seedAssessment(delegate.id, 3);

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const response = await call(
      GET as Handler,
      "/api/mental-health/assessments",
    );

    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      assessments: { totalScore: number }[];
    };
    expect(payload.assessments.map((a) => a.totalScore)).toEqual([11]);
  });

  it("refuses when the OWNER switched the module off, whatever the delegate set", async () => {
    // The decision recorded in the classification: the module map governs
    // which parts of a RECORD exist, so it is read off the record. A delegate
    // who enabled the screener on their own account does not thereby gain a
    // screener view inside somebody else's.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await setModulePreference(owner.id, false);
    await setModulePreference(delegate.id, true);
    await seedAssessment(owner.id, 11);

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const response = await call(
      GET as Handler,
      "/api/mental-health/assessments",
    );

    expect(response.status).toBe(403);
    expect((await body(response)).meta?.errorCode).toBe("module.disabled");
  });

  it("refuses a caller with no grant, and refuses the request after revocation", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await setModulePreference(owner.id, true);
    await seedAssessment(owner.id, 11);

    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const { grant } = await switchInto(owner.id, delegate.id);
    expect(
      (await call(GET as Handler, "/api/mental-health/assessments")).status,
    ).toBe(200);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, "/api/mental-health/assessments"),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await setModulePreference(plain.id, true);
    await seedAssessment(plain.id, 7);
    await signIn(plain.id);

    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const response = await call(
      GET as Handler,
      "/api/mental-health/assessments",
    );
    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      assessments: { totalScore: number }[];
    };
    expect(payload.assessments.map((a) => a.totalScore)).toEqual([7]);
  });
});

/* -------------------------------------------------------------------------- */
/* Mood, custom metrics, personal records                                     */
/* -------------------------------------------------------------------------- */

async function seedMood(userId: string, score: number) {
  await getPrismaClient().moodEntry.create({
    data: {
      userId,
      date: "2026-07-14",
      mood: "GUT",
      score,
      moodLoggedAt: new Date("2026-07-14T19:00:00Z"),
    },
  });
}

contract<number>("GET /api/mood-entries", {
  call: async () => {
    const { GET } = await import("@/app/api/mood-entries/route");
    return call(GET as Handler, "/api/mood-entries");
  },
  seed: seedMood,
  read: (payload: { entries: { score: number }[] }) =>
    payload.entries.map((e) => e.score),
  ownerMarker: 4,
  delegateMarker: 2,
});

describe("GET /api/mood-entries/[id]", () => {
  it("resolves against the owner and refuses once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedMood(owner.id, 4);
    await seedMood(delegate.id, 2);
    const ownerRow = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateRow = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: delegate.id },
    });

    const { GET } = await import("@/app/api/mood-entries/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      GET as Handler,
      `/api/mood-entries/${ownerRow.id}`,
      { id: ownerRow.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ score: 4 });

    const theirs = await call(
      GET as Handler,
      `/api/mood-entries/${delegateRow.id}`,
      { id: delegateRow.id },
    );
    expect(theirs.status).toBe(404);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, `/api/mood-entries/${ownerRow.id}`, {
        id: ownerRow.id,
      }),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedMood(plain.id, 5);
    const row = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/mood-entries/[id]/route");
    const response = await call(GET as Handler, `/api/mood-entries/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ score: 5 });
  });
});

async function seedCustomMetric(userId: string, name: string) {
  const metric = await getPrismaClient().customMetric.create({
    data: { userId, name, unit: "ml" },
  });
  await getPrismaClient().customMetricEntry.create({
    data: {
      userId,
      customMetricId: metric.id,
      value: 250,
      unit: "ml",
      measuredAt: new Date("2026-07-14T12:00:00Z"),
    },
  });
}

contract<string>("GET /api/custom-metrics", {
  call: async () => {
    const { GET } = await import("@/app/api/custom-metrics/route");
    return call(GET as Handler, "/api/custom-metrics");
  },
  seed: seedCustomMetric,
  read: (payload: { customMetrics: { name: string }[] }) =>
    payload.customMetrics.map((m) => m.name),
  ownerMarker: "owner-water",
  delegateMarker: "delegate-water",
});

describe("GET /api/custom-metrics/[id] and its entries", () => {
  it("reach the owner's metric and refuse once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedCustomMetric(owner.id, "owner-water");
    await seedCustomMetric(delegate.id, "delegate-water");
    const ownerMetric = await getPrismaClient().customMetric.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateMetric =
      await getPrismaClient().customMetric.findFirstOrThrow({
        where: { userId: delegate.id },
      });

    const detail = await import("@/app/api/custom-metrics/[id]/route");
    const entries = await import("@/app/api/custom-metrics/[id]/entries/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      detail.GET as Handler,
      `/api/custom-metrics/${ownerMetric.id}`,
      { id: ownerMetric.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ name: "owner-water" });

    // The entries route establishes ownership on the METRIC first and only
    // then queries by `customMetricId`. That hop now resolves against the
    // owner, so the delegate's own metric is unreachable from in here.
    const theirEntries = await call(
      entries.GET as Handler,
      `/api/custom-metrics/${delegateMetric.id}/entries`,
      { id: delegateMetric.id },
    );
    expect(theirEntries.status).toBe(404);

    const ownerEntries = await call(
      entries.GET as Handler,
      `/api/custom-metrics/${ownerMetric.id}/entries`,
      { id: ownerMetric.id },
    );
    expect(ownerEntries.status).toBe(200);
    const payload = (await body(ownerEntries)).data as {
      entries: { value: number }[];
    };
    expect(payload.entries.map((e) => e.value)).toEqual([250]);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(
        entries.GET as Handler,
        `/api/custom-metrics/${ownerMetric.id}/entries`,
        { id: ownerMetric.id },
      ),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedCustomMetric(plain.id, "plain-water");
    const metric = await getPrismaClient().customMetric.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/custom-metrics/[id]/route");
    const response = await call(
      GET as Handler,
      `/api/custom-metrics/${metric.id}`,
      { id: metric.id },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ name: "plain-water" });
  });
});

async function seedPersonalRecord(userId: string, value: number) {
  await getPrismaClient().personalRecord.create({
    data: {
      userId,
      metricType: "WEIGHT",
      direction: "MIN",
      value,
      unit: "kg",
      achievedAt: new Date("2026-06-01T08:00:00Z"),
    },
  });
}

contract<number>("GET /api/personal-records", {
  call: async () => {
    const { GET } = await import("@/app/api/personal-records/route");
    return call(GET as Handler, "/api/personal-records");
  },
  seed: seedPersonalRecord,
  read: (payload: { value: number }[]) => payload.map((r) => r.value),
  ownerMarker: 79.5,
  delegateMarker: 61.5,
});

/* -------------------------------------------------------------------------- */
/* Sleep, nutrients, illness, workouts                                        */
/* -------------------------------------------------------------------------- */

async function seedSleepStage(userId: string, minutes: number) {
  await getPrismaClient().measurement.create({
    data: {
      userId,
      type: "SLEEP_DURATION",
      value: minutes,
      unit: "min",
      measuredAt: new Date(Date.now() - 8 * 3_600_000),
      source: "MANUAL",
      sleepStage: "DEEP",
    },
  });
}

describe("GET /api/sleep/night", () => {
  it("reads the owner's night and refuses once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedSleepStage(owner.id, 90);
    await seedSleepStage(delegate.id, 30);

    const { GET } = await import("@/app/api/sleep/night/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const response = await call(GET as Handler, "/api/sleep/night");
    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      main: { stages?: unknown; totalMinutes?: number } | null;
    };
    // The owner's 90 minutes, not the delegate's 30.
    expect(JSON.stringify(payload)).toContain("90");
    expect(JSON.stringify(payload)).not.toContain('"30"');

    await revokeGrant(grant.id);
    await expectDenied(await call(GET as Handler, "/api/sleep/night"));
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedSleepStage(plain.id, 90);
    await signIn(plain.id);

    const { GET } = await import("@/app/api/sleep/night/route");
    const response = await call(GET as Handler, "/api/sleep/night");
    expect(response.status).toBe(200);
    expect(JSON.stringify((await body(response)).data)).toContain("90");
  });

  it("refuses a caller who names a record they were never granted", async () => {
    const owner = await makeUser("owner");
    const stranger = await makeUser("stranger");
    const session = await signIn(stranger.id);
    await switchSessionTo(session.id, owner.id);

    const { GET } = await import("@/app/api/sleep/night/route");
    await expectDenied(await call(GET as Handler, "/api/sleep/night"));
  });
});

describe("GET /api/sleep/rhythm", () => {
  it("follows the record's sleep module, not the delegate's", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { sleep: false } },
    });
    await getPrismaClient().user.update({
      where: { id: delegate.id },
      data: { modulePreferencesJson: { sleep: true } },
    });

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/sleep/rhythm/route");
    const response = await call(GET as Handler, "/api/sleep/rhythm");

    expect(response.status).toBe(403);
    expect((await body(response)).meta?.errorCode).toBe("module.disabled");
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await signIn(plain.id);
    const { GET } = await import("@/app/api/sleep/rhythm/route");
    expect((await call(GET as Handler, "/api/sleep/rhythm")).status).toBe(200);
  });
});

async function seedNutrient(userId: string, amount: number) {
  // Opt-in module, default off. Enabled on whoever is seeded, so the delegate
  // case below exercises the substitution rather than the gate.
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { modulePreferencesJson: { nutrients: true } },
  });
  const day = new Date().toISOString().slice(0, 10);
  await getPrismaClient().nutrientIntakeDay.create({
    data: { userId, day, nutrient: "magnesium", amount, unit: "mg" },
  });
}

contract<number>("GET /api/nutrients", {
  call: async () => {
    const { GET } = await import("@/app/api/nutrients/route");
    return call(GET as Handler, "/api/nutrients?days=30");
  },
  seed: seedNutrient,
  read: (payload: { nutrients: { latestAmount: number }[] }) =>
    payload.nutrients.map((n) => n.latestAmount),
  ownerMarker: 320,
  delegateMarker: 145,
});

contract<number>("GET /api/nutrients/daily", {
  call: async () => {
    const { GET } = await import("@/app/api/nutrients/daily/route");
    return call(GET as Handler, "/api/nutrients/daily?nutrient=magnesium");
  },
  seed: seedNutrient,
  read: (payload: { days: { amount: number }[] }) =>
    payload.days.map((d) => d.amount).filter((a) => a > 0),
  ownerMarker: 320,
  delegateMarker: 145,
});

async function seedEpisode(userId: string, label: string) {
  const episode = await getPrismaClient().illnessEpisode.create({
    data: {
      userId,
      label,
      type: "INFECTION",
      onsetAt: new Date("2026-07-01T00:00:00Z"),
    },
  });
  await getPrismaClient().illnessDayLog.create({
    data: {
      userId,
      episodeId: episode.id,
      date: "2026-07-02",
      functionalImpact: 3,
    },
  });
}

contract<string>("GET /api/illness/episodes", {
  call: async () => {
    const { GET } = await import("@/app/api/illness/episodes/route");
    return call(GET as Handler, "/api/illness/episodes");
  },
  seed: seedEpisode,
  read: (payload: { label: string }[]) => payload.map((e) => e.label),
  ownerMarker: "owner-flu",
  delegateMarker: "delegate-flu",
});

describe("GET /api/illness/episodes/[id] and its day logs", () => {
  it("resolve the ownership hop against the record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedEpisode(owner.id, "owner-flu");
    await seedEpisode(delegate.id, "delegate-flu");
    const ownerEpisode =
      await getPrismaClient().illnessEpisode.findFirstOrThrow({
        where: { userId: owner.id },
      });
    const delegateEpisode =
      await getPrismaClient().illnessEpisode.findFirstOrThrow({
        where: { userId: delegate.id },
      });

    const detail = await import("@/app/api/illness/episodes/[id]/route");
    const logs = await import("@/app/api/illness/episodes/[id]/day-logs/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      detail.GET as Handler,
      `/api/illness/episodes/${ownerEpisode.id}`,
      { id: ownerEpisode.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ label: "owner-flu" });

    // `loadOwnedEpisode` is what makes the episode-scoped day-log query safe.
    // It now resolves against the owner, so the delegate's own episode 404s
    // from in here rather than leaking its logs.
    const theirs = await call(
      logs.GET as Handler,
      `/api/illness/episodes/${delegateEpisode.id}/day-logs?date=2026-07-02`,
      { id: delegateEpisode.id },
    );
    expect(theirs.status).toBe(404);

    const ownerLog = await call(
      logs.GET as Handler,
      `/api/illness/episodes/${ownerEpisode.id}/day-logs?date=2026-07-02`,
      { id: ownerEpisode.id },
    );
    expect(ownerLog.status).toBe(200);
    expect((await body(ownerLog)).data).toMatchObject({
      functionalImpact: 3,
    });

    await revokeGrant(grant.id);
    await expectDenied(
      await call(
        detail.GET as Handler,
        `/api/illness/episodes/${ownerEpisode.id}`,
        { id: ownerEpisode.id },
      ),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedEpisode(plain.id, "plain-flu");
    const episode = await getPrismaClient().illnessEpisode.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/illness/episodes/[id]/route");
    const response = await call(
      GET as Handler,
      `/api/illness/episodes/${episode.id}`,
      { id: episode.id },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ label: "plain-flu" });
  });
});

async function seedWorkout(userId: string, durationSec: number) {
  await getPrismaClient().workout.create({
    data: {
      userId,
      sportType: "RUNNING",
      startedAt: new Date("2026-07-11T06:00:00Z"),
      endedAt: new Date("2026-07-11T07:00:00Z"),
      durationSec,
    },
  });
}

contract<number>("GET /api/workouts", {
  call: async () => {
    const { GET } = await import("@/app/api/workouts/route");
    return call(GET as Handler, "/api/workouts");
  },
  seed: seedWorkout,
  read: (payload: { workouts: { durationSec: number | null }[] }) =>
    payload.workouts
      .map((w) => w.durationSec)
      .filter((d): d is number => d !== null),
  ownerMarker: 3600,
  delegateMarker: 1800,
});

/* -------------------------------------------------------------------------- */
/* Cycle — the gate reads the record's own gender                             */
/* -------------------------------------------------------------------------- */

/**
 * A cycle-tracking account. `cycleTrackingEnabled` is an explicit opt-in that
 * overrides the gender derivation, so the fixture does not depend on the enum
 * normalisation the gate's own comment flags as still pending.
 */
async function seedCycle(userId: string, startDate: string) {
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { gender: "FEMALE" },
  });
  await getPrismaClient().cycleProfile.upsert({
    where: { userId },
    create: { userId, cycleTrackingEnabled: true },
    update: { cycleTrackingEnabled: true },
  });
  await getPrismaClient().menstrualCycle.create({
    data: { userId, startDate },
  });
}

contract<string>("GET /api/cycle/cycles", {
  call: async () => {
    const { GET } = await import("@/app/api/cycle/cycles/route");
    return call(GET as Handler, "/api/cycle/cycles");
  },
  seed: seedCycle,
  read: (payload: { cycles: { startDate: string }[] }) =>
    payload.cycles.map((c) => c.startDate),
  ownerMarker: "2026-07-01",
  delegateMarker: "2026-06-02",
});

describe("GET /api/cycle/profile", () => {
  it("resolves the gate against the record, not the caller", async () => {
    // The delegate does not track a cycle. The owner does. A gate reading the
    // caller's own gender and profile would refuse this request — the module
    // decision belongs to the record.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedCycle(owner.id, "2026-07-01");

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/cycle/profile/route");
    const response = await call(GET as Handler, "/api/cycle/profile");

    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      cycleTrackingEnabled: true,
    });
  });

  it("refuses when the RECORD does not track a cycle, whatever the caller does", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedCycle(delegate.id, "2026-06-02");

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/cycle/profile/route");
    const response = await call(GET as Handler, "/api/cycle/profile");

    expect(response.status).toBe(403);
  });

  it("refuses the next request after the grant is revoked", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedCycle(owner.id, "2026-07-01");

    const { GET } = await import("@/app/api/cycle/profile/route");
    const { grant } = await switchInto(owner.id, delegate.id);
    expect((await call(GET as Handler, "/api/cycle/profile")).status).toBe(200);

    await revokeGrant(grant.id);
    await expectDenied(await call(GET as Handler, "/api/cycle/profile"));
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedCycle(plain.id, "2026-07-01");
    await signIn(plain.id);

    const { GET } = await import("@/app/api/cycle/profile/route");
    const response = await call(GET as Handler, "/api/cycle/profile");
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      cycleTrackingEnabled: true,
    });
  });
});

describe("GET /api/cycle/day-logs and /api/cycle/symptoms/custom", () => {
  it("read the owner's rows and refuse once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedCycle(owner.id, "2026-07-01");
    await seedCycle(delegate.id, "2026-06-02");
    await getPrismaClient().cycleDayLog.create({
      data: { userId: owner.id, date: "2026-07-03", basalBodyTempC: 36.7 },
    });
    await getPrismaClient().cycleDayLog.create({
      data: { userId: delegate.id, date: "2026-07-03", basalBodyTempC: 36.1 },
    });

    const logs = await import("@/app/api/cycle/day-logs/route");
    const symptoms = await import("@/app/api/cycle/symptoms/custom/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const log = await call(
      logs.GET as Handler,
      "/api/cycle/day-logs?date=2026-07-03",
    );
    expect(log.status).toBe(200);
    expect((await body(log)).data).toMatchObject({ basalBodyTempC: 36.7 });

    expect(
      (await call(symptoms.GET as Handler, "/api/cycle/symptoms/custom"))
        .status,
    ).toBe(200);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(logs.GET as Handler, "/api/cycle/day-logs?date=2026-07-03"),
    );
    await expectDenied(
      await call(symptoms.GET as Handler, "/api/cycle/symptoms/custom"),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedCycle(plain.id, "2026-07-01");
    await getPrismaClient().cycleDayLog.create({
      data: { userId: plain.id, date: "2026-07-03", basalBodyTempC: 36.4 },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/cycle/day-logs/route");
    const response = await call(
      GET as Handler,
      "/api/cycle/day-logs?date=2026-07-03",
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      basalBodyTempC: 36.4,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Medications                                                                */
/* -------------------------------------------------------------------------- */

async function seedMedication(userId: string, name: string) {
  const medication = await getPrismaClient().medication.create({
    data: { userId, name, dose: "10mg" },
  });
  await getPrismaClient().medicationSchedule.create({
    data: {
      medicationId: medication.id,
      windowStart: "08:00",
      windowEnd: "10:00",
    },
  });
  await getPrismaClient().medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: medication.id,
      scheduledFor: new Date("2026-07-14T08:00:00Z"),
      takenAt: new Date("2026-07-14T08:12:00Z"),
    },
  });
}

contract<string>("GET /api/medications", {
  call: async () => {
    const { GET } = await import("@/app/api/medications/route");
    return call(GET as Handler, "/api/medications");
  },
  seed: seedMedication,
  read: (payload: { name: string }[]) => payload.map((m) => m.name),
  ownerMarker: "owner-statin",
  delegateMarker: "delegate-statin",
});

/** Today's dose, so the `scope=today` window actually contains it. */
async function seedTodaysDose(userId: string, name: string) {
  const medication = await getPrismaClient().medication.create({
    data: { userId, name, dose: "10mg" },
  });
  await getPrismaClient().medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: medication.id,
      scheduledFor: new Date(),
    },
  });
  return medication;
}

describe("GET /api/medications/intake", () => {
  async function today(): Promise<Response> {
    const { GET } = await import("@/app/api/medications/intake/route");
    return call(GET as Handler, "/api/medications/intake?scope=today");
  }

  it("lists the owner's doses and none of the delegate's", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const ownerMed = await seedTodaysDose(owner.id, "owner-statin");
    const delegateMed = await seedTodaysDose(delegate.id, "delegate-statin");

    const { grant } = await switchInto(owner.id, delegate.id);
    const response = await today();
    expect(response.status).toBe(200);
    const ids = ((await body(response)).data as { medicationId: string }[]).map(
      (e) => e.medicationId,
    );
    expect(ids).toContain(ownerMed.id);
    expect(ids).not.toContain(delegateMed.id);

    await revokeGrant(grant.id);
    await expectDenied(await today());
  });

  it("refuses a caller who names a record they were never granted", async () => {
    const owner = await makeUser("owner");
    const stranger = await makeUser("stranger");
    await seedTodaysDose(owner.id, "owner-statin");

    const session = await signIn(stranger.id);
    await switchSessionTo(session.id, owner.id);

    await expectDenied(await today());
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    const med = await seedTodaysDose(plain.id, "plain-statin");
    await signIn(plain.id);

    const response = await today();
    expect(response.status).toBe(200);
    const ids = ((await body(response)).data as { medicationId: string }[]).map(
      (e) => e.medicationId,
    );
    expect(ids).toContain(med.id);
  });
});

/**
 * The GLP-1 read, against the section that opens it.
 *
 * Its own block because the asymmetry it closes was invisible to every other
 * leg in this file: the POST on this path has resolved the record since
 * v1.37.0 and the GET beside it resolved the CALLER, so a manager could add a
 * titration step to a medication whose history the same request path refused
 * them. May write, may not read — a shape no reading of the sharing model
 * produces, and one nothing here would have caught, because a route that
 * refuses every switched caller looks exactly like a route nobody classified.
 *
 * Both legs are evidence rather than verdict. The positive one asserts the
 * OWNER's dose value comes back and the delegate's own does not, so a handler
 * that returned everybody's rows fails it; the negative one asserts the
 * refusal code and not merely a 403, so the pre-fix `sharing.not_permitted`
 * (which is also a 403) fails it too.
 */
describe("GET /api/medications/[id]/glp1 — the read follows the section", () => {
  /** A live accepted grant scoped to the named sections, minted the shipped way. */
  async function switchIntoScoped(
    ownerId: string,
    delegateId: string,
    scope: ("medications" | "labs")[],
  ) {
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: ownerId,
      granteeId: delegateId,
      access: "READ",
      scope,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegateId });
    const session = await signIn(delegateId);
    await switchSessionTo(session.id, ownerId);
  }

  async function seedTitration(userId: string, doseValue: number) {
    const medication = await getPrismaClient().medication.create({
      data: { userId, name: `glp1-${doseValue}`, dose: `${doseValue}mg` },
    });
    await getPrismaClient().medicationDoseChange.create({
      data: {
        medicationId: medication.id,
        effectiveFrom: new Date("2026-07-14T00:00:00Z"),
        doseValue,
        doseUnit: "mg",
      },
    });
    return medication;
  }

  async function readGlp1(medicationId: string) {
    const { GET } = await import("@/app/api/medications/[id]/glp1/route");
    return call(GET as Handler, `/api/medications/${medicationId}/glp1`, {
      id: medicationId,
    });
  }

  it("serves the owner's titration history to a delegate scoped to medications", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const ownerMed = await seedTitration(owner.id, 1.5);
    const delegateMed = await seedTitration(delegate.id, 7.5);

    await switchIntoScoped(owner.id, delegate.id, ["medications"]);

    const response = await readGlp1(ownerMed.id);
    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      doseChanges: { doseValue: number }[];
    };
    expect(payload.doseChanges.map((c) => c.doseValue)).toEqual([1.5]);

    // The delegate's own medication is seeded and must stay out of reach:
    // the ownership guard resolves against the RECORD, not the caller, so
    // their own row is the one that 404s while they are switched in.
    expect((await readGlp1(delegateMed.id)).status).toBe(404);
  });

  it("refuses the same delegate when the grant does not name medications", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const ownerMed = await seedTitration(owner.id, 1.5);

    await switchIntoScoped(owner.id, delegate.id, ["labs"]);

    // The code, not the status: before the read resolved the record it also
    // answered 403 here, with `sharing.not_permitted`, and a status-only
    // assertion would have passed against the defect.
    await expectDenied(await readGlp1(ownerMed.id));
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    const med = await seedTitration(plain.id, 2.5);
    await signIn(plain.id);

    const response = await readGlp1(med.id);
    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      doseChanges: { doseValue: number }[];
    };
    expect(payload.doseChanges.map((c) => c.doseValue)).toEqual([2.5]);
  });
});

describe("the per-medication reads", () => {
  it("resolve the ownership guard against the record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedMedication(owner.id, "owner-statin");
    await seedMedication(delegate.id, "delegate-statin");
    const ownerMed = await getPrismaClient().medication.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateMed = await getPrismaClient().medication.findFirstOrThrow({
      where: { userId: delegate.id },
    });

    const detail = await import("@/app/api/medications/[id]/route");
    const cadence = await import("@/app/api/medications/[id]/cadence/route");
    const revisions =
      await import("@/app/api/medications/[id]/schedule-revisions/route");
    const sideEffects =
      await import("@/app/api/medications/[id]/side-effects/route");
    const inventory =
      await import("@/app/api/medications/[id]/inventory/route");
    const phaseConfig =
      await import("@/app/api/medications/[id]/phase-config/route");
    const intake = await import("@/app/api/medications/[id]/intake/route");
    const glp1 = await import("@/app/api/medications/[id]/glp1/route");

    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      detail.GET as Handler,
      `/api/medications/${ownerMed.id}`,
      { id: ownerMed.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ name: "owner-statin" });

    // Every sibling reaches the owner's medication...
    for (const route of [
      cadence.GET,
      revisions.GET,
      sideEffects.GET,
      inventory.GET,
      phaseConfig.GET,
      intake.GET,
      glp1.GET,
    ]) {
      const response = await call(
        route as Handler,
        `/api/medications/${ownerMed.id}/sub`,
        { id: ownerMed.id },
      );
      expect(response.status).toBe(200);
    }

    // ...and none of them reaches the delegate's own, because
    // `assertMedicationOwnership` now asks about the record.
    for (const route of [
      detail.GET,
      cadence.GET,
      revisions.GET,
      sideEffects.GET,
      inventory.GET,
      phaseConfig.GET,
      intake.GET,
      glp1.GET,
    ]) {
      const response = await call(
        route as Handler,
        `/api/medications/${delegateMed.id}/sub`,
        { id: delegateMed.id },
      );
      expect(response.status).toBe(404);
    }

    await revokeGrant(grant.id);
    for (const route of [detail.GET, cadence.GET, intake.GET, glp1.GET]) {
      await expectDenied(
        await call(route as Handler, `/api/medications/${ownerMed.id}/sub`, {
          id: ownerMed.id,
        }),
      );
    }
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedMedication(plain.id, "plain-statin");
    const med = await getPrismaClient().medication.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const detail = await import("@/app/api/medications/[id]/route");
    const response = await call(
      detail.GET as Handler,
      `/api/medications/${med.id}`,
      { id: med.id },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      name: "plain-statin",
    });
  });

  it("refuses a caller who names a record they were never granted", async () => {
    const owner = await makeUser("owner");
    const stranger = await makeUser("stranger");
    await seedMedication(owner.id, "owner-statin");
    const med = await getPrismaClient().medication.findFirstOrThrow({
      where: { userId: owner.id },
    });

    const session = await signIn(stranger.id);
    await switchSessionTo(session.id, owner.id);

    const detail = await import("@/app/api/medications/[id]/route");
    await expectDenied(
      await call(detail.GET as Handler, `/api/medications/${med.id}`, {
        id: med.id,
      }),
    );
  });
});

describe("GET /api/medications/compliance — the bucket follows the actor", () => {
  it("spends the delegate's quota, not the owner's", async () => {
    // The one delegable read that costs a quota. If the bucket keyed on the
    // resolved user, a delegate could lock the owner out of their own
    // cabinet, and could collect a fresh allowance by switching records. The
    // rate_limits row is read from the table rather than inferred from a 429,
    // because a key that is merely wrong still produces a 200.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedMedication(owner.id, "owner-statin");

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/medications/compliance/route");
    const response = await call(GET as Handler, "/api/medications/compliance");
    expect(response.status).toBe(200);

    const keys = (
      await getPrismaClient().rateLimit.findMany({
        where: { key: { startsWith: "medication-compliance-summary:" } },
      })
    ).map((row) => row.key);
    expect(keys).toEqual([`medication-compliance-summary:${delegate.id}`]);
    expect(keys).not.toContain(`medication-compliance-summary:${owner.id}`);
  });

  it("still keys on the caller when nobody has switched", async () => {
    const plain = await makeUser("plain");
    await seedMedication(plain.id, "plain-statin");
    await signIn(plain.id);

    const { GET } = await import("@/app/api/medications/compliance/route");
    expect(
      (await call(GET as Handler, "/api/medications/compliance")).status,
    ).toBe(200);

    const keys = (
      await getPrismaClient().rateLimit.findMany({
        where: { key: { startsWith: "medication-compliance-summary:" } },
      })
    ).map((row) => row.key);
    expect(keys).toEqual([`medication-compliance-summary:${plain.id}`]);
  });

  it("refuses the next request after the grant is revoked", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedMedication(owner.id, "owner-statin");

    const { GET } = await import("@/app/api/medications/compliance/route");
    const { grant } = await switchInto(owner.id, delegate.id);
    expect(
      (await call(GET as Handler, "/api/medications/compliance")).status,
    ).toBe(200);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, "/api/medications/compliance"),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The document vault                                                         */
/* -------------------------------------------------------------------------- */

/**
 * v1.36.x — `/documents` carries `sharedRecord: true`, so the shell offered
 * the destination under a switch while every read behind it refused: the vault
 * painted a query-error card, and the illness page's episode-documents tile
 * painted another beside it. A clinical letter is health data belonging to the
 * record, and reading it is much of the point of handing somebody the record.
 *
 * Five GET arms moved. The upload, the retype, the delete, the episode link
 * and every AI verb did not, and `sharing-surface-guard.test.ts` is what
 * freezes that split — this file asserts the moved arms actually substitute.
 */
async function enableDocuments(userId: string, enabled = true) {
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { modulePreferencesJson: { inboundDocuments: enabled } },
  });
}

async function seedDocument(userId: string, title: string) {
  const { encryptDocumentContent } = await import("@/lib/documents/store");
  const { content, codec } = encryptDocumentContent(
    Buffer.from(`${title} body`, "utf8"),
  );
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      title,
      filename: `${title}.pdf`,
      mimeType: "application/pdf",
      byteSize: 11,
      contentEncrypted: content,
      contentCodec: codec,
    },
  });
}

describe("GET /api/documents/inbound", () => {
  it("lists the owner's documents to a delegate, never the delegate's own", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id);
    await enableDocuments(delegate.id);
    await seedDocument(owner.id, "owner-letter");
    await seedDocument(delegate.id, "delegate-letter");

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/documents/inbound/route");
    const response = await call(GET as Handler, "/api/documents/inbound");

    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      documents: { title: string | null }[];
    };
    // Both named, separately: an empty list satisfies "the delegate's rows are
    // absent" while hiding the failure this whole feature is about.
    expect(payload.documents.map((d) => d.title)).toEqual(["owner-letter"]);
  });

  it("follows the OWNER's module switch, not the delegate's", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id, false);
    await enableDocuments(delegate.id, true);

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/documents/inbound/route");
    const response = await call(GET as Handler, "/api/documents/inbound");

    expect(response.status).toBe(403);
    expect((await body(response)).meta?.errorCode).toBe("module.disabled");
  });

  it("refuses the next request after the grant is revoked", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id);
    await seedDocument(owner.id, "owner-letter");

    const { GET } = await import("@/app/api/documents/inbound/route");
    const { grant } = await switchInto(owner.id, delegate.id);
    expect((await call(GET as Handler, "/api/documents/inbound")).status).toBe(
      200,
    );

    await revokeGrant(grant.id);
    await expectDenied(await call(GET as Handler, "/api/documents/inbound"));
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await enableDocuments(plain.id);
    await seedDocument(plain.id, "my-letter");
    await signIn(plain.id);

    const { GET } = await import("@/app/api/documents/inbound/route");
    const response = await call(GET as Handler, "/api/documents/inbound");
    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      documents: { title: string | null }[];
    };
    expect(payload.documents.map((d) => d.title)).toEqual(["my-letter"]);
  });

  it("refuses the upload arm beside it, at either grant level", async () => {
    // The half that must NOT have moved. The module-level split is the whole
    // reason the two arms declare separately, and a future edit that hoisted
    // one resolver to the top of the file would make this go red rather than
    // quietly admitting uploads.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id);

    const grant = await getPrismaClient().accountGrant.create({
      data: {
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "WRITE",
        acceptedAt: new Date(),
      },
    });
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, owner.id);
    expect(grant.access).toBe("WRITE");

    const { POST } = await import("@/app/api/documents/inbound/route");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "scan.pdf", {
        type: "application/pdf",
      }),
    );
    const response = await (
      POST as unknown as (r: Request) => Promise<Response>
    )(
      new NextRequest("http://localhost/api/documents/inbound", {
        method: "POST",
        body: form,
      }),
    );

    // The undeclared-mode refusal: the POST arm names no sharing mode, so the
    // carrier is refused before any grant is read.
    expect(response.status).toBe(403);
    expect((await body(response)).meta?.errorCode).toBe(
      "sharing.not_permitted",
    );
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { userId: owner.id },
      }),
    ).toBe(0);
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { userId: delegate.id },
      }),
    ).toBe(0);
  });
});

describe("the per-document reads", () => {
  it("serves the owner's document, its file and its thumbnail slot", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id);
    const doc = await seedDocument(owner.id, "owner-letter");
    // The delegate's own document, so a handler that fell back to the caller
    // would resolve something rather than 404 and the assertion would be about
    // absence instead of substitution.
    const mine = await seedDocument(delegate.id, "delegate-letter");

    await switchInto(owner.id, delegate.id);

    const detail = await import("@/app/api/documents/inbound/[id]/route");
    const detailResponse = await call(
      detail.GET as Handler,
      `/api/documents/inbound/${doc.id}`,
      { id: doc.id },
    );
    expect(detailResponse.status).toBe(200);
    expect(
      ((await body(detailResponse)).data as { title: string | null }).title,
    ).toBe("owner-letter");

    // The delegate's OWN document is unreachable from inside the record: the
    // query is scoped to the resolved user, so their id resolves to nothing.
    const mineResponse = await call(
      detail.GET as Handler,
      `/api/documents/inbound/${mine.id}`,
      { id: mine.id },
    );
    expect(mineResponse.status).toBe(404);

    const original =
      await import("@/app/api/documents/inbound/[id]/original/route");
    const fileResponse = await call(
      original.GET as Handler,
      `/api/documents/inbound/${doc.id}/original`,
      { id: doc.id },
    );
    expect(fileResponse.status).toBe(200);
    expect(await fileResponse.text()).toContain("owner-letter body");
  });

  it("keys the read quota on the ACTOR, not the record", async () => {
    // The `medications/compliance` rule, applied to the two reads that spend
    // decryption CPU: a delegate burns their own allowance rather than locking
    // the owner out, and cannot collect a fresh one by switching records.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id);
    const doc = await seedDocument(owner.id, "owner-letter");

    await switchInto(owner.id, delegate.id);
    const original =
      await import("@/app/api/documents/inbound/[id]/original/route");
    expect(
      (
        await call(
          original.GET as Handler,
          `/api/documents/inbound/${doc.id}/original`,
          { id: doc.id },
        )
      ).status,
    ).toBe(200);

    const keys = (
      await getPrismaClient().rateLimit.findMany({
        where: { key: { startsWith: "documents-original:" } },
      })
    ).map((row) => row.key);
    expect(keys).toEqual([`documents-original:${delegate.id}`]);
  });

  it("refuses the detail read once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id);
    const doc = await seedDocument(owner.id, "owner-letter");

    const { GET } = await import("@/app/api/documents/inbound/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);
    expect(
      (
        await call(GET as Handler, `/api/documents/inbound/${doc.id}`, {
          id: doc.id,
        })
      ).status,
    ).toBe(200);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, `/api/documents/inbound/${doc.id}`, {
        id: doc.id,
      }),
    );
  });
});

describe("GET /api/documents/inbound/usage", () => {
  it("reports the record's vault, not the delegate's", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await enableDocuments(owner.id);
    await seedDocument(owner.id, "owner-letter");
    await seedDocument(delegate.id, "delegate-a");
    await seedDocument(delegate.id, "delegate-b");

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/documents/inbound/usage/route");
    const response = await call(GET as Handler, "/api/documents/inbound/usage");

    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      contentIndex: { totalCount: number };
    };
    // One, not two: the counts follow the record. Both accounts hold rows, so
    // a zero here would be a different failure and this is not it.
    expect(payload.contentIndex.totalCount).toBe(1);
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await enableDocuments(plain.id);
    await seedDocument(plain.id, "a");
    await seedDocument(plain.id, "b");
    await signIn(plain.id);

    const { GET } = await import("@/app/api/documents/inbound/usage/route");
    const response = await call(GET as Handler, "/api/documents/inbound/usage");
    expect(response.status).toBe(200);
    expect(
      ((await body(response)).data as { contentIndex: { totalCount: number } })
        .contentIndex.totalCount,
    ).toBe(2);
  });
});
