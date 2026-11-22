/**
 * `/api/auth/me/modules` — the per-account module switches, against the real
 * database and through the real API kit.
 *
 * Pinned here:
 *   - the read resolves every toggleable module on for a fresh account, a
 *     stored `false` off, and the delegated modules from their real source
 *     (cycle from gender and the cycle profile, coach from the operator's
 *     switch);
 *   - the write merges the sent keys into the stored DISABLED allowlist key
 *     by key, drops junk a corrupted row carried, can turn a module back on,
 *     and audits which keys changed;
 *   - a core domain, an unknown key or a non-boolean value is a 422, a body
 *     that is not JSON a 400 with `modules.body.invalid_json`, and none of
 *     them touch the row;
 *   - a write evicts the account's cached score, and a refused write does
 *     not;
 *   - the optimistic-concurrency token is stripped before the strict parse,
 *     a stale one answers 409 `modules_conflict` and writes nothing, a
 *     malformed one 422 `invalid_base_updated_at`;
 *   - the write bucket allows 60 a minute per account.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET, PATCH } from "@/app/api/auth/me/modules/route";
import { caches } from "@/lib/cache/server-cache";

import { anonymous, callRoute } from "../../kit/call-route";
import { makeSession, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();
const ROUTE = "/api/auth/me/modules";

type ModulesResponse = {
  modules: Record<string, boolean>;
  updatedAt?: string;
};

beforeEach(() => truncateAllTables(prisma));

async function storedPrefs(userId: string): Promise<unknown> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { modulePreferencesJson: true },
  });
  return row.modulePreferencesJson;
}

async function storedUpdatedAt(userId: string): Promise<Date> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { modulePreferencesRevisedAt: true },
  });
  return row.modulePreferencesRevisedAt;
}

async function patch(
  auth: Awaited<ReturnType<typeof makeSession>>,
  body: Record<string, unknown>,
) {
  return callRoute<ModulesResponse>(PATCH, {
    method: "PATCH",
    route: ROUTE,
    body,
    auth,
  });
}

describe("GET /api/auth/me/modules", () => {
  it("refuses an anonymous caller with 401", async () => {
    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      auth: anonymous,
    });
    expect(res.status).toBe(401);
    expect(res.meta?.errorCode).toBe("auth.missing");
  });

  it("answers every toggleable module on for a fresh account, with its token", async () => {
    const user = await makeUser({ gender: null });
    const res = await callRoute<ModulesResponse>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.modules.mood).toBe(true);
    expect(res.data.modules.sleep).toBe(true);
    expect(res.data.modules.insights).toBe(true);
    // cycle derives from gender (unknown means off); coach follows the
    // operator switch, on by default.
    expect(res.data.modules.cycle).toBe(false);
    expect(res.data.modules.coach).toBe(true);
    expect(res.data.updatedAt).toBe(
      (await storedUpdatedAt(user.id)).toISOString(),
    );
  });

  it("answers a module off when the stored allowlist says false", async () => {
    const user = await makeUser({ modulePreferencesJson: { glucose: false } });
    const res = await callRoute<ModulesResponse>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(user),
    });
    expect(res.data.modules.glucose).toBe(false);
    expect(res.data.modules.mood).toBe(true);
  });

  it("answers coach off while the operator has the coach switched off", async () => {
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", assistantCoachEnabled: false },
      update: { assistantCoachEnabled: false },
    });
    const user = await makeUser({ disableCoach: false });
    const res = await callRoute<ModulesResponse>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(user),
    });
    expect(res.data.modules.coach).toBe(false);
  });
});

describe("PATCH /api/auth/me/modules", () => {
  it("refuses an anonymous caller with 401 and stores nothing", async () => {
    const res = await callRoute(PATCH, {
      method: "PATCH",
      route: ROUTE,
      body: { mood: false },
      auth: anonymous,
    });
    expect(res.status).toBe(401);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("disables a module, stores the allowlist and audits the changed key", async () => {
    const user = await makeUser();
    const res = await patch(await makeSession(user), { mood: false });

    expect(res.status).toBe(200);
    expect(res.data.modules.mood).toBe(false);
    expect(await storedPrefs(user.id)).toEqual({ mood: false });
    expect(res.data.updatedAt).toBe(
      (await storedUpdatedAt(user.id)).toISOString(),
    );

    const audit = await prisma.auditLog.findMany({
      where: { userId: user.id, action: "user.modules.update" },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details ?? "null")).toEqual({
      changed: ["mood"],
    });
  });

  it("merges over the stored allowlist key by key, siblings intact", async () => {
    const user = await makeUser({ modulePreferencesJson: { glucose: false } });
    const res = await patch(await makeSession(user), { sleep: false });
    expect(res.status).toBe(200);
    expect(await storedPrefs(user.id)).toEqual({
      glucose: false,
      sleep: false,
    });
    expect(res.data.modules.glucose).toBe(false);
    expect(res.data.modules.sleep).toBe(false);
  });

  it("turns a disabled module back on", async () => {
    const user = await makeUser({ modulePreferencesJson: { glucose: false } });
    const res = await patch(await makeSession(user), { glucose: true });
    expect(res.status).toBe(200);
    expect(await storedPrefs(user.id)).toEqual({ glucose: true });
    expect(res.data.modules.glucose).toBe(true);
  });

  it("drops junk a corrupted stored row carried when it merges", async () => {
    const user = await makeUser({
      modulePreferencesJson: { mood: "yes", sleep: false },
    });
    const res = await patch(await makeSession(user), { labs: false });
    expect(res.status).toBe(200);
    expect(await storedPrefs(user.id)).toEqual({ sleep: false, labs: false });
  });

  it("refuses to disable a core domain with 422", async () => {
    const user = await makeUser();
    const session = await makeSession(user);
    // medications is a toggleable module; weight, blood pressure and pulse
    // are the core domains that stay refused.
    for (const core of ["weight", "bloodPressure", "pulse"]) {
      const res = await patch(session, { [core]: false });
      expect(res.status).toBe(422);
      expect(res.meta?.errorCode).toBe("modules.invalid");
    }
    expect(await storedPrefs(user.id)).toBeNull();
  });

  it("refuses an unknown key with 422", async () => {
    const user = await makeUser();
    const res = await patch(await makeSession(user), { notAModule: false });
    expect(res.status).toBe(422);
    expect(await storedPrefs(user.id)).toBeNull();
  });

  it("refuses a non-boolean value with 422", async () => {
    const user = await makeUser();
    const res = await patch(await makeSession(user), { mood: "false" });
    expect(res.status).toBe(422);
    expect(await storedPrefs(user.id)).toBeNull();
  });

  it("refuses a body that is not JSON with 400 and its error code", async () => {
    const user = await makeUser();
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
    expect(res.meta?.errorCode).toBe("modules.body.invalid_json");
    expect(await storedPrefs(user.id)).toBeNull();
  });

  it("allows 60 writes a minute per account and refuses the 61st with 429", async () => {
    const user = await makeUser();
    const session = await makeSession(user);
    for (let i = 0; i < 60; i++) {
      const ok = await patch(session, { mood: i % 2 === 0 });
      expect(ok.status).toBe(200);
    }
    // The 60th write (i = 59) set mood off.
    expect(await storedPrefs(user.id)).toEqual({ mood: false });

    const refused = await patch(session, { mood: true });
    expect(refused.status).toBe(429);
    expect(await storedPrefs(user.id)).toEqual({ mood: false });

    const neighbour = await patch(await makeSession(await makeUser()), {
      mood: false,
    });
    expect(neighbour.status).toBe(200);
  });
});

/**
 * Four of the score's pillars come and go with a module toggle, so a toggle
 * changes what the composite is made of; the cached score has to go.
 */
describe("PATCH /api/auth/me/modules evicts the cached score", () => {
  it("evicts the account's score caches after a toggle lands", async () => {
    const user = await makeUser();
    const other = await makeUser();
    caches.analytics.set(`${user.id}|score`, { score: 71 });
    caches.insightsDerived.set(`${user.id}|derived`, { score: 71 });
    caches.analytics.set(`${other.id}|score`, { score: 64 });

    const res = await patch(await makeSession(user), { sleep: false });
    expect(res.status).toBe(200);
    expect(caches.analytics.get(`${user.id}|score`)).toBeNull();
    expect(caches.insightsDerived.get(`${user.id}|derived`)).toBeNull();
    expect(caches.analytics.get(`${other.id}|score`)).toEqual({ score: 64 });
  });

  it("leaves them when the write never landed", async () => {
    const user = await makeUser();
    caches.analytics.set(`${user.id}|score`, { score: 71 });

    const res = await patch(await makeSession(user), {
      sleep: false,
      baseUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(409);
    expect(caches.analytics.get(`${user.id}|score`)).toEqual({ score: 71 });
  });
});

/**
 * The base token is stripped before the strict schema parse, so it never
 * trips strict validation; a stale token 409s and writes nothing; a tokenless
 * write stays unconditional.
 */
describe("PATCH /api/auth/me/modules optimistic concurrency", () => {
  it("writes when the base token matches, and answers the advanced token", async () => {
    const user = await makeUser();
    const base = await storedUpdatedAt(user.id);
    const res = await patch(await makeSession(user), {
      mood: false,
      baseUpdatedAt: base.toISOString(),
    });
    // 200, not 422: the token was removed before the strict parse.
    expect(res.status).toBe(200);
    expect(await storedPrefs(user.id)).toEqual({ mood: false });
    const after = await storedUpdatedAt(user.id);
    expect(after.getTime()).toBeGreaterThan(base.getTime());
    expect(res.data.updatedAt).toBe(after.toISOString());
  });

  it("gives a second writer holding the old token 409 and keeps the first write", async () => {
    const user = await makeUser();
    const session = await makeSession(user);
    const base = (await storedUpdatedAt(user.id)).toISOString();

    const first = await patch(session, { mood: false, baseUpdatedAt: base });
    expect(first.status).toBe(200);

    const second = await patch(session, { sleep: false, baseUpdatedAt: base });
    expect(second.status).toBe(409);
    expect(second.meta?.errorCode).toBe("modules_conflict");
    expect(await storedPrefs(user.id)).toEqual({ mood: false });
  });

  it("writes unconditionally when the token is omitted", async () => {
    const user = await makeUser({ modulePreferencesJson: { sleep: false } });
    const session = await makeSession(user);
    // Advance the row under the client: without a token nothing is compared.
    await prisma.user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { sleep: false, labs: false } },
    });
    const res = await patch(session, { mood: false });
    expect(res.status).toBe(200);
    expect(await storedPrefs(user.id)).toEqual({
      sleep: false,
      labs: false,
      mood: false,
    });
  });

  it("still refuses an unknown key beside a valid token", async () => {
    const user = await makeUser();
    const base = (await storedUpdatedAt(user.id)).toISOString();
    const res = await patch(await makeSession(user), {
      notAModule: false,
      baseUpdatedAt: base,
    });
    expect(res.status).toBe(422);
    expect(await storedPrefs(user.id)).toBeNull();
    expect((await storedUpdatedAt(user.id)).toISOString()).toBe(base);
  });

  it("refuses a malformed token with 422 without touching the row", async () => {
    const user = await makeUser();
    const base = (await storedUpdatedAt(user.id)).toISOString();
    const res = await patch(await makeSession(user), {
      mood: false,
      baseUpdatedAt: "not-a-date",
    });
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(await storedPrefs(user.id)).toBeNull();
    expect((await storedUpdatedAt(user.id)).toISOString()).toBe(base);
  });
});
