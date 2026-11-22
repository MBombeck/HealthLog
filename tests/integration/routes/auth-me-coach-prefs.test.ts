/**
 * `/api/auth/me/coach-prefs` — the Coach prompt-tuning preferences, against
 * the real database and through the real API kit.
 *
 * Pinned here:
 *   - a saved account reads its prefs plus the `updatedAt` token; a
 *     never-saved one reads the pure defaults and no token, because there is
 *     nothing to guard yet;
 *   - the PUT stores the defaulted form and mirrors `excludeMetrics` onto
 *     `insightsExcludeMetrics` in the same write; with a base token the write
 *     is conditional, and a stale token answers 409 and leaves both columns
 *     as they were; without one the write is unconditional; a malformed token
 *     is 422;
 *   - the thinking depth is stored as chosen, and the wide event names it,
 *     an absent level as the default; a level outside the set is 422.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET, PUT } from "@/app/api/auth/me/coach-prefs/route";
import { readLogBuffer } from "@/lib/logging/in-memory-buffer";

import { anonymous, callRoute, type RouteResult } from "../../kit/call-route";
import { makeSession, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();
const ROUTE = "/api/auth/me/coach-prefs";

type CoachPrefs = {
  tone: string;
  excludeMetrics: string[];
  reasoning?: string;
  updatedAt?: string;
};

beforeEach(() => truncateAllTables(prisma));

async function storedColumns(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      coachPrefsJson: true,
      insightsExcludeMetrics: true,
      coachPrefsRevisedAt: true,
    },
  });
}

/** The `meta` the route put on its wide event, read from the log ring. */
function putEventMeta(res: RouteResult): Record<string, unknown> | undefined {
  const requestId = res.headers.get("x-request-id");
  if (!requestId) throw new Error("the response carries no x-request-id");
  const [event] = readLogBuffer({
    requestId,
    action: "auth.me.coach-prefs.put",
  });
  return event?.meta;
}

describe("GET /api/auth/me/coach-prefs", () => {
  it("refuses an anonymous caller with 401", async () => {
    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      auth: anonymous,
    });
    expect(res.status).toBe(401);
  });

  it("answers a saved account's prefs plus the optimistic-concurrency token", async () => {
    const user = await makeUser({ coachPrefsJson: { tone: "concise" } });
    const res = await callRoute<CoachPrefs>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.tone).toBe("concise");
    const row = await storedColumns(user.id);
    expect(res.data.updatedAt).toBe(row.coachPrefsRevisedAt.toISOString());
  });

  it("answers the pure defaults with no token for a never-saved account", async () => {
    const user = await makeUser();
    const res = await callRoute<CoachPrefs>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.tone).toBe("warm");
    expect(res.data.excludeMetrics).toEqual([]);
    expect(res.data).not.toHaveProperty("updatedAt");
  });
});

describe("PUT /api/auth/me/coach-prefs — optimistic concurrency", () => {
  it("writes both columns under a current token and echoes the fresh one", async () => {
    const user = await makeUser({ coachPrefsJson: { tone: "neutral" } });
    const session = await makeSession(user);
    const read = await callRoute<CoachPrefs>(GET, {
      method: "GET",
      route: ROUTE,
      auth: session,
    });

    const res = await callRoute<CoachPrefs>(PUT, {
      method: "PUT",
      route: ROUTE,
      body: { excludeMetrics: ["weight"], baseUpdatedAt: read.data.updatedAt },
      auth: session,
    });

    expect(res.status).toBe(200);
    const row = await storedColumns(user.id);
    expect(row.coachPrefsJson).toMatchObject({
      tone: "warm",
      excludeMetrics: ["weight"],
    });
    expect(row.insightsExcludeMetrics).toEqual(["weight"]);
    expect(res.data.updatedAt).toBe(row.coachPrefsRevisedAt.toISOString());
    expect(res.data.updatedAt).not.toBe(read.data.updatedAt);
  });

  it("answers a stale token with 409 and leaves both columns untouched", async () => {
    const user = await makeUser({ coachPrefsJson: { tone: "neutral" } });
    const session = await makeSession(user);
    const read = await callRoute<CoachPrefs>(GET, {
      method: "GET",
      route: ROUTE,
      auth: session,
    });

    // Another device saves first, with the same token.
    const first = await callRoute(PUT, {
      method: "PUT",
      route: ROUTE,
      body: { excludeMetrics: ["mood"], baseUpdatedAt: read.data.updatedAt },
      auth: session,
    });
    expect(first.status).toBe(200);
    const afterFirst = await storedColumns(user.id);

    const stale = await callRoute(PUT, {
      method: "PUT",
      route: ROUTE,
      body: { excludeMetrics: ["weight"], baseUpdatedAt: read.data.updatedAt },
      auth: session,
    });
    expect(stale.status).toBe(409);
    expect(stale.meta?.errorCode).toBe("coach_prefs_conflict");
    expect(await storedColumns(user.id)).toEqual(afterFirst);
    expect(afterFirst.insightsExcludeMetrics).toEqual(["mood"]);
  });

  it("writes unconditionally when the token is omitted", async () => {
    const user = await makeUser({ coachPrefsJson: { tone: "neutral" } });
    const res = await callRoute<CoachPrefs>(PUT, {
      method: "PUT",
      route: ROUTE,
      body: { excludeMetrics: ["weight"] },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    const row = await storedColumns(user.id);
    expect(row.insightsExcludeMetrics).toEqual(["weight"]);
    expect(row.coachPrefsJson).toMatchObject({ excludeMetrics: ["weight"] });
    expect(res.data.updatedAt).toBe(row.coachPrefsRevisedAt.toISOString());
  });

  it("answers a malformed token with 422 and leaves the row alone", async () => {
    const user = await makeUser();
    const before = await storedColumns(user.id);
    const res = await callRoute(PUT, {
      method: "PUT",
      route: ROUTE,
      body: { excludeMetrics: ["weight"], baseUpdatedAt: "not-a-date" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(await storedColumns(user.id)).toEqual(before);
  });

  it("answers a body that is not JSON with 400 and its error code", async () => {
    const user = await makeUser();
    // The kit serialises every body as JSON, so the unparseable body here is
    // the empty one, sent with a JSON content type.
    const res = await callRoute(PUT, {
      method: "PUT",
      route: ROUTE,
      headers: { "content-type": "application/json" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(400);
    expect(res.meta?.errorCode).toBe("coach-prefs.body.invalid_json");
  });
});

describe("PUT /api/auth/me/coach-prefs — thinking depth", () => {
  it("stores the chosen level and names it on the wide event", async () => {
    const user = await makeUser();
    const res = await callRoute<CoachPrefs>(PUT, {
      method: "PUT",
      route: ROUTE,
      body: { reasoning: "high" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.reasoning).toBe("high");
    const row = await storedColumns(user.id);
    expect(row.coachPrefsJson).toMatchObject({ reasoning: "high" });
    expect(putEventMeta(res)).toMatchObject({ reasoning: "high" });
  });

  it("reads an absent level as the default on the wide event", async () => {
    const user = await makeUser();
    const res = await callRoute(PUT, {
      method: "PUT",
      route: ROUTE,
      body: { tone: "warm" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(putEventMeta(res)).toMatchObject({ reasoning: "medium" });
  });

  it.each(["xhigh", "none", 2, null])(
    "refuses %s as a level with 422 and stores nothing",
    async (value) => {
      const user = await makeUser();
      const res = await callRoute(PUT, {
        method: "PUT",
        route: ROUTE,
        body: { reasoning: value },
        auth: await makeSession(user),
      });
      expect(res.status).toBe(422);
      expect(res.meta?.errorCode).toBe("coach-prefs.body.invalid_shape");
      const row = await storedColumns(user.id);
      expect(row.coachPrefsJson).toBeNull();
    },
  );
});
