/**
 * `/api/auth/me/health-score-config` — which pillars count toward the Health
 * Score, against the real database and through the real API kit.
 *
 * Pinned here:
 *   - the read answers every pillar counting and no selection for a fresh
 *     account (and no concurrency token), and a stored recipe as the pillars
 *     it leaves counting, with the row's token;
 *   - the write takes the positive selection, stores its complement with a
 *     recipe version that rises by one on every accepted write, keeps a
 *     keep-everything selection as an authored choice, audits it, and evicts
 *     the account's cached score;
 *   - since v1.38 the only selection refused for breadth is the empty one;
 *     two areas, one area and one pillar all save;
 *   - an unknown pillar, an unknown key, a `userId`, a body that is not JSON
 *     and a stale base token are refused without a write or an eviction;
 *   - the write bucket allows 60 a minute per account;
 *   - the published contract names every error code the route emits.
 *
 * The invalidation cases are here because a missing one is invisible: the
 * write succeeds, the response is right, and the person keeps seeing the old
 * number for an hour.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET, PATCH } from "@/app/api/auth/me/health-score-config/route";
import type { Prisma } from "@/generated/prisma/client";
import type { ScorePillarId } from "@/lib/analytics/score/types";
import { caches } from "@/lib/cache/server-cache";
import { buildOpenApiDocument } from "@/lib/openapi/registry";

import { anonymous, callRoute } from "../../kit/call-route";
import {
  makeSession,
  makeUser,
  type SessionFixture,
} from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();
const ROUTE = "/api/auth/me/health-score-config";

const ALL_PILLARS: ScorePillarId[] = [
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "ACTIVITY",
  "SLEEP",
  "ADIPOSITY",
  "WELLBEING",
  "LIPIDS",
];

interface ResolvedBody {
  pillars: ScorePillarId[];
  excludedPillars: ScorePillarId[];
  hasSelection: boolean;
  version: number;
  changedAt: string | null;
  updatedAt?: string;
}

interface StoredConfig {
  excludedPillars: ScorePillarId[];
  version: number;
  changedAt: string;
}

beforeEach(() => truncateAllTables(prisma));

function isStoredConfig(value: unknown): value is StoredConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "excludedPillars" in value &&
    "version" in value &&
    "changedAt" in value
  );
}

async function storedConfig(userId: string): Promise<StoredConfig | null> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { healthScoreConfigJson: true },
  });
  const value: unknown = row.healthScoreConfigJson;
  if (value === null) return null;
  if (!isStoredConfig(value)) throw new Error("unexpected stored config");
  return value;
}

async function storedUpdatedAt(userId: string): Promise<Date> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { healthScoreConfigRevisedAt: true },
  });
  return row.healthScoreConfigRevisedAt;
}

async function userWithConfig(
  config: Prisma.InputJsonValue | undefined = undefined,
) {
  return makeUser(
    config === undefined ? {} : { healthScoreConfigJson: config },
  );
}

function patch(auth: SessionFixture, body: unknown) {
  return callRoute<ResolvedBody>(PATCH, {
    method: "PATCH",
    route: ROUTE,
    body,
    auth,
  });
}

function seedScoreCache(userId: string): void {
  caches.analytics.set(`${userId}|score`, { score: 71 });
  caches.insightsDerived.set(`${userId}|derived`, { score: 71 });
}

function scoreCacheEvicted(userId: string): boolean {
  return (
    caches.analytics.get(`${userId}|score`) === null &&
    caches.insightsDerived.get(`${userId}|derived`) === null
  );
}

describe("GET /api/auth/me/health-score-config", () => {
  it("refuses an anonymous caller with 401", async () => {
    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      auth: anonymous,
    });
    expect(res.status).toBe(401);
    expect(res.meta?.errorCode).toBe("auth.missing");
  });

  it("answers every pillar counting and no selection for a fresh account", async () => {
    const user = await userWithConfig();
    const res = await callRoute<ResolvedBody>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.pillars).toEqual(ALL_PILLARS);
    expect(res.data.hasSelection).toBe(false);
    expect(res.data.version).toBe(0);
    // Nothing to guard a first write against, so no token.
    expect(res.data).not.toHaveProperty("updatedAt");
  });

  it("answers a stored recipe as the pillars it leaves counting, with the row's token", async () => {
    const user = await userWithConfig({
      excludedPillars: ["SLEEP", "LIPIDS"],
      version: 2,
      changedAt: "2026-07-30T08:00:00.000Z",
    });
    const res = await callRoute<ResolvedBody>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(user),
    });
    expect(res.data.pillars).toEqual(
      ALL_PILLARS.filter((id) => id !== "SLEEP" && id !== "LIPIDS"),
    );
    expect(res.data.excludedPillars).toEqual(["SLEEP", "LIPIDS"]);
    expect(res.data.hasSelection).toBe(true);
    expect(res.data.version).toBe(2);
    expect(res.data.updatedAt).toBe(
      (await storedUpdatedAt(user.id)).toISOString(),
    );
  });
});

describe("PATCH /api/auth/me/health-score-config", () => {
  it("refuses an anonymous caller with 401", async () => {
    const res = await callRoute(PATCH, {
      method: "PATCH",
      route: ROUTE,
      body: { pillars: ALL_PILLARS },
      auth: anonymous,
    });
    expect(res.status).toBe(401);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("stores the complement of the selection, answers the selection and audits it", async () => {
    const user = await userWithConfig();
    const selection: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ];
    const res = await patch(await makeSession(user), { pillars: selection });

    expect(res.status).toBe(200);
    expect(res.data.pillars).toEqual(selection);
    expect(res.data.hasSelection).toBe(true);
    expect(res.data.updatedAt).toBe(
      (await storedUpdatedAt(user.id)).toISOString(),
    );

    const stored = await storedConfig(user.id);
    expect(stored?.excludedPillars).toEqual(
      ALL_PILLARS.filter((id) => !selection.includes(id)),
    );
    expect(stored?.version).toBe(1);
    expect(stored?.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const audit = await prisma.auditLog.findMany({
      where: { userId: user.id, action: "user.health_score_config.update" },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details ?? "null")).toEqual({
      counted: selection,
      excluded: ALL_PILLARS.filter((id) => !selection.includes(id)),
      version: 1,
    });
  });

  it("raises the recipe version by one on every accepted write", async () => {
    const user = await userWithConfig({
      excludedPillars: ["LIPIDS"],
      version: 7,
      changedAt: "2026-07-01T00:00:00.000Z",
    });
    const session = await makeSession(user);
    await patch(session, { pillars: ALL_PILLARS });
    expect((await storedConfig(user.id))?.version).toBe(8);
    await patch(session, { pillars: ["SLEEP"] });
    expect((await storedConfig(user.id))?.version).toBe(9);
  });

  it("keeps a keep-everything selection as an authored choice", async () => {
    const user = await userWithConfig();
    const res = await patch(await makeSession(user), { pillars: ALL_PILLARS });
    expect(res.data.hasSelection).toBe(true);
    expect((await storedConfig(user.id))?.excludedPillars).toEqual([]);
  });

  it("evicts the account's score caches so the old number is not served on", async () => {
    const user = await userWithConfig();
    const other = await makeUser();
    seedScoreCache(user.id);
    seedScoreCache(other.id);

    const res = await patch(await makeSession(user), { pillars: ALL_PILLARS });
    expect(res.status).toBe(200);
    expect(scoreCacheEvicted(user.id)).toBe(true);
    expect(scoreCacheEvicted(other.id)).toBe(false);
  });
});

/**
 * Since v1.38 the breadth floor is a recommendation: the scorer computes
 * from whatever is readable and labels how broad the set was. The empty
 * selection stays refused, because there is nothing left to average.
 */
describe("PATCH: the breadth rule", () => {
  it.each<[string, ScorePillarId[]]>([
    ["activity and wellbeing alone", ["ACTIVITY", "WELLBEING"]],
    [
      "the cardiometabolic triple, three pillars in one area",
      ["BLOOD_PRESSURE", "GLYCAEMIA", "LIPIDS"],
    ],
    ["a single pillar", ["ACTIVITY"]],
    ["a three-area selection", ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"]],
  ])("accepts %s, stores it and evicts the score", async (_, pillars) => {
    const user = await userWithConfig();
    seedScoreCache(user.id);
    const res = await patch(await makeSession(user), { pillars });
    expect(res.status).toBe(200);
    expect(res.data.pillars).toEqual(pillars);
    expect((await storedConfig(user.id))?.excludedPillars).toEqual(
      ALL_PILLARS.filter((id) => !pillars.includes(id)),
    );
    expect(scoreCacheEvicted(user.id)).toBe(true);
  });

  it("refuses an empty selection rather than storing a score that cannot exist", async () => {
    const user = await userWithConfig();
    seedScoreCache(user.id);
    const res = await patch(await makeSession(user), { pillars: [] });
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("health_score_config.too_narrow");
    expect(res.meta?.reason).toBe("no_pillars_selected");
    expect(res.error).toContain("at least one area of health");
    expect(await storedConfig(user.id)).toBeNull();
    expect(scoreCacheEvicted(user.id)).toBe(false);
  });
});

describe("PATCH: envelope and transport", () => {
  it.each<[string, Record<string, unknown>]>([
    [
      "an unknown pillar id",
      { pillars: ["BLOOD_PRESSURE", "MOON_PHASE", "SLEEP"] },
    ],
    ["an unknown body key", { pillars: ALL_PILLARS, weights: { SLEEP: 2 } }],
    ["a userId in the body", { pillars: ALL_PILLARS, userId: "someone-else" }],
  ])("refuses %s with 422 and writes nothing", async (_, body) => {
    const user = await userWithConfig();
    const res = await patch(await makeSession(user), body);
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("health_score_config.invalid");
    expect(await storedConfig(user.id)).toBeNull();
  });

  it("refuses a body that is not JSON with 422", async () => {
    const user = await userWithConfig();
    // The kit serialises every body as JSON, so the unparseable body here is
    // the empty one, sent with a JSON content type.
    const res = await callRoute(PATCH, {
      method: "PATCH",
      route: ROUTE,
      headers: { "content-type": "application/json" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(422);
    expect(res.error).toBe("health-score-config.body.invalid_json");
    expect(await storedConfig(user.id)).toBeNull();
  });

  it("allows 60 writes a minute per account and refuses the 61st with 429", async () => {
    const user = await userWithConfig();
    const session = await makeSession(user);
    for (let i = 0; i < 60; i++) {
      const ok = await patch(session, { pillars: ALL_PILLARS });
      expect(ok.status).toBe(200);
    }
    const refused = await patch(session, { pillars: ["SLEEP"] });
    expect(refused.status).toBe(429);
    const stored = await storedConfig(user.id);
    expect(stored?.version).toBe(60);
    expect(stored?.excludedPillars).toEqual([]);
  });

  it("answers a stale base token with 409, writes nothing and keeps the caches", async () => {
    const user = await userWithConfig({
      excludedPillars: ["LIPIDS"],
      version: 3,
      changedAt: "2026-07-01T00:00:00.000Z",
    });
    const session = await makeSession(user);
    const read = await callRoute<ResolvedBody>(GET, {
      method: "GET",
      route: ROUTE,
      auth: session,
    });
    const base = read.data.updatedAt;
    expect(base).toBeDefined();

    // Another device saves first, with the same token.
    const first = await patch(session, {
      pillars: ALL_PILLARS,
      baseUpdatedAt: base,
    });
    expect(first.status).toBe(200);
    seedScoreCache(user.id);

    const second = await patch(session, {
      pillars: ["SLEEP"],
      baseUpdatedAt: base,
    });
    expect(second.status).toBe(409);
    expect(second.meta?.errorCode).toBe("health_score_config_conflict");
    const stored = await storedConfig(user.id);
    expect(stored?.version).toBe(4);
    expect(stored?.excludedPillars).toEqual([]);
    expect(scoreCacheEvicted(user.id)).toBe(false);
  });
});

/**
 * The route shipped once with a settings surface in front of it and no
 * published contract. The kit's contract check proves each body matches its
 * schema; this block proves the descriptions a client reads name every error
 * code the real route emits, on the status it emits it with.
 */
describe("the published contract names what the route serves", () => {
  type Doc = {
    paths?: Record<
      string,
      Record<string, { responses?: Record<string, { description?: string }> }>
    >;
    components?: {
      schemas?: Record<
        string,
        { properties?: Record<string, unknown>; required?: string[] }
      >;
    };
  };

  function isDoc(value: unknown): value is Doc {
    return typeof value === "object" && value !== null;
  }

  function doc(): Doc {
    const built: unknown = buildOpenApiDocument();
    if (!isDoc(built)) throw new Error("no OpenAPI document");
    return built;
  }

  it("registers both verbs", () => {
    expect(Object.keys(doc().paths?.[ROUTE] ?? {}).sort()).toEqual([
      "get",
      "patch",
    ]);
  });

  it("publishes exactly the fields a real write answers, updatedAt optional", async () => {
    // The kit refuses a key the schema does not declare; this is the other
    // direction, a published field the route never sends.
    const user = await userWithConfig();
    const res = await patch(await makeSession(user), { pillars: ALL_PILLARS });
    expect(res.status).toBe(200);

    const schema = doc().components?.schemas?.["HealthScoreConfigResponse"];
    expect(schema, "HealthScoreConfigResponse is not emitted").toBeDefined();
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      Object.keys(res.data).sort(),
    );
    // Absent on a never-configured read (proven by the GET case above, which
    // the kit parses against this schema), so it must not be required.
    expect(schema?.required ?? []).not.toContain("updatedAt");
  });

  it("names every errorCode the route can emit, on the right status", async () => {
    const emitted = new Map<number, Set<string>>();
    const record = async (
      res: Awaited<ReturnType<typeof patch>>,
    ): Promise<void> => {
      const code = res.meta?.errorCode;
      if (typeof code !== "string") return;
      const set = emitted.get(res.status) ?? new Set<string>();
      set.add(code);
      emitted.set(res.status, set);
    };

    const user = await userWithConfig();
    const session = await makeSession(user);
    // Too narrow: the empty selection.
    await record(await patch(session, { pillars: [] }));
    // A body that fails validation.
    await record(await patch(session, { pillars: ["NOT_A_PILLAR"] }));
    // A present but unparseable base token.
    await record(
      await patch(session, { pillars: ALL_PILLARS, baseUpdatedAt: null }),
    );
    // A stale base token.
    await record(
      await patch(session, {
        pillars: ALL_PILLARS,
        baseUpdatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    // The driver really produced the codes, so a contract naming none of
    // them could not pass by the loop never running.
    expect([...(emitted.get(422) ?? [])].sort()).toEqual([
      "health_score_config.invalid",
      "health_score_config.too_narrow",
      "invalid_base_updated_at",
    ]);
    expect([...(emitted.get(409) ?? [])]).toEqual([
      "health_score_config_conflict",
    ]);

    const responses = doc().paths?.[ROUTE]?.patch?.responses ?? {};
    for (const [status, codes] of emitted) {
      const described = responses[String(status)]?.description ?? "";
      for (const code of codes) {
        expect(
          described,
          `${status} description does not mention \`${code}\``,
        ).toContain(code);
      }
    }
  });
});
