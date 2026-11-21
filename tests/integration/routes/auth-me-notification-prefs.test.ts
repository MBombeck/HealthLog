/**
 * `/api/auth/me/notification-prefs` — the per-account notification
 * preferences, against the real database and through the real API kit.
 *
 * Pinned here:
 *   - the read resolves a null row, a partial row and a drifted row (an
 *     unknown category) to the documented full shape, with the row's
 *     concurrency token;
 *   - the write deep-merges the sent categories over the stored ones, stores
 *     the full resolved shape, answers it with the advanced token, and audits
 *     previous, next and the categories the body named;
 *   - an empty body leaves the preferences as they were and still writes;
 *   - a body that is not JSON is 400 `notification-prefs.body.invalid_json`,
 *     an out-of-range or mistyped value is 422, and neither touches the row;
 *   - a write carrying a stale base token is 409 `notification_prefs_conflict`
 *     and does not revert a flag another client set; the same write without
 *     a token lands, last write wins; a malformed token is 422;
 *   - the write bucket allows 60 a minute per account.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET, PATCH } from "@/app/api/auth/me/notification-prefs/route";
import type { Prisma } from "@/generated/prisma/client";

import { anonymous, callRoute } from "../../kit/call-route";
import {
  makeSession,
  makeUser,
  type SessionFixture,
} from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();
const ROUTE = "/api/auth/me/notification-prefs";

const DEFAULTS = {
  medication: {
    clientManaged: false,
    deliveryDefault: "server",
    lowStockRunwayDays: 7,
    reorderLeadDays: 10,
    snoozeMinutes: 30,
  },
  mood: { reminderHour: 22 },
  cycle: { clientManaged: false },
  coach: {
    nudgesEnabled: true,
    nudgeMedication: true,
    nudgeVitals: true,
    nudgeRoutine: true,
    nudgeFrequency: "weekly",
    nudgeAiComposed: false,
  },
  measurementReminder: { clientManaged: false },
  content: { detail: "generic" },
} as const;

type Prefs = {
  medication: {
    clientManaged: boolean;
    deliveryDefault: string;
    lowStockRunwayDays: number | null;
    reorderLeadDays: number;
    snoozeMinutes: number;
  };
  mood: { reminderHour: number };
  content: { detail: string };
  updatedAt?: string;
} & Record<string, unknown>;

beforeEach(() => truncateAllTables(prisma));

async function stored(userId: string): Promise<unknown> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  return row.notificationPrefs;
}

async function storedUpdatedAt(userId: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { updatedAt: true },
  });
  return row.updatedAt.toISOString();
}

function userWithPrefs(prefs?: Prisma.InputJsonValue) {
  return makeUser(prefs === undefined ? {} : { notificationPrefs: prefs });
}

function read(auth: SessionFixture) {
  return callRoute<Prefs>(GET, { method: "GET", route: ROUTE, auth });
}

function patch(auth: SessionFixture, body: unknown) {
  return callRoute<Prefs>(PATCH, {
    method: "PATCH",
    route: ROUTE,
    body,
    auth,
  });
}

describe("GET /api/auth/me/notification-prefs", () => {
  it("refuses an anonymous caller with 401", async () => {
    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      auth: anonymous,
    });
    expect(res.status).toBe(401);
    expect(res.meta?.errorCode).toBe("auth.missing");
  });

  it("answers the documented defaults for an account with no stored prefs", async () => {
    const user = await userWithPrefs();
    const res = await read(await makeSession(user));
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      ...DEFAULTS,
      updatedAt: await storedUpdatedAt(user.id),
    });
  });

  it("answers a stored value resolved over the defaults", async () => {
    const user = await userWithPrefs({ medication: { clientManaged: true } });
    const res = await read(await makeSession(user));
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      ...DEFAULTS,
      medication: { ...DEFAULTS.medication, clientManaged: true },
      updatedAt: await storedUpdatedAt(user.id),
    });
  });

  it("answers the defaults when the stored shape has drifted", async () => {
    // An operator hand-edit or a future rename must not break the read.
    const user = await userWithPrefs({ unknownCategory: { foo: "bar" } });
    const res = await read(await makeSession(user));
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      ...DEFAULTS,
      updatedAt: await storedUpdatedAt(user.id),
    });
  });
});

describe("PATCH /api/auth/me/notification-prefs", () => {
  it("refuses an anonymous caller with 401", async () => {
    const res = await callRoute(PATCH, {
      method: "PATCH",
      route: ROUTE,
      body: { medication: { clientManaged: true } },
      auth: anonymous,
    });
    expect(res.status).toBe(401);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("turns medication.clientManaged on, stores the full shape and audits the change", async () => {
    const user = await userWithPrefs();
    const res = await patch(await makeSession(user), {
      medication: { clientManaged: true },
    });

    const next = {
      ...DEFAULTS,
      medication: { ...DEFAULTS.medication, clientManaged: true },
    };
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      ...next,
      updatedAt: await storedUpdatedAt(user.id),
    });
    expect(await stored(user.id)).toEqual(next);

    const audit = await prisma.auditLog.findMany({
      where: { userId: user.id, action: "user.notification-prefs.update" },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details ?? "null")).toEqual({
      previous: DEFAULTS,
      next,
      changed: ["medication"],
    });
  });

  it("deep-merges over the stored categories without overwriting them", async () => {
    const user = await userWithPrefs({
      medication: { clientManaged: false, lowStockRunwayDays: 21 },
      mood: { reminderHour: 7 },
    });
    const res = await patch(await makeSession(user), {
      medication: { clientManaged: true },
    });
    expect(res.status).toBe(200);
    expect(await stored(user.id)).toEqual({
      ...DEFAULTS,
      medication: {
        ...DEFAULTS.medication,
        clientManaged: true,
        lowStockRunwayDays: 21,
      },
      mood: { reminderHour: 7 },
    });
  });

  it("leaves the preferences as they were on an empty body and still writes", async () => {
    const user = await userWithPrefs({ medication: { clientManaged: true } });
    const res = await patch(await makeSession(user), {});
    const same = {
      ...DEFAULTS,
      medication: { ...DEFAULTS.medication, clientManaged: true },
    };
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      ...same,
      updatedAt: await storedUpdatedAt(user.id),
    });
    // The resolved full shape replaces the partial row.
    expect(await stored(user.id)).toEqual(same);
    const audit = await prisma.auditLog.findMany({
      where: { userId: user.id, action: "user.notification-prefs.update" },
    });
    expect(JSON.parse(audit[0]?.details ?? "null")).toMatchObject({
      changed: [],
    });
  });

  it("stores a custom mood.reminderHour", async () => {
    const user = await userWithPrefs();
    const res = await patch(await makeSession(user), {
      mood: { reminderHour: 9 },
    });
    expect(res.status).toBe(200);
    expect(res.data.mood).toEqual({ reminderHour: 9 });
    expect(await stored(user.id)).toEqual({
      ...DEFAULTS,
      mood: { reminderHour: 9 },
    });
  });

  it("stores medication.snoozeMinutes beside the other medication prefs", async () => {
    const user = await userWithPrefs({ medication: { clientManaged: true } });
    const res = await patch(await makeSession(user), {
      medication: { snoozeMinutes: 45 },
    });
    expect(res.status).toBe(200);
    expect(res.data.medication).toEqual({
      ...DEFAULTS.medication,
      clientManaged: true,
      snoozeMinutes: 45,
    });
  });

  it("stores content.detail and keeps the siblings", async () => {
    const user = await userWithPrefs({ mood: { reminderHour: 7 } });
    const res = await patch(await makeSession(user), {
      content: { detail: "detailed" },
    });
    expect(res.status).toBe(200);
    expect(res.data.content).toEqual({ detail: "detailed" });
    expect(res.data.mood).toEqual({ reminderHour: 7 });
    expect(await stored(user.id)).toEqual({
      ...DEFAULTS,
      mood: { reminderHour: 7 },
      content: { detail: "detailed" },
    });
  });

  it("stores a custom lowStockRunwayDays", async () => {
    const user = await userWithPrefs();
    const res = await patch(await makeSession(user), {
      medication: { lowStockRunwayDays: 14 },
    });
    expect(res.status).toBe(200);
    expect(res.data.medication.lowStockRunwayDays).toBe(14);
    expect(await stored(user.id)).toMatchObject({
      medication: { ...DEFAULTS.medication, lowStockRunwayDays: 14 },
    });
  });

  it("stores the explicit null that turns the low-stock alert off", async () => {
    const user = await userWithPrefs({
      medication: { lowStockRunwayDays: 14 },
    });
    const session = await makeSession(user);
    const res = await patch(session, {
      medication: { lowStockRunwayDays: null },
    });
    expect(res.status).toBe(200);
    expect(res.data.medication.lowStockRunwayDays).toBeNull();
    expect(await stored(user.id)).toMatchObject({
      medication: { lowStockRunwayDays: null },
    });
    // And the null survives the read, rather than falling back to 7.
    expect((await read(session)).data.medication.lowStockRunwayDays).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a non-boolean clientManaged", { medication: { clientManaged: "yes" } }],
    ["an unknown content.detail", { content: { detail: "everything" } }],
    ["a mood.reminderHour of 24", { mood: { reminderHour: 24 } }],
    ["a lowStockRunwayDays of 0", { medication: { lowStockRunwayDays: 0 } }],
    ["a lowStockRunwayDays of 61", { medication: { lowStockRunwayDays: 61 } }],
    ["a snoozeMinutes of 4", { medication: { snoozeMinutes: 4 } }],
    ["a snoozeMinutes of 241", { medication: { snoozeMinutes: 241 } }],
  ])("refuses %s with 422 and stores nothing", async (_, body) => {
    const user = await userWithPrefs();
    const res = await patch(await makeSession(user), body);
    expect(res.status).toBe(422);
    expect(await stored(user.id)).toBeNull();
  });

  it("refuses a body that is not JSON with 400 and its error code", async () => {
    const user = await userWithPrefs();
    // The kit serialises every body as JSON, so the unparseable body here is
    // the empty one, sent with a JSON content type.
    const res = await callRoute(PATCH, {
      method: "PATCH",
      route: ROUTE,
      headers: { "content-type": "application/json" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(400);
    expect(res.error).toBe("Invalid JSON body");
    expect(res.meta?.errorCode).toBe("notification-prefs.body.invalid_json");
    expect(await stored(user.id)).toBeNull();
  });

  it("allows 60 writes a minute per account and refuses the 61st with 429", async () => {
    const user = await userWithPrefs();
    const session = await makeSession(user);
    for (let hour = 0; hour < 60; hour++) {
      const ok = await patch(session, { mood: { reminderHour: hour % 24 } });
      expect(ok.status).toBe(200);
    }
    // The 60th write set 59 % 24 = 11.
    const refused = await patch(session, { mood: { reminderHour: 3 } });
    expect(refused.status).toBe(429);
    expect(await stored(user.id)).toMatchObject({ mood: { reminderHour: 11 } });
  });
});

/**
 * A write carrying the `baseUpdatedAt` it was based on lands only while the
 * stored row still carries that token. The case it exists for: a web write
 * of one category, based on a read taken before the native client set
 * `medication.clientManaged`, used to revert the flag (double reminders).
 */
describe("PATCH /api/auth/me/notification-prefs optimistic concurrency", () => {
  it("writes on a matching token and answers the advanced one", async () => {
    const user = await userWithPrefs();
    const session = await makeSession(user);
    const base = (await read(session)).data.updatedAt;

    const res = await patch(session, {
      medication: { clientManaged: true },
      baseUpdatedAt: base,
    });
    expect(res.status).toBe(200);
    const after = await storedUpdatedAt(user.id);
    expect(after).not.toBe(base);
    expect(res.data.updatedAt).toBe(after);
    expect(await stored(user.id)).toMatchObject({
      medication: { clientManaged: true },
    });
  });

  it("refuses a stale web write with 409 and keeps the flag the native client set", async () => {
    const user = await userWithPrefs();
    const web = await makeSession(user);
    const staleBase = (await read(web)).data.updatedAt;

    const native = await patch(await makeSession(user), {
      medication: { clientManaged: true },
    });
    expect(native.status).toBe(200);

    const res = await patch(web, {
      mood: { reminderHour: 9 },
      baseUpdatedAt: staleBase,
    });
    expect(res.status).toBe(409);
    expect(res.data).toBeNull();
    expect(res.meta?.errorCode).toBe("notification_prefs_conflict");
    expect(await stored(user.id)).toEqual({
      ...DEFAULTS,
      medication: { ...DEFAULTS.medication, clientManaged: true },
    });
  });

  it("lets the same write land without a token: old clients keep last write wins", async () => {
    // Deliberate: a tokenless client keeps the pre-guard race. Its write of
    // one category merges over the row, so here it does not lose the flag.
    const user = await userWithPrefs({ medication: { clientManaged: true } });
    const res = await patch(await makeSession(user), {
      mood: { reminderHour: 9 },
    });
    expect(res.status).toBe(200);
    expect(await stored(user.id)).toEqual({
      ...DEFAULTS,
      medication: { ...DEFAULTS.medication, clientManaged: true },
      mood: { reminderHour: 9 },
    });
  });

  it("refuses a malformed token with 422 without touching the row", async () => {
    const user = await userWithPrefs();
    const before = await storedUpdatedAt(user.id);
    const res = await patch(await makeSession(user), {
      medication: { clientManaged: true },
      baseUpdatedAt: "not-a-date",
    });
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(await stored(user.id)).toBeNull();
    expect(await storedUpdatedAt(user.id)).toBe(before);
  });
});
