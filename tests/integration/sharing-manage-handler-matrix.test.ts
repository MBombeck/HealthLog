/**
 * v1.37.0 — the MANAGE perimeter, driven as routes against real Postgres.
 *
 * MANAGE is the level where a delegate stops adding to somebody's record and
 * starts changing it. Seventy modules answer at it; forty-three of them can
 * destroy or rewrite something. The structural guard freezes WHICH routes say
 * `"manage"` and, since this release, freezes the conditions each admission
 * was granted on — but a frozen tag is a promise about code, not about
 * behaviour, and the promises here are the kind that fail quietly: an audit
 * row that names an id and nothing else, a rate bucket keyed on the wrong
 * person, a navigation that spends the owner's AI budget.
 *
 * So this file drives the shipped exports. Same construction as
 * `sharing-delegable-writes.test.ts`: the real `apiHandler`, the real
 * `requireRecordAuth`, the real grant table, the real Prisma writes. The grant
 * is minted through `inviteGrant` + `acceptGrant` because "a MANAGE grant
 * exists" and "a MANAGE grant can be created by the flow this release ships"
 * are different claims.
 *
 * Four legs per verb, then the conditions:
 *
 *   1. a manager with a live MANAGE grant changes the OWNER's record, and the
 *      audit row carries `userId = owner` AND `actorUserId = manager`;
 *   2. the same person under a WRITE grant is refused, and nothing moved —
 *      asserted by re-reading the row, not by the status alone;
 *   3. a caller who was never granted anything is refused the same way;
 *   4. a caller who has not switched gets exactly what they always got.
 *
 * The conditions each get their own test, and each is written so that removing
 * the implementation turns it red rather than leaving it green with a smaller
 * claim: the reconstruction legs read the audit `details` and assert the
 * VALUES, the scope leg reads the rate-limit table and asserts the key, and
 * the generation leg asserts both halves — nothing enqueued for the manager,
 * something enqueued for the owner doing the identical thing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  ADMITTED_MUTATING_HANDLERS,
  type MutatingHandlerContract,
} from "../fixtures/v137/sharing-matrix";
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// Import admissions have a durable database effect plus an asynchronous queue
// hand-off. Keep the hand-off deterministic here so each route test can prove
// the persisted job and actor audit without requiring a running worker.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: vi.fn().mockResolvedValue("matrix-job") }),
}));

/**
 * The narrative warm, stubbed at the seam the condition is about.
 *
 * C5 is the condition that costs the owner money when it is wrong, and what it
 * suppresses is an ENQUEUE — a pg-boss insert whose absence is invisible from
 * the response. Counting the calls is the only way to see it, and the count
 * has to be taken on both sides: zero for the manager is worth nothing unless
 * the same request by the owner is one.
 */
const enqueueNarrativeWarm = vi.fn(async (_payload: unknown) => {});
vi.mock("@/lib/jobs/period-narrative-shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/period-narrative-shared")>();
  return {
    ...actual,
    enqueueNarrativeWarm: (payload: unknown) => enqueueNarrativeWarm(payload),
  };
});

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `mg-${suffix}`,
      email: `mg-${suffix}@example.test`,
      displayName: `MG ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
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

/** A live grant at the named level, accepted, the caller switched into it. */
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

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

function request(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(
  handler: Handler,
  method: string,
  url: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<Response> {
  return handler(request(method, url, body), {
    params: Promise.resolve(params),
  });
}

function matrixKey({ handlerModule, action, level }: MutatingHandlerContract) {
  return `${handlerModule}:${action}:${level}`;
}

function admittedContract(
  route: string,
  action: MutatingHandlerContract["action"] = "POST",
) {
  const match = ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === route && entry.action === action,
  );
  expect(
    match,
    `missing frozen admission for ${action} ${route}`,
  ).toBeDefined();
  return match!;
}

async function matrixHandler(
  contract: MutatingHandlerContract,
): Promise<Handler> {
  const importer = ROUTE_IMPORTS[`/src/${contract.handlerModule}`];
  expect(
    importer,
    `missing route import for ${contract.handlerModule}`,
  ).toBeTypeOf("function");

  const route = await (importer as () => Promise<Record<string, unknown>>)();
  const handler = route[contract.action];
  expect(
    handler,
    `${contract.handlerModule} does not export ${contract.action}`,
  ).toBeTypeOf("function");
  return handler as Handler;
}

async function driveAdmission(
  contract: MutatingHandlerContract,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  let url: string = contract.route;
  for (const [name, value] of Object.entries(params)) {
    url = url.replace(`[${name}]`, value);
  }
  return call(
    await matrixHandler(contract),
    contract.action,
    url,
    body,
    params,
  );
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

/** The audit row a verb filed, with its details already parsed. */
async function auditRow(action: string) {
  const row = await getPrismaClient().auditLog.findFirst({
    where: { action },
    orderBy: { createdAt: "desc" },
  });
  expect(row, `no ${action} row was written`).not.toBeNull();
  return {
    row: row!,
    details: JSON.parse(row!.details ?? "{}") as Record<string, unknown>,
  };
}

const ISO = "2026-07-15T08:00:00.000Z";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string): Record<string, () => Promise<T>>;
  }
}

/** Every registered driver must name one frozen admission exactly once. */
const STRICT_DRIVER_KEYS = new Set<string>();
/**
 * Unlike the import-smoke inventory below, this set is filled only after a
 * handler has changed an owned row and filed the delegated actor in audit.
 * It is the executable answer to "did this route actually do its work?".
 */
const REAL_EFFECT_KEYS = new Set<string>();
const ROUTE_IMPORTS = import.meta.glob<Record<string, unknown>>(
  "/src/app/api/**/route.ts",
);

describe("the complete MANAGE handler matrix", () => {
  it("starts with a non-empty, exact handler inventory", () => {
    expect(ADMITTED_MUTATING_HANDLERS.length).toBe(84);
  });
});

/* -------------------------------------------------------------------------- */
/* The shape of a MANAGE case                                                 */
/* -------------------------------------------------------------------------- */

interface ManageCase<C> {
  /** The frozen admission that this driver proves end to end. */
  contract: MutatingHandlerContract;
  /** Rows the verb acts on, created under the record it will change. */
  prepare: (recordOwnerId: string) => Promise<C>;
  /** Drive the shipped export against the current session. */
  act: (ctx: C) => Promise<Response>;
  /** The status a successful call answers with. */
  ok: number;
  /** The action the happy path files through `auditLog`. */
  auditAction: string;
  /** True once the verb has taken effect on the prepared rows. */
  applied: (ctx: C) => Promise<boolean>;
}

function manageContract<C>(name: string, c: ManageCase<C>) {
  STRICT_DRIVER_KEYS.add(matrixKey(c.contract));
  describe(name, () => {
    it("changes the owner's record and names the manager as actor", async () => {
      const owner = await makeUser("owner");
      const manager = await makeUser("manager");
      const ctx = await c.prepare(owner.id);

      await switchInto(owner.id, manager.id, "MANAGE");
      const response = await c.act(ctx);
      expect(response.status).toBe(c.ok);

      // The change landed…
      expect(await c.applied(ctx)).toBe(true);
      // …and the trail says who made it, under whose record.
      const { row } = await auditRow(c.auditAction);
      expect(row.userId).toBe(owner.id);
      expect(row.actorUserId).toBe(manager.id);
      REAL_EFFECT_KEYS.add(matrixKey(c.contract));
    });

    it("refuses a WRITE grant, and nothing moves", async () => {
      const owner = await makeUser("owner");
      const helper = await makeUser("helper");
      const ctx = await c.prepare(owner.id);

      await switchInto(owner.id, helper.id, "WRITE");
      await expectDenied(await c.act(ctx));

      // The mutation-check rule: assert it did NOT apply, by re-reading.
      expect(await c.applied(ctx)).toBe(false);
    });

    it("refuses a caller who names a record they were never granted", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      const ctx = await c.prepare(owner.id);

      await claimWithoutGrant(owner.id, stranger.id);
      await expectDenied(await c.act(ctx));
      expect(await c.applied(ctx)).toBe(false);
    });

    it("is unchanged for a caller who has not switched", async () => {
      const plain = await makeUser("plain");
      const ctx = await c.prepare(plain.id);
      await signIn(plain.id);

      expect((await c.act(ctx)).status).toBe(c.ok);
      expect(await c.applied(ctx)).toBe(true);

      const { row } = await auditRow(c.auditAction);
      expect(row.userId).toBe(plain.id);
      expect(row.actorUserId).toBeNull();
    });
  });
}

/** The same proof shape for the small WRITE admission at the edge of MANAGE. */
function writeEffectContract<C>(name: string, c: ManageCase<C>) {
  STRICT_DRIVER_KEYS.add(matrixKey(c.contract));
  describe(name, () => {
    it("keeps the owner's write effective", async () => {
      const owner = await makeUser("owner");
      const ctx = await c.prepare(owner.id);
      await signIn(owner.id);
      expect((await c.act(ctx)).status).toBe(c.ok);
      expect(await c.applied(ctx)).toBe(true);
    });

    it("refuses the lower sharing level without applying it", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("denied");
      const ctx = await c.prepare(owner.id);
      await switchInto(owner.id, delegate.id, "READ");
      await expectDenied(await c.act(ctx));
      expect(await c.applied(ctx)).toBe(false);
    });

    it("writes for the owner and audits the WRITE actor", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("writer");
      const ctx = await c.prepare(owner.id);
      await switchInto(owner.id, delegate.id, "WRITE");
      expect((await c.act(ctx)).status).toBe(c.ok);
      expect(await c.applied(ctx)).toBe(true);
      const { row } = await auditRow(c.auditAction);
      expect(row.userId).toBe(owner.id);
      expect(row.actorUserId).toBe(delegate.id);
      REAL_EFFECT_KEYS.add(matrixKey(c.contract));
    });

    it("refuses an unsanctioned acting session without applying it", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      const ctx = await c.prepare(owner.id);
      await claimWithoutGrant(owner.id, stranger.id);
      await expectDenied(await c.act(ctx));
      expect(await c.applied(ctx)).toBe(false);
    });
  });
}

type RouteDriver<C> = Omit<ManageCase<C>, "contract" | "act"> & {
  route: string;
  action?: MutatingHandlerContract["action"];
  params?: (ctx: C) => Record<string, string>;
  body?: (ctx: C) => unknown;
};

function proveManageRoute<C>(name: string, driver: RouteDriver<C>) {
  const contract = admittedContract(driver.route, driver.action);
  manageContract(name, {
    ...driver,
    contract,
    act: (ctx) =>
      driveAdmission(contract, driver.params?.(ctx), driver.body?.(ctx)),
  });
}

function proveWriteRoute<C>(name: string, driver: RouteDriver<C>) {
  const contract = admittedContract(driver.route, driver.action);
  writeEffectContract(name, {
    ...driver,
    contract,
    act: (ctx) =>
      driveAdmission(contract, driver.params?.(ctx), driver.body?.(ctx)),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  enqueueNarrativeWarm.mockClear();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

async function makeMeasurement(userId: string, value = 80) {
  // The timestamp moves per row: `(userId, type, measuredAt, source,
  // sleepStage)` is unique, so two fixtures on the same instant collide.
  const measuredAt = new Date(Date.parse(ISO) + counter++ * 60_000);
  return getPrismaClient().measurement.create({
    data: {
      userId,
      type: "WEIGHT",
      value,
      unit: "kg",
      measuredAt,
      source: "MANUAL",
    },
  });
}

async function makeLabResult(userId: string) {
  return getPrismaClient().labResult.create({
    data: {
      userId,
      analyte: "HbA1c",
      value: 5.2,
      unit: "%",
      takenAt: new Date(ISO),
    },
  });
}

async function makeAllergy(userId: string) {
  return getPrismaClient().allergy.create({
    data: {
      userId,
      substance: "Penicillin",
      category: "MEDICATION",
      type: "ALLERGY",
      severity: "SEVERE",
      status: "ACTIVE",
      onsetAt: new Date("2020-03-01T00:00:00.000Z"),
    },
  });
}

async function makeReminder(userId: string) {
  return getPrismaClient().measurementReminder.create({
    data: {
      userId,
      label: "Colonoscopy recall",
      measurementType: null,
      intervalDays: 365,
      notifyHour: 9,
      nextDueAt: new Date("2027-03-01T08:00:00.000Z"),
      enabled: true,
    },
  });
}

async function makeEpisode(userId: string) {
  return getPrismaClient().illnessEpisode.create({
    data: {
      userId,
      label: "Influenza",
      type: "INFECTION",
      onsetAt: new Date(ISO),
    },
  });
}

async function makePractitioner(userId: string) {
  return getPrismaClient().practitioner.create({
    data: { userId, name: "Praxis Nord", specialty: "Internal medicine" },
  });
}

/**
 * A visit that already happened.
 *
 * Past rather than booked on purpose: a PLANNED future visit mints an
 * appointment reminder, and the drivers below assert one effect each. Keeping
 * the fixture in the past leaves the edit and delete verbs saying only what
 * they are here to say.
 */
async function makeVisit(userId: string) {
  return getPrismaClient().encounter.create({
    data: {
      userId,
      occurredAt: new Date(ISO),
      status: "DONE",
      kind: "ROUTINE",
    },
  });
}

/**
 * One logged dose, catalogue-identified.
 *
 * `tetanus` rather than a combination on purpose: the drivers below assert one
 * effect each, and a combination would satisfy several booster reminders at
 * once if the fixture ever grew one. There is none here, so no reminder moves
 * and the edit and delete verbs say only what they are here to say.
 */
async function makeVaccination(userId: string) {
  return getPrismaClient().vaccinationRecord.create({
    data: { userId, occurredAt: new Date(ISO), antigenSlug: "tetanus" },
  });
}

async function makeFamilyHistory(userId: string) {
  return getPrismaClient().familyHistoryEntry.create({
    data: { userId, relationship: "MOTHER", condition: "Hypertension" },
  });
}

async function makeMedication(userId: string, name = "Statin") {
  return getPrismaClient().medication.create({
    data: { userId, name, dose: "10mg" },
  });
}

async function makeMedicationIntake(userId: string) {
  const medication = await makeMedication(userId, "Insulin");
  const event = await getPrismaClient().medicationIntakeEvent.create({
    data: { userId, medicationId: medication.id, scheduledFor: new Date(ISO) },
  });
  return { medication, event };
}

async function makeInventoryItem(userId: string) {
  const medication = await makeMedication(userId);
  const item = await getPrismaClient().medicationInventoryItem.create({
    data: {
      userId,
      medicationId: medication.id,
      unitsTotal: 20,
      unitsRemaining: 20,
    },
  });
  return { medication, item };
}

async function makeScheduleRevision(userId: string) {
  const medication = await makeMedication(userId);
  const revision = await getPrismaClient().medicationScheduleRevision.create({
    data: {
      medicationId: medication.id,
      validFrom: new Date(Date.now() - 3 * 86_400_000),
      validUntil: new Date(Date.now() - 2 * 86_400_000),
      source: "MANUAL",
      payload: [{ timesOfDay: ["08:00"] }],
    },
  });
  return { medication, revision };
}

/* -------------------------------------------------------------------------- */
/* 1 — the four legs, one verb per domain family                              */
/* -------------------------------------------------------------------------- */

manageContract("PUT /api/measurements/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/measurements/[id]" && entry.action === "PUT",
  )!,
  prepare: (ownerId) => makeMeasurement(ownerId),
  act: async (row) => {
    const { PUT } = await import("@/app/api/measurements/[id]/route");
    return call(
      PUT as Handler,
      "PUT",
      `/api/measurements/${row.id}`,
      {
        value: 74.5,
      },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurement.update",
  applied: async (row) => {
    const after = await getPrismaClient().measurement.findUnique({
      where: { id: row.id },
    });
    return after?.value === 74.5;
  },
});

manageContract("DELETE /api/measurements/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/measurements/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeMeasurement(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/measurements/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/measurements/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurement.delete",
  applied: async (row) => {
    const after = await getPrismaClient().measurement.findUnique({
      where: { id: row.id },
    });
    return after?.deletedAt !== null;
  },
});

manageContract("PUT /api/labs/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/labs/[id]" && entry.action === "PUT",
  )!,
  prepare: (ownerId) => makeLabResult(ownerId),
  act: async (row) => {
    const { PUT } = await import("@/app/api/labs/[id]/route");
    return call(
      PUT as Handler,
      "PUT",
      `/api/labs/${row.id}`,
      { value: 6.1 },
      {
        id: row.id,
      },
    );
  },
  ok: 200,
  auditAction: "labResult.update",
  applied: async (row) => {
    const after = await getPrismaClient().labResult.findUnique({
      where: { id: row.id },
    });
    return after?.value === 6.1;
  },
});

manageContract("PATCH /api/allergies/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/allergies/[id]" && entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeAllergy(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/allergies/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/allergies/${row.id}`,
      { severity: "MILD" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "allergy.update",
  applied: async (row) => {
    const after = await getPrismaClient().allergy.findUnique({
      where: { id: row.id },
    });
    return after?.severity === "MILD";
  },
});

manageContract("DELETE /api/measurement-reminders/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/measurement-reminders/[id]" &&
      entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeReminder(ownerId),
  act: async (row) => {
    const { DELETE } =
      await import("@/app/api/measurement-reminders/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/measurement-reminders/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurementReminder.delete",
  applied: async (row) => {
    const after = await getPrismaClient().measurementReminder.findUnique({
      where: { id: row.id },
    });
    return after === null;
  },
});

manageContract("POST /api/measurement-reminders/[id]/skip", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/measurement-reminders/[id]/skip" &&
      entry.action === "POST",
  )!,
  prepare: (ownerId) => makeReminder(ownerId),
  act: async (row) => {
    const { POST } =
      await import("@/app/api/measurement-reminders/[id]/skip/route");
    return call(
      POST as Handler,
      "POST",
      `/api/measurement-reminders/${row.id}/skip`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurementReminder.skip",
  applied: async (row) => {
    const after = await getPrismaClient().measurementReminder.findUnique({
      where: { id: row.id },
    });
    const ledger = await getPrismaClient().measurementReminderEvent.count({
      where: { reminderId: row.id, kind: "SKIPPED" },
    });
    // A skip stamps its own column and ledger row and never completes the
    // reminder: lastSatisfiedAt must stay exactly as prepared (null).
    return (
      after?.lastSkippedAt !== null &&
      after?.lastSatisfiedAt === null &&
      ledger === 1
    );
  },
});

manageContract("POST /api/measurement-reminders/[id]/snooze", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/measurement-reminders/[id]/snooze" &&
      entry.action === "POST",
  )!,
  prepare: (ownerId) => makeReminder(ownerId),
  act: async (row) => {
    const { POST } =
      await import("@/app/api/measurement-reminders/[id]/snooze/route");
    return call(
      POST as Handler,
      "POST",
      `/api/measurement-reminders/${row.id}/snooze`,
      { until: "2027-01-15" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurementReminder.snooze",
  applied: async (row) => {
    const after = await getPrismaClient().measurementReminder.findUnique({
      where: { id: row.id },
    });
    return after?.snoozedUntil !== null && after?.lastSatisfiedAt === null;
  },
});

/* -------------------------------------------------------------------------- */
/* 1a — measurements and their reminder schedules                             */
/* -------------------------------------------------------------------------- */

writeEffectContract("POST /api/measurements", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/measurements" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId, measuredAt: new Date(ISO) }),
  act: async ({ measuredAt }) => {
    const { POST } = await import("@/app/api/measurements/route");
    return call(POST as Handler, "POST", "/api/measurements", {
      type: "WEIGHT",
      value: 81,
      measuredAt: measuredAt.toISOString(),
    });
  },
  ok: 201,
  auditAction: "measurement.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().measurement.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("POST /api/measurements/bulk-delete", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/measurements/bulk-delete",
  )!,
  prepare: async (ownerId) => makeMeasurement(ownerId),
  act: async (row) => {
    const { POST } = await import("@/app/api/measurements/bulk-delete/route");
    return call(POST as Handler, "POST", "/api/measurements/bulk-delete", {
      ids: [row.id],
    });
  },
  ok: 200,
  auditAction: "measurement.delete.bulk",
  applied: async (row) =>
    (await getPrismaClient().measurement.findUnique({ where: { id: row.id } }))
      ?.deletedAt !== null,
});

manageContract("POST /api/measurements/restore", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/measurements/restore",
  )!,
  prepare: async (ownerId) => {
    const row = await makeMeasurement(ownerId);
    return getPrismaClient().measurement.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
  },
  act: async (row) => {
    const { POST } = await import("@/app/api/measurements/restore/route");
    return call(POST as Handler, "POST", "/api/measurements/restore", {
      ids: [row.id],
    });
  },
  ok: 200,
  auditAction: "measurement.restore",
  applied: async (row) =>
    (await getPrismaClient().measurement.findUnique({ where: { id: row.id } }))
      ?.deletedAt === null,
});

manageContract("POST /api/measurement-reminders", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/measurement-reminders" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/measurement-reminders/route");
    return call(POST as Handler, "POST", "/api/measurement-reminders", {
      label: "Annual review",
      intervalDays: 365,
      notifyHour: 9,
      enabled: true,
    });
  },
  ok: 201,
  auditAction: "measurementReminder.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().measurementReminder.count({
      where: { userId: ownerId, label: "Annual review" },
    })) === 1,
});

manageContract("PATCH /api/measurement-reminders/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/measurement-reminders/[id]" &&
      entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeReminder(ownerId),
  act: async (row) => {
    const { PATCH } =
      await import("@/app/api/measurement-reminders/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/measurement-reminders/${row.id}`,
      { label: "Annual review updated" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurementReminder.update",
  applied: async (row) =>
    (
      await getPrismaClient().measurementReminder.findUnique({
        where: { id: row.id },
      })
    )?.label === "Annual review updated",
});

manageContract("POST /api/measurement-reminders/[id]/complete", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/measurement-reminders/[id]/complete",
  )!,
  prepare: (ownerId) => makeReminder(ownerId),
  act: async (row) => {
    const { POST } =
      await import("@/app/api/measurement-reminders/[id]/complete/route");
    return call(
      POST as Handler,
      "POST",
      `/api/measurement-reminders/${row.id}/complete`,
      {},
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurementReminder.complete",
  applied: async (row) =>
    (
      await getPrismaClient().measurementReminder.findUnique({
        where: { id: row.id },
      })
    )?.lastSatisfiedAt !== null,
});

manageContract("POST /api/measurement-reminders/[id]/satisfy", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/measurement-reminders/[id]/satisfy",
  )!,
  prepare: (ownerId) => makeReminder(ownerId),
  act: async (row) => {
    const { POST } =
      await import("@/app/api/measurement-reminders/[id]/satisfy/route");
    return call(
      POST as Handler,
      "POST",
      `/api/measurement-reminders/${row.id}/satisfy`,
      {},
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurementReminder.satisfy",
  applied: async (row) =>
    (
      await getPrismaClient().measurementReminder.findUnique({
        where: { id: row.id },
      })
    )?.lastSatisfiedAt !== null,
});

/* -------------------------------------------------------------------------- */
/* 1b — labs, catalog entries, allergies, family, and illness                */
/* -------------------------------------------------------------------------- */

writeEffectContract("POST /api/labs", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/labs" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/labs/route");
    return call(POST as Handler, "POST", "/api/labs", {
      analyte: "HbA1c",
      value: 5.2,
      unit: "%",
      takenAt: ISO,
    });
  },
  ok: 201,
  auditAction: "labResult.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().labResult.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("DELETE /api/labs/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/labs/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeLabResult(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/labs/[id]/route");
    return call(DELETE as Handler, "DELETE", `/api/labs/${row.id}`, undefined, {
      id: row.id,
    });
  },
  ok: 200,
  auditAction: "labResult.delete",
  applied: async (row) =>
    (await getPrismaClient().labResult.findUnique({ where: { id: row.id } }))
      ?.deletedAt !== null,
});

manageContract("POST /api/labs/restore", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/labs/restore",
  )!,
  prepare: async (ownerId) => {
    const row = await makeLabResult(ownerId);
    return getPrismaClient().labResult.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
  },
  act: async (row) => {
    const { POST } = await import("@/app/api/labs/restore/route");
    return call(POST as Handler, "POST", "/api/labs/restore", {
      ids: [row.id],
    });
  },
  ok: 200,
  auditAction: "labResult.restore",
  applied: async (row) =>
    (await getPrismaClient().labResult.findUnique({ where: { id: row.id } }))
      ?.deletedAt === null,
});

writeEffectContract("POST /api/biomarkers", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/biomarkers",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/biomarkers/route");
    return call(POST as Handler, "POST", "/api/biomarkers", {
      name: "Ferritin",
      unit: "µg/L",
    });
  },
  ok: 201,
  auditAction: "biomarker.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().biomarker.count({
      where: { userId: ownerId, name: "Ferritin" },
    })) === 1,
});

manageContract("PUT /api/biomarkers/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/biomarkers/[id]" && entry.action === "PUT",
  )!,
  prepare: async (userId) =>
    getPrismaClient().biomarker.create({
      data: { userId, name: "Ferritin", unit: "µg/L" },
    }),
  act: async (row) => {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    return call(
      PUT as Handler,
      "PUT",
      `/api/biomarkers/${row.id}`,
      { unit: "ng/mL" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "biomarker.update",
  applied: async (row) =>
    (await getPrismaClient().biomarker.findUnique({ where: { id: row.id } }))
      ?.unit === "ng/mL",
});

manageContract("POST /api/allergies", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/allergies" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/allergies/route");
    return call(POST as Handler, "POST", "/api/allergies", {
      substance: "Pollen",
      category: "ENVIRONMENT",
    });
  },
  ok: 201,
  auditAction: "allergy.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().allergy.count({
      where: { userId: ownerId, substance: "Pollen" },
    })) === 1,
});

manageContract("DELETE /api/allergies/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/allergies/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeAllergy(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/allergies/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/allergies/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "allergy.delete",
  applied: async (row) =>
    (await getPrismaClient().allergy.findUnique({ where: { id: row.id } }))
      ?.deletedAt !== null,
});

manageContract("POST /api/family-history", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/family-history" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/family-history/route");
    return call(POST as Handler, "POST", "/api/family-history", {
      relationship: "MOTHER",
      condition: "Hypertension",
    });
  },
  ok: 201,
  auditAction: "family-history.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().familyHistoryEntry.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("PATCH /api/family-history/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/family-history/[id]" && entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeFamilyHistory(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/family-history/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/family-history/${row.id}`,
      { ageAtOnset: 50 },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "family-history.update",
  applied: async (row) =>
    (
      await getPrismaClient().familyHistoryEntry.findUnique({
        where: { id: row.id },
      })
    )?.ageAtOnset === 50,
});

manageContract("DELETE /api/family-history/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/family-history/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeFamilyHistory(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/family-history/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/family-history/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "family-history.delete",
  applied: async (row) =>
    (
      await getPrismaClient().familyHistoryEntry.findUnique({
        where: { id: row.id },
      })
    )?.deletedAt !== null,
});

writeEffectContract("POST /api/illness/episodes", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/illness/episodes" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/illness/episodes/route");
    return call(POST as Handler, "POST", "/api/illness/episodes", {
      label: "Influenza",
      type: "INFECTION",
    });
  },
  ok: 201,
  auditAction: "illness.episode.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().illnessEpisode.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("PATCH /api/illness/episodes/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/illness/episodes/[id]" && entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeEpisode(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/illness/episodes/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/illness/episodes/${row.id}`,
      { label: "Influenza A" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "illness.episode.update",
  applied: async (row) =>
    (
      await getPrismaClient().illnessEpisode.findUnique({
        where: { id: row.id },
      })
    )?.label === "Influenza A",
});

manageContract("DELETE /api/illness/episodes/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/illness/episodes/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeEpisode(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/illness/episodes/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/illness/episodes/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "illness.episode.delete",
  applied: async (row) =>
    (
      await getPrismaClient().illnessEpisode.findUnique({
        where: { id: row.id },
      })
    )?.deletedAt !== null,
});

manageContract("PATCH /api/illness/episodes/[id]/resolve", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/illness/episodes/[id]/resolve",
  )!,
  prepare: (ownerId) => makeEpisode(ownerId),
  act: async (row) => {
    const { PATCH } =
      await import("@/app/api/illness/episodes/[id]/resolve/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/illness/episodes/${row.id}/resolve`,
      {},
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "illness.episode.resolve",
  applied: async (row) =>
    (
      await getPrismaClient().illnessEpisode.findUnique({
        where: { id: row.id },
      })
    )?.resolvedAt !== null,
});

manageContract("POST /api/illness/episodes/[id]/restore", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/illness/episodes/[id]/restore",
  )!,
  prepare: async (ownerId) => {
    const row = await makeEpisode(ownerId);
    return getPrismaClient().illnessEpisode.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
  },
  act: async (row) => {
    const { POST } =
      await import("@/app/api/illness/episodes/[id]/restore/route");
    return call(
      POST as Handler,
      "POST",
      `/api/illness/episodes/${row.id}/restore`,
      {},
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "illness.episode.restore",
  applied: async (row) =>
    (
      await getPrismaClient().illnessEpisode.findUnique({
        where: { id: row.id },
      })
    )?.deletedAt === null,
});

async function makeSymptomDefinition(userId: string) {
  return getPrismaClient().symptomDefinition.create({
    data: {
      userId,
      labelEncrypted: encryptToBytes("Aura"),
      icon: "Zap",
    },
  });
}

async function makeSymptomEvent(userId: string) {
  const definition = await makeSymptomDefinition(userId);
  return getPrismaClient().symptomEvent.create({
    data: {
      userId,
      definitionId: definition.id,
      occurredAt: new Date(ISO),
      intensity: 6,
    },
  });
}

manageContract("POST /api/symptoms/definitions", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/symptoms/definitions" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/symptoms/definitions/route");
    return call(POST as Handler, "POST", "/api/symptoms/definitions", {
      label: "Aura",
      icon: "Zap",
    });
  },
  ok: 201,
  auditAction: "symptoms.definition.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().symptomDefinition.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("PATCH /api/symptoms/definitions/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/symptoms/definitions/[id]" &&
      entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeSymptomDefinition(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/symptoms/definitions/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/symptoms/definitions/${row.id}`,
      { icon: "Brain" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "symptoms.definition.update",
  applied: async (row) =>
    (
      await getPrismaClient().symptomDefinition.findUnique({
        where: { id: row.id },
      })
    )?.icon === "Brain",
});

manageContract("DELETE /api/symptoms/definitions/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/symptoms/definitions/[id]" &&
      entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeSymptomDefinition(ownerId),
  act: async (row) => {
    const { DELETE } =
      await import("@/app/api/symptoms/definitions/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/symptoms/definitions/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "symptoms.definition.delete",
  applied: async (row) =>
    (
      await getPrismaClient().symptomDefinition.findUnique({
        where: { id: row.id },
      })
    )?.isActive === false,
});

writeEffectContract("POST /api/symptoms/events", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/symptoms/events" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({
    ownerId,
    definition: await makeSymptomDefinition(ownerId),
  }),
  act: async ({ definition }) => {
    const { POST } = await import("@/app/api/symptoms/events/route");
    return call(POST as Handler, "POST", "/api/symptoms/events", {
      definitionId: definition.id,
      intensity: 7,
    });
  },
  ok: 201,
  auditAction: "symptoms.event.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().symptomEvent.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("PATCH /api/symptoms/events/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/symptoms/events/[id]" && entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeSymptomEvent(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/symptoms/events/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/symptoms/events/${row.id}`,
      { intensity: 9 },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "symptoms.event.update",
  applied: async (row) =>
    (
      await getPrismaClient().symptomEvent.findUnique({
        where: { id: row.id },
      })
    )?.intensity === 9,
});

manageContract("DELETE /api/symptoms/events/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/symptoms/events/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeSymptomEvent(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/symptoms/events/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/symptoms/events/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "symptoms.event.delete",
  applied: async (row) =>
    (await getPrismaClient().symptomEvent.findUnique({
      where: { id: row.id },
    })) === null,
});

writeEffectContract("POST /api/encounters", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/encounters" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/encounters/route");
    return call(POST as Handler, "POST", "/api/encounters", {
      occurredAt: ISO,
      status: "DONE",
    });
  },
  ok: 201,
  auditAction: "encounter.visit.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().encounter.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("PATCH /api/encounters/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/encounters/[id]" && entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeVisit(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/encounters/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/encounters/${row.id}`,
      { kind: "SPECIALIST" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "encounter.visit.update",
  applied: async (row) =>
    (await getPrismaClient().encounter.findUnique({ where: { id: row.id } }))
      ?.kind === "SPECIALIST",
});

manageContract("DELETE /api/encounters/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/encounters/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeVisit(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/encounters/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/encounters/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "encounter.visit.delete",
  applied: async (row) =>
    (await getPrismaClient().encounter.findUnique({ where: { id: row.id } }))
      ?.deletedAt !== null,
});

manageContract("POST /api/encounters/[id]/restore", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/encounters/[id]/restore",
  )!,
  prepare: async (ownerId) => {
    const row = await makeVisit(ownerId);
    return getPrismaClient().encounter.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
  },
  act: async (row) => {
    const { POST } = await import("@/app/api/encounters/[id]/restore/route");
    return call(
      POST as Handler,
      "POST",
      `/api/encounters/${row.id}/restore`,
      {},
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "encounter.visit.restore",
  applied: async (row) =>
    (await getPrismaClient().encounter.findUnique({ where: { id: row.id } }))
      ?.deletedAt === null,
});

writeEffectContract("POST /api/practitioners", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/practitioners" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/practitioners/route");
    return call(POST as Handler, "POST", "/api/practitioners", {
      name: "Praxis Nord",
    });
  },
  ok: 201,
  auditAction: "practitioner.contact.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().practitioner.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("PATCH /api/practitioners/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/practitioners/[id]" && entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makePractitioner(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/practitioners/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/practitioners/${row.id}`,
      { name: "Praxis Süd" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "practitioner.contact.update",
  applied: async (row) =>
    (await getPrismaClient().practitioner.findUnique({ where: { id: row.id } }))
      ?.name === "Praxis Süd",
});

manageContract("DELETE /api/practitioners/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/practitioners/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makePractitioner(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/practitioners/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/practitioners/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "practitioner.contact.delete",
  applied: async (row) =>
    (await getPrismaClient().practitioner.findUnique({ where: { id: row.id } }))
      ?.deletedAt !== null,
});

manageContract("POST /api/practitioners/[id]/restore", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/practitioners/[id]/restore",
  )!,
  prepare: async (ownerId) => {
    const row = await makePractitioner(ownerId);
    return getPrismaClient().practitioner.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
  },
  act: async (row) => {
    const { POST } = await import("@/app/api/practitioners/[id]/restore/route");
    return call(
      POST as Handler,
      "POST",
      `/api/practitioners/${row.id}/restore`,
      {},
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "practitioner.contact.restore",
  applied: async (row) =>
    (await getPrismaClient().practitioner.findUnique({ where: { id: row.id } }))
      ?.deletedAt === null,
});

writeEffectContract("POST /api/vaccinations", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/vaccinations" && entry.action === "POST",
  )!,
  prepare: async (ownerId) => ({ ownerId }),
  act: async () => {
    const { POST } = await import("@/app/api/vaccinations/route");
    return call(POST as Handler, "POST", "/api/vaccinations", {
      occurredAt: ISO,
      antigenSlug: "tetanus",
    });
  },
  ok: 201,
  auditAction: "vaccination.record.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().vaccinationRecord.count({
      where: { userId: ownerId },
    })) === 1,
});

manageContract("PATCH /api/vaccinations/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/vaccinations/[id]" && entry.action === "PATCH",
  )!,
  prepare: (ownerId) => makeVaccination(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/vaccinations/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/vaccinations/${row.id}`,
      { lotNumber: "MX-2211" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "vaccination.record.update",
  applied: async (row) =>
    (
      await getPrismaClient().vaccinationRecord.findUnique({
        where: { id: row.id },
      })
    )?.lotNumber === "MX-2211",
});

manageContract("DELETE /api/vaccinations/[id]", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/vaccinations/[id]" && entry.action === "DELETE",
  )!,
  prepare: (ownerId) => makeVaccination(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/vaccinations/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/vaccinations/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "vaccination.record.delete",
  applied: async (row) =>
    (
      await getPrismaClient().vaccinationRecord.findUnique({
        where: { id: row.id },
      })
    )?.deletedAt !== null,
});

manageContract("POST /api/vaccinations/[id]/restore", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) => entry.route === "/api/vaccinations/[id]/restore",
  )!,
  prepare: async (ownerId) => {
    const row = await makeVaccination(ownerId);
    return getPrismaClient().vaccinationRecord.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
  },
  act: async (row) => {
    const { POST } = await import("@/app/api/vaccinations/[id]/restore/route");
    return call(
      POST as Handler,
      "POST",
      `/api/vaccinations/${row.id}/restore`,
      {},
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "vaccination.record.restore",
  applied: async (row) =>
    (
      await getPrismaClient().vaccinationRecord.findUnique({
        where: { id: row.id },
      })
    )?.deletedAt === null,
});

proveWriteRoute("POST /api/vaccinations/[id]/booster", {
  route: "/api/vaccinations/[id]/booster",
  // The dose the booster is planned against. `makeVaccination` records a
  // monovalent tetanus dose, so the mint keys the reminder on the tetanus
  // antigen and `applied` can prove exactly one reminder now carries it.
  prepare: async (ownerId) => ({
    ownerId,
    vaccination: await makeVaccination(ownerId),
  }),
  params: ({ vaccination }) => ({ id: vaccination.id }),
  body: () => ({ intervalMonths: 120, label: "Tetanus booster" }),
  ok: 201,
  auditAction: "vaccination.booster.planned",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().measurementReminder.count({
      where: { userId: ownerId, vaccinationAntigen: "tetanus" },
    })) === 1,
});

manageContract("POST /api/illness/episodes/[id]/day-logs", {
  contract: ADMITTED_MUTATING_HANDLERS.find(
    (entry) =>
      entry.route === "/api/illness/episodes/[id]/day-logs" &&
      entry.action === "POST",
  )!,
  prepare: (ownerId) => makeEpisode(ownerId),
  act: async (row) => {
    const { POST } =
      await import("@/app/api/illness/episodes/[id]/day-logs/route");
    return call(
      POST as Handler,
      "POST",
      `/api/illness/episodes/${row.id}/day-logs`,
      { date: "2026-07-15", feverC: 38.1 },
      { id: row.id },
    );
  },
  ok: 201,
  auditAction: "illness.day-log.upsert",
  applied: async (row) =>
    (await getPrismaClient().illnessDayLog.count({
      where: { episodeId: row.id, feverC: 38.1 },
    })) === 1,
});

/* -------------------------------------------------------------------------- */
/* 1c — the medication record, its events, supply, and import queue          */
/* -------------------------------------------------------------------------- */

proveWriteRoute("POST /api/medications/[id]/side-effects", {
  route: "/api/medications/[id]/side-effects",
  prepare: async (ownerId) => ({
    ownerId,
    medication: await makeMedication(ownerId),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  body: () => ({ entry: "NAUSEA", severity: 3 }),
  ok: 201,
  auditAction: "medication.sideEffect.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().medicationSideEffect.count({
      where: { userId: ownerId },
    })) === 1,
});

proveWriteRoute("POST /api/medications", {
  route: "/api/medications",
  prepare: async (ownerId) => ({ ownerId }),
  body: () => ({
    name: "Metformin",
    dose: "500mg",
    schedules: [{ windowStart: "08:00", windowEnd: "10:00" }],
  }),
  ok: 201,
  auditAction: "medication.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().medication.count({
      where: { userId: ownerId, name: "Metformin" },
    })) === 1,
});

proveWriteRoute("POST /api/medications/intake", {
  route: "/api/medications/intake",
  prepare: async (ownerId) => ({
    ownerId,
    ...(await makeMedicationIntake(ownerId)),
  }),
  body: ({ event }) => ({ intakeId: event.id, status: "taken" }),
  ok: 200,
  auditAction: "medications.intake.update",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().medicationIntakeEvent.count({
      where: { userId: ownerId, takenAt: { not: null }, deletedAt: null },
    })) === 1,
});

proveWriteRoute("POST /api/medications/[id]/intake", {
  route: "/api/medications/[id]/intake",
  prepare: async (ownerId) => ({
    ownerId,
    medication: await makeMedication(ownerId),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  body: () => ({ takenAt: new Date().toISOString() }),
  ok: 201,
  auditAction: "medication.intake",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().medicationIntakeEvent.count({
      where: { userId: ownerId, takenAt: { not: null } },
    })) === 1,
});

proveManageRoute("PUT /api/medications/[id]", {
  route: "/api/medications/[id]",
  action: "PUT",
  prepare: (ownerId) => makeMedication(ownerId),
  params: (medication) => ({ id: medication.id }),
  body: () => ({ dose: "20mg" }),
  ok: 200,
  auditAction: "medication.update",
  applied: async (medication) =>
    (
      await getPrismaClient().medication.findUnique({
        where: { id: medication.id },
      })
    )?.dose === "20mg",
});

proveManageRoute("POST /api/medications/[id]/schedule-revisions", {
  route: "/api/medications/[id]/schedule-revisions",
  prepare: async (ownerId) => ({
    ownerId,
    medication: await makeMedication(ownerId),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  body: () => ({
    validFrom: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    validUntil: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    timesOfDay: ["08:00"],
  }),
  ok: 201,
  auditAction: "medication.schedule_revision.created",
  applied: async ({ medication }) =>
    (await getPrismaClient().medicationScheduleRevision.count({
      where: { medicationId: medication.id },
    })) === 1,
});

proveManageRoute(
  "PATCH /api/medications/[id]/schedule-revisions/[revisionId]",
  {
    route: "/api/medications/[id]/schedule-revisions/[revisionId]",
    action: "PATCH",
    prepare: async (ownerId) => ({
      ownerId,
      ...(await makeScheduleRevision(ownerId)),
      targetValidFrom: new Date(Date.now() - 4 * 86_400_000),
      targetValidUntil: new Date(Date.now() - 3 * 86_400_000),
    }),
    params: ({ medication, revision }) => ({
      id: medication.id,
      revisionId: revision.id,
    }),
    body: ({ targetValidFrom, targetValidUntil }) => ({
      validFrom: targetValidFrom.toISOString(),
      validUntil: targetValidUntil.toISOString(),
      timesOfDay: ["09:00"],
    }),
    ok: 200,
    auditAction: "medication.schedule_revision.updated",
    applied: async ({ revision, targetValidFrom }) =>
      (
        await getPrismaClient().medicationScheduleRevision.findUnique({
          where: { id: revision.id },
        })
      )?.validFrom.toISOString() === targetValidFrom.toISOString(),
  },
);

proveManageRoute(
  "DELETE /api/medications/[id]/schedule-revisions/[revisionId]",
  {
    route: "/api/medications/[id]/schedule-revisions/[revisionId]",
    action: "DELETE",
    prepare: async (ownerId) => ({
      ownerId,
      ...(await makeScheduleRevision(ownerId)),
    }),
    params: ({ medication, revision }) => ({
      id: medication.id,
      revisionId: revision.id,
    }),
    ok: 200,
    auditAction: "medication.schedule_revision.deleted",
    applied: async ({ revision }) =>
      (await getPrismaClient().medicationScheduleRevision.findUnique({
        where: { id: revision.id },
      })) === null,
  },
);

proveManageRoute("POST /api/medications/[id]/inventory", {
  route: "/api/medications/[id]/inventory",
  prepare: async (ownerId) => ({
    ownerId,
    medication: await makeMedication(ownerId),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  body: () => ({ unitsTotal: 20, containerType: "BOTTLE" }),
  ok: 201,
  auditAction: "medication.inventory.create",
  applied: async ({ medication }) =>
    (await getPrismaClient().medicationInventoryItem.count({
      where: { medicationId: medication.id },
    })) === 1,
});

proveManageRoute("PATCH /api/medications/[id]/inventory/[itemId]", {
  route: "/api/medications/[id]/inventory/[itemId]",
  action: "PATCH",
  prepare: async (ownerId) => ({
    ownerId,
    ...(await makeInventoryItem(ownerId)),
  }),
  params: ({ medication, item }) => ({ id: medication.id, itemId: item.id }),
  body: () => ({ unitsRemaining: 15 }),
  ok: 200,
  auditAction: "medication.inventory.update",
  applied: async ({ item }) =>
    Number(
      (
        await getPrismaClient().medicationInventoryItem.findUnique({
          where: { id: item.id },
        })
      )?.unitsRemaining,
    ) === 15,
});

proveManageRoute("DELETE /api/medications/[id]/inventory/[itemId]", {
  route: "/api/medications/[id]/inventory/[itemId]",
  action: "DELETE",
  prepare: async (ownerId) => ({
    ownerId,
    ...(await makeInventoryItem(ownerId)),
  }),
  params: ({ medication, item }) => ({ id: medication.id, itemId: item.id }),
  ok: 200,
  auditAction: "medication.inventory.delete",
  applied: async ({ item }) =>
    (await getPrismaClient().medicationInventoryItem.findUnique({
      where: { id: item.id },
    })) === null,
});

proveManageRoute("DELETE /api/medications/[id]/side-effects/[logId]", {
  route: "/api/medications/[id]/side-effects/[logId]",
  action: "DELETE",
  prepare: async (ownerId) => {
    const medication = await makeMedication(ownerId);
    const log = await getPrismaClient().medicationSideEffect.create({
      data: {
        userId: ownerId,
        medicationId: medication.id,
        category: "GI",
        entry: "NAUSEA",
        severity: 3,
      },
    });
    return { ownerId, medication, log };
  },
  params: ({ medication, log }) => ({ id: medication.id, logId: log.id }),
  ok: 200,
  auditAction: "medication.sideEffect.delete",
  applied: async ({ log }) =>
    (await getPrismaClient().medicationSideEffect.findUnique({
      where: { id: log.id },
    })) === null,
});

proveManageRoute("POST /api/medications/[id]/glp1", {
  route: "/api/medications/[id]/glp1",
  prepare: async (ownerId) => ({
    ownerId,
    medication: await getPrismaClient().medication.create({
      data: {
        userId: ownerId,
        name: "Semaglutide",
        dose: "0.25mg",
        treatmentClass: "GLP1",
      },
    }),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  body: () => ({
    doseChange: { effectiveFrom: ISO, doseValue: 0.5, doseUnit: "mg" },
  }),
  ok: 201,
  auditAction: "medication.glp1.update",
  applied: async ({ medication }) =>
    (await getPrismaClient().medicationDoseChange.count({
      where: { medicationId: medication.id },
    })) === 1,
});

proveManageRoute("PUT /api/medications/[id]/intake/[eventId]", {
  route: "/api/medications/[id]/intake/[eventId]",
  action: "PUT",
  prepare: async (ownerId) => ({
    ownerId,
    ...(await makeMedicationIntake(ownerId)),
  }),
  params: ({ medication, event }) => ({ id: medication.id, eventId: event.id }),
  body: () => ({ skipped: true }),
  ok: 200,
  auditAction: "medication.intake.update",
  applied: async ({ event }) =>
    (
      await getPrismaClient().medicationIntakeEvent.findUnique({
        where: { id: event.id },
      })
    )?.skipped === true,
});

proveManageRoute("DELETE /api/medications/[id]/intake/[eventId]", {
  route: "/api/medications/[id]/intake/[eventId]",
  action: "DELETE",
  prepare: async (ownerId) => ({
    ownerId,
    ...(await makeMedicationIntake(ownerId)),
  }),
  params: ({ medication, event }) => ({ id: medication.id, eventId: event.id }),
  ok: 200,
  auditAction: "medication.intake.delete",
  applied: async ({ event }) =>
    (
      await getPrismaClient().medicationIntakeEvent.findUnique({
        where: { id: event.id },
      })
    )?.deletedAt !== null,
});

proveManageRoute("POST /api/medications/[id]/intake/bulk-delete", {
  route: "/api/medications/[id]/intake/bulk-delete",
  prepare: async (ownerId) => ({
    ownerId,
    ...(await makeMedicationIntake(ownerId)),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  body: ({ event }) => ({ eventIds: [event.id] }),
  ok: 200,
  auditAction: "medication.intake.bulk_delete",
  applied: async ({ event }) =>
    (
      await getPrismaClient().medicationIntakeEvent.findUnique({
        where: { id: event.id },
      })
    )?.deletedAt !== null,
});

proveManageRoute("DELETE /api/medications/[id]/intake/purge", {
  route: "/api/medications/[id]/intake/purge",
  action: "DELETE",
  prepare: async (ownerId) => ({
    ownerId,
    ...(await makeMedicationIntake(ownerId)),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  ok: 200,
  auditAction: "medication.intake.purge",
  applied: async ({ event }) =>
    (
      await getPrismaClient().medicationIntakeEvent.findUnique({
        where: { id: event.id },
      })
    )?.deletedAt !== null,
});

proveManageRoute("POST /api/medications/[id]/intake/import", {
  route: "/api/medications/[id]/intake/import",
  prepare: async (ownerId) => ({
    ownerId,
    medication: await makeMedication(ownerId),
  }),
  params: ({ medication }) => ({ id: medication.id }),
  body: () => [{ datum: "2026-07-15", uhrzeit: "08:00:00" }],
  ok: 202,
  auditAction: "medication.intake.import.kickoff",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().medicationIntakeImportJob.count({
      where: { recordUserId: ownerId },
    })) === 1,
});

manageContract("POST /api/medications/intake/dose-history-import", {
  contract: admittedContract("/api/medications/intake/dose-history-import"),
  prepare: async (ownerId) => ({
    ownerId,
    medication: await makeMedication(ownerId, "Metformin"),
  }),
  act: async () => {
    const handler = await matrixHandler(
      admittedContract("/api/medications/intake/dose-history-import"),
    );
    const csv = [
      "Date,Scheduled Date,Medication,Nickname,Dosage,Scheduled Dosage,Unit,Status,Archived,Codings",
      "2026-07-15 08:00:00 +0000,2026-07-15 08:00:00 +0000,Metformin,Metformin,500,500,mg,Taken,No,",
    ].join("\n");
    return handler(
      new NextRequest(
        "http://localhost/api/medications/intake/dose-history-import",
        {
          method: "POST",
          headers: { "content-type": "text/csv" },
          body: csv,
        },
      ),
      { params: Promise.resolve({}) },
    );
  },
  ok: 202,
  auditAction: "medication.intake.history.import.kickoff",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().medicationIntakeImportJob.count({
      where: { recordUserId: ownerId },
    })) === 1,
});

/* -------------------------------------------------------------------------- */
/* 1d — mood entries and validated mental-health assessments                 */
/* -------------------------------------------------------------------------- */

async function makeMoodEntry(userId: string) {
  return getPrismaClient().moodEntry.create({
    data: {
      userId,
      date: "2026-07-15",
      mood: "GUT",
      score: 4,
      moodLoggedAt: new Date(ISO),
      source: "MANUAL",
    },
  });
}

proveManageRoute("POST /api/mood-entries", {
  route: "/api/mood-entries",
  prepare: async (ownerId) => ({ ownerId }),
  body: () => ({ mood: "GUT", moodLoggedAt: ISO }),
  ok: 201,
  auditAction: "moodEntry.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().moodEntry.count({
      where: { userId: ownerId },
    })) === 1,
});

proveManageRoute("PUT /api/mood-entries/[id]", {
  route: "/api/mood-entries/[id]",
  action: "PUT",
  prepare: (ownerId) => makeMoodEntry(ownerId),
  params: (entry) => ({ id: entry.id }),
  body: () => ({ mood: "OKAY" }),
  ok: 200,
  auditAction: "moodEntry.update",
  applied: async (entry) =>
    (await getPrismaClient().moodEntry.findUnique({ where: { id: entry.id } }))
      ?.mood === "OKAY",
});

proveManageRoute("DELETE /api/mood-entries/[id]", {
  route: "/api/mood-entries/[id]",
  action: "DELETE",
  prepare: (ownerId) => makeMoodEntry(ownerId),
  params: (entry) => ({ id: entry.id }),
  ok: 200,
  auditAction: "moodEntry.delete",
  applied: async (entry) =>
    (await getPrismaClient().moodEntry.findUnique({ where: { id: entry.id } }))
      ?.deletedAt !== null,
});

proveManageRoute("POST /api/mood-entries/bulk-delete", {
  route: "/api/mood-entries/bulk-delete",
  prepare: (ownerId) => makeMoodEntry(ownerId),
  body: (entry) => ({ ids: [entry.id] }),
  ok: 200,
  auditAction: "mood.delete.bulk",
  applied: async (entry) =>
    (await getPrismaClient().moodEntry.findUnique({ where: { id: entry.id } }))
      ?.deletedAt !== null,
});

proveManageRoute("POST /api/mood-entries/restore", {
  route: "/api/mood-entries/restore",
  prepare: async (ownerId) => {
    const entry = await makeMoodEntry(ownerId);
    return getPrismaClient().moodEntry.update({
      where: { id: entry.id },
      data: { deletedAt: new Date() },
    });
  },
  body: (entry) => ({ ids: [entry.id] }),
  ok: 200,
  auditAction: "mood.restore",
  applied: async (entry) =>
    (await getPrismaClient().moodEntry.findUnique({ where: { id: entry.id } }))
      ?.deletedAt === null,
});

proveManageRoute("POST /api/mental-health/assessments", {
  route: "/api/mental-health/assessments",
  prepare: async (ownerId) => ({ ownerId }),
  body: () => ({
    instrument: "PHQ9",
    items: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    takenAt: ISO,
  }),
  ok: 201,
  auditAction: "mental-health.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().mentalHealthAssessment.count({
      where: { userId: ownerId },
    })) === 1,
});

/* -------------------------------------------------------------------------- */
/* 1e — cycle and record-wide mutations                                      */
/* -------------------------------------------------------------------------- */

async function enableCycle(userId: string) {
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { gender: "FEMALE" },
  });
  return userId;
}

async function makeCycleDayLog(userId: string) {
  await enableCycle(userId);
  return getPrismaClient().cycleDayLog.create({
    data: {
      userId,
      date: "2026-07-15",
      source: "MANUAL",
    },
  });
}

proveManageRoute("DELETE /api/cycle/cycles/[id]", {
  route: "/api/cycle/cycles/[id]",
  action: "DELETE",
  prepare: async (ownerId) => {
    await enableCycle(ownerId);
    return getPrismaClient().menstrualCycle.create({
      data: { userId: ownerId, startDate: "2026-07-01" },
    });
  },
  params: (cycle) => ({ id: cycle.id }),
  ok: 204,
  auditAction: "cycle.cycle.delete",
  applied: async (cycle) =>
    (
      await getPrismaClient().menstrualCycle.findUnique({
        where: { id: cycle.id },
      })
    )?.deletedAt !== null,
});

proveManageRoute("POST /api/cycle/day-logs", {
  route: "/api/cycle/day-logs",
  prepare: async (ownerId) => ({ ownerId: await enableCycle(ownerId) }),
  body: () => ({ date: "2026-07-15", loggedAt: ISO, flow: "LIGHT" }),
  ok: 201,
  auditAction: "cycle.day-log.upsert",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().cycleDayLog.count({
      where: { userId: ownerId, date: "2026-07-15" },
    })) === 1,
});

proveManageRoute("PATCH /api/cycle/day-logs/[id]", {
  route: "/api/cycle/day-logs/[id]",
  action: "PATCH",
  prepare: (ownerId) => makeCycleDayLog(ownerId),
  params: (row) => ({ id: row.id }),
  body: () => ({ flow: "HEAVY" }),
  ok: 200,
  auditAction: "cycle.day-log.update",
  applied: async (row) =>
    (await getPrismaClient().cycleDayLog.findUnique({ where: { id: row.id } }))
      ?.flow === "HEAVY",
});

proveManageRoute("DELETE /api/cycle/day-logs/[id]", {
  route: "/api/cycle/day-logs/[id]",
  action: "DELETE",
  prepare: (ownerId) => makeCycleDayLog(ownerId),
  params: (row) => ({ id: row.id }),
  ok: 204,
  auditAction: "cycle.day-log.delete",
  applied: async (row) =>
    (await getPrismaClient().cycleDayLog.findUnique({ where: { id: row.id } }))
      ?.deletedAt !== null,
});

proveManageRoute("POST /api/cycle/period", {
  route: "/api/cycle/period",
  prepare: async (ownerId) => ({ ownerId: await enableCycle(ownerId) }),
  body: () => ({ action: "start", date: "2026-07-15", loggedAt: ISO }),
  ok: 200,
  auditAction: "cycle.period.boundary",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().menstrualCycle.count({
      where: { userId: ownerId, startDate: "2026-07-15" },
    })) === 1,
});

proveManageRoute("POST /api/cycle/symptoms/custom", {
  route: "/api/cycle/symptoms/custom",
  prepare: async (ownerId) => ({ ownerId: await enableCycle(ownerId) }),
  body: () => ({ label: "Pelvic pressure" }),
  ok: 201,
  auditAction: "cycle.symptom.custom.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().cycleSymptom.count({
      where: { userId: ownerId },
    })) === 1,
});

proveManageRoute("POST /api/medications/categories", {
  route: "/api/medications/categories",
  prepare: async (ownerId) => ({ ownerId }),
  body: () => ({ label: "Travel kit" }),
  ok: 201,
  auditAction: "medication.category.custom.create",
  applied: async ({ ownerId }) =>
    (await getPrismaClient().medicationCategoryLabel.count({
      where: { userId: ownerId },
    })) === 1,
});

proveManageRoute("POST /api/nutrients/water", {
  route: "/api/nutrients/water",
  prepare: async (ownerId) => {
    await getPrismaClient().user.update({
      where: { id: ownerId },
      data: { modulePreferencesJson: { nutrients: true } },
    });
    return { ownerId };
  },
  body: () => ({ amountMl: 250, mode: "set", day: "2026-07-15" }),
  ok: 200,
  auditAction: "nutrient.water.write",
  applied: async ({ ownerId }) =>
    (
      await getPrismaClient().nutrientIntakeDay.findFirst({
        where: {
          userId: ownerId,
          day: "2026-07-15",
          nutrient: "water",
          source: "MANUAL",
        },
      })
    )?.amount === 250,
});

proveManageRoute("PATCH /api/insights/patterns/[id]", {
  route: "/api/insights/patterns/[id]",
  action: "PATCH",
  prepare: async (ownerId) =>
    getPrismaClient().correlationPattern.create({
      data: {
        userId: ownerId,
        canonicalKey: "mood:water",
        family: "mood",
        factorKey: "water",
        outcomeKey: "mood",
        lagDays: 0,
        sampleSize: 12,
        effectSize: 0.3,
        pValue: 0.01,
        evidenceHash: "evidence-v1",
        lastComputedAt: new Date(ISO),
      },
    }),
  params: (pattern) => ({ id: pattern.id }),
  body: () => ({ dismissed: true }),
  ok: 200,
  auditAction: "correlationPattern.dismiss",
  applied: async (pattern) =>
    (
      await getPrismaClient().correlationPattern.findUnique({
        where: { id: pattern.id },
      })
    )?.dismissedAt !== null,
});

proveManageRoute("POST /api/export/health-record", {
  route: "/api/export/health-record",
  prepare: async (ownerId) => ({ ownerId }),
  body: () => ({ format: "fhir", selection: { v: 2, leaves: ["MOOD"] } }),
  ok: 200,
  auditAction: "health-record.export",
  applied: async ({ ownerId }) => {
    const row = await getPrismaClient().auditLog.findFirst({
      where: { userId: ownerId, action: "health-record.export" },
    });
    return row !== null;
  },
});

/* -------------------------------------------------------------------------- */
/* 2 — reconstructable or refused                                             */
/* -------------------------------------------------------------------------- */

describe("what a destruction leaves behind", () => {
  it("[J2-manage-edits-without-settings] C3: a hard delete files what it destroyed, and never the encrypted text", async () => {
    // The preventive-care reminder is the sharpest case in the tree: the row
    // is gone, no restore route reaches it, and the audit row used to say
    // `{ reminderId }` — a pointer at nothing. An owner reading their feed
    // could see that a recall disappeared and never learn what it was for.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const reminder = await makeReminder(owner.id);

    await switchInto(owner.id, manager.id, "MANAGE");
    const { DELETE } =
      await import("@/app/api/measurement-reminders/[id]/route");
    expect(
      (
        await call(
          DELETE as Handler,
          "DELETE",
          `/api/measurement-reminders/${reminder.id}`,
          undefined,
          { id: reminder.id },
        )
      ).status,
    ).toBe(200);

    const { details } = await auditRow("measurementReminder.delete");
    expect(details.destroyedModel).toBe("MeasurementReminder");
    expect(details.destroyedId).toBe(reminder.id);
    expect(details.destroyedLabel).toBe("Colonoscopy recall");
    expect(details.destroyedAt).toBe(reminder.nextDueAt?.toISOString());
    expect(details.intervalDays).toBe(365);
  });

  it("C3: the allergy delete carries the allergen and never the reaction", async () => {
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const allergy = await getPrismaClient().allergy.create({
      data: {
        userId: owner.id,
        substance: "Penicillin",
        category: "MEDICATION",
        type: "ALLERGY",
        severity: "SEVERE",
        status: "ACTIVE",
        onsetAt: new Date("2020-03-01T00:00:00.000Z"),
      },
    });

    await switchInto(owner.id, manager.id, "MANAGE");
    const { DELETE } = await import("@/app/api/allergies/[id]/route");
    expect(
      (
        await call(
          DELETE as Handler,
          "DELETE",
          `/api/allergies/${allergy.id}`,
          undefined,
          { id: allergy.id },
        )
      ).status,
    ).toBe(200);

    const { row, details } = await auditRow("allergy.delete");
    expect(details.destroyedLabel).toBe("Penicillin");
    expect(details.severity).toBe("SEVERE");
    expect(details.destroyedAt).toBe("2020-03-01T00:00:00.000Z");
    // …and the audit table did not become a second store for the encrypted
    // half of the row. Asserted on the raw string, because a nested key would
    // slip past a top-level property check.
    expect(row.details ?? "").not.toContain("reaction");
  });

  it("[J2-manage-edits-without-settings] C4: an edit files the field family and the value that is gone", async () => {
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const measurement = await makeMeasurement(owner.id, 80);

    await switchInto(owner.id, manager.id, "MANAGE");
    const { PUT } = await import("@/app/api/measurements/[id]/route");
    expect(
      (
        await call(
          PUT as Handler,
          "PUT",
          `/api/measurements/${measurement.id}`,
          { value: 74.5 },
          { id: measurement.id },
        )
      ).status,
    ).toBe(200);

    const { details } = await auditRow("measurement.update");
    expect(details.fields).toEqual(["value"]);
    expect((details.previous as Record<string, unknown>).value).toBe(80);
  });

  it("a restore puts back the row it names, and leaves the others tombstoned", async () => {
    // The fake-that-ignores-its-`where` case: a count check passes on a
    // restore that clears every tombstone in the record. The id is what
    // defeats it.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const kept = await makeMeasurement(owner.id, 81);
    const other = await makeMeasurement(owner.id, 82);
    await getPrismaClient().measurement.updateMany({
      where: { id: { in: [kept.id, other.id] } },
      data: { deletedAt: new Date() },
    });

    await switchInto(owner.id, manager.id, "MANAGE");
    const { POST } = await import("@/app/api/measurements/restore/route");
    const response = await call(
      POST as Handler,
      "POST",
      "/api/measurements/restore",
      {
        ids: [kept.id],
      },
    );
    expect(response.status).toBe(200);

    const restored = await getPrismaClient().measurement.findUnique({
      where: { id: kept.id },
    });
    const untouched = await getPrismaClient().measurement.findUnique({
      where: { id: other.id },
    });
    expect(restored?.deletedAt).toBeNull();
    expect(untouched?.deletedAt).not.toBeNull();

    const { row } = await auditRow("measurement.restore");
    expect(row.userId).toBe(owner.id);
    expect(row.actorUserId).toBe(manager.id);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — the conditions that are not about the audit row                        */
/* -------------------------------------------------------------------------- */

describe("the conditions the admissions were granted on", () => {
  it("C1: the manager burns their own rate allowance, not the owner's", async () => {
    // The buckets live in Postgres, so the key itself is readable. A bucket
    // keyed on the record would let a manager lock the owner out of their own
    // restore button by hammering it.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const row = await makeMeasurement(owner.id);
    await getPrismaClient().measurement.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });

    await switchInto(owner.id, manager.id, "MANAGE");
    const { POST } = await import("@/app/api/measurements/restore/route");
    expect(
      (
        await call(POST as Handler, "POST", "/api/measurements/restore", {
          ids: [row.id],
        })
      ).status,
    ).toBe(200);

    const buckets = await getPrismaClient().rateLimit.findMany();
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => b.key.includes(manager.id))).toBe(true);
    expect(buckets.some((b) => b.key.includes(owner.id))).toBe(false);
  });

  it("C5: a manager's navigation enqueues no generation; the owner's does", async () => {
    // Both halves, and the second is what makes the first mean anything: the
    // narrative route warms unconditionally, so a zero on the delegated side
    // could just as easily mean the route never reached the enqueue at all.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const { GET } = await import("@/app/api/insights/narrative/route");

    await signIn(owner.id);
    expect(
      (await call(GET as Handler, "GET", "/api/insights/narrative?period=week"))
        .status,
    ).toBe(200);
    expect(enqueueNarrativeWarm).toHaveBeenCalledTimes(1);

    enqueueNarrativeWarm.mockClear();

    await switchInto(owner.id, manager.id, "MANAGE");
    const delegated = await call(
      GET as Handler,
      "GET",
      "/api/insights/narrative?period=week",
    );
    expect(delegated.status).toBe(200);
    expect(enqueueNarrativeWarm).not.toHaveBeenCalled();
  });

  it("C5: a WRITE grant cannot read the generated surfaces at all", async () => {
    const owner = await makeUser("owner");
    const helper = await makeUser("helper");
    await switchInto(owner.id, helper.id, "WRITE");

    const { GET } = await import("@/app/api/insights/narrative/route");
    await expectDenied(
      await call(GET as Handler, "GET", "/api/insights/narrative?period=week"),
    );
    expect(enqueueNarrativeWarm).not.toHaveBeenCalled();
  });

  it("C6: the delegated mood create refuses the sync client's externalId", async () => {
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const body = {
      mood: "GUT",
      moodLoggedAt: ISO,
      // A stable, device-shaped id: the floor on `externalId` refuses an
      // unstable one at the schema, and this test is about the level, not
      // about that floor.
      externalId: "8B0F3C2E-1D4A-4F5B-9C6D-7E8F90A1B2C3",
      source: "MOODLOG",
    };

    await switchInto(owner.id, manager.id, "MANAGE");
    const { POST } = await import("@/app/api/mood-entries/route");
    const refused = await call(
      POST as Handler,
      "POST",
      "/api/mood-entries",
      body,
    );
    expect(refused.status).toBe(422);
    expect((await payload(refused)).meta?.errorCode).toBe(
      "mood.create.external_id_not_delegable",
    );
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: owner.id } }),
    ).toBe(0);

    // The same body from the owner's own session still lands: C6 closes the
    // delegated branch, not the route.
    await signIn(owner.id);
    const accepted = await call(
      POST as Handler,
      "POST",
      "/api/mood-entries",
      body,
    );
    expect(accepted.status).toBe(201);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: owner.id } }),
    ).toBe(1);
  });
});

describe("the complete MANAGE handler matrix", () => {
  it("registers one strict actor-and-effect driver for every admission", () => {
    const expected = ADMITTED_MUTATING_HANDLERS.map(matrixKey).sort();
    expect(STRICT_DRIVER_KEYS.size).toBe(84);
    expect([...STRICT_DRIVER_KEYS].sort()).toEqual(expected);
  });

  it("executes every registered driver through its owned effect and actor audit", () => {
    const expected = ADMITTED_MUTATING_HANDLERS.map(matrixKey).sort();
    expect(REAL_EFFECT_KEYS.size).toBe(84);
    expect([...REAL_EFFECT_KEYS].sort()).toEqual(expected);
  });
});
