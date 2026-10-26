/**
 * The Strava sync against the real schema.
 *
 * Strava is replaced at the `safeFetch` seam by a small fake of its API v3:
 * an athlete's activity history served the way Strava serves it (oldest
 * first when the list is asked with `after`, newest first without it, cut by
 * `before`, paged by `page` / `per_page`), the per-activity detail read that
 * alone carries `calories` and `description`, and the token endpoint, which
 * rotates the refresh token on every use. Everything on this side of that
 * seam runs as production runs it: the page walk, the mapping, the workout
 * upsert on `(userId, source, externalId)`, the reactive refresh under the
 * advisory lock, the integration ledger, and the backfill job that walks the
 * history in runs.
 *
 * What is pinned, read back from the rows:
 *   - activities land as `Workout` rows with the mapped fields, and a re-sync
 *     of the same payload adds nothing;
 *   - an activity changed at Strava overwrites its row in place, and an
 *     update mapped from the summary alone keeps what only the detail read
 *     carries;
 *   - the incremental cursor (`stravaLastActivityAt`) moves to the newest
 *     activity a finished walk read, never backwards, and not at all when a
 *     row failed to write or a newest-first walk was cut short;
 *   - the backfill marks the history complete only when it read to the start,
 *     and otherwise records where it got to (`stravaBackfillResumeBefore`) and
 *     goes on from there;
 *   - a refused token is refreshed once and both rotated tokens are stored;
 *     a refused refresh, a failed list read and a rate limit are booked on
 *     the `strava` ledger with their kind and status code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StravaDetailedActivity } from "@/lib/strava/wire-types";
import type { IntegrationStatus, User } from "@/generated/prisma/client";
import { decrypt, encrypt } from "@/lib/crypto";
import { recordSyncFailure } from "@/lib/integrations/status";
import { runStravaBackfillForUser } from "@/lib/jobs/strava-backfill";
import { syncStravaHistory, syncUserStrava } from "@/lib/strava/sync";
import { POST as syncRoute } from "@/app/api/strava/sync/route";

import { anonymous, callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

interface RecordedRequest {
  method: string;
  url: URL;
  authorization: string | null;
  body: string | null;
}

interface FailureAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const strava = vi.hoisted(() => ({
  /** The athlete's history as Strava holds it; detail-only fields included. */
  activities: [] as StravaDetailedActivity[],
  /** Access tokens Strava currently accepts. */
  accessTokens: new Set<string>(),
  /** Refresh tokens Strava currently accepts, each with the pair it rotates to. */
  refreshGrants: new Map<string, { access: string; refresh: string }>(),
  /** A refusal for the token endpoint, instead of honouring the grant. */
  tokenFailure: null as FailureAnswer | null,
  /** A refusal for one page of the activity list (1-based). */
  listFailure: null as (FailureAnswer & { page: number }) | null,
  /** A refusal for the detail read of one activity id. */
  detailFailures: new Map<number, FailureAnswer>(),
  /** Serve the newest pages whatever `before` says, as a provider bug would. */
  ignoreBefore: false,
  /** Refuse to queue workout arrivals, as a queue that is down would. */
  refuseArrivals: false,
  requests: [] as RecordedRequest[],
  sends: [] as Array<{ queue: string; payload: unknown; options: unknown }>,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    send: async (queue: string, payload: unknown, options: unknown) => {
      if (queue === "data-arrival" && strava.refuseArrivals) {
        throw new Error("queue unavailable");
      }
      strava.sends.push({ queue, payload, options });
      return `job-${strava.sends.length}`;
    },
  }),
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string | URL, init: RequestInit = {}) =>
      serveStrava(new URL(String(url)), init),
  };
});

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function refusal(answer: FailureAnswer): Response {
  return json(
    answer.body ?? { message: "Error", errors: [] },
    answer.status,
    answer.headers,
  );
}

const AUTHORIZATION_ERROR = {
  message: "Authorization Error",
  errors: [{ resource: "Athlete", field: "access_token", code: "invalid" }],
};

/** The summary Strava's list endpoint serves: no calories, no description. */
function summaryOf(a: StravaDetailedActivity): StravaDetailedActivity {
  const { calories: _calories, description: _description, ...summary } = a;
  return summary;
}

function startMs(a: StravaDetailedActivity): number {
  return Date.parse(a.start_date ?? "");
}

async function serveStrava(url: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization");
  const body = typeof init.body === "string" ? init.body : null;
  strava.requests.push({
    method: init.method ?? "GET",
    url,
    authorization,
    body,
  });

  if (url.pathname === "/oauth/token") {
    if (strava.tokenFailure) return refusal(strava.tokenFailure);
    const form = new URLSearchParams(body ?? "");
    const next = strava.refreshGrants.get(form.get("refresh_token") ?? "");
    if (form.get("grant_type") !== "refresh_token" || !next) {
      return json(
        {
          message: "Bad Request",
          errors: [
            {
              resource: "RefreshToken",
              field: "refresh_token",
              code: "invalid",
            },
          ],
        },
        400,
      );
    }
    strava.refreshGrants.delete(form.get("refresh_token") ?? "");
    strava.accessTokens.add(next.access);
    return json({
      token_type: "Bearer",
      access_token: next.access,
      refresh_token: next.refresh,
      expires_at: Math.floor(Date.now() / 1000) + 21_600,
      expires_in: 21_600,
    });
  }

  if (url.pathname === "/oauth/deauthorize") {
    return json({ access_token: authorization?.replace("Bearer ", "") });
  }

  const token = authorization?.replace(/^Bearer /, "") ?? "";
  if (!strava.accessTokens.has(token)) return json(AUTHORIZATION_ERROR, 401);

  if (url.pathname === "/api/v3/athlete/activities") {
    const p = url.searchParams;
    const page = Number(p.get("page") ?? "1");
    const perPage = Number(p.get("per_page") ?? "30");
    if (strava.listFailure && strava.listFailure.page === page) {
      return refusal(strava.listFailure);
    }
    const after = p.has("after") ? Number(p.get("after")) * 1000 : null;
    const before =
      p.has("before") && !strava.ignoreBefore
        ? Number(p.get("before")) * 1000
        : null;
    const matching = strava.activities
      .filter((a) => after === null || startMs(a) > after)
      .filter((a) => before === null || startMs(a) < before)
      .sort((a, b) =>
        after !== null ? startMs(a) - startMs(b) : startMs(b) - startMs(a),
      );
    const from = (page - 1) * perPage;
    return json(matching.slice(from, from + perPage).map(summaryOf));
  }

  const detail = /^\/api\/v3\/activities\/(\d+)$/.exec(url.pathname);
  if (detail) {
    const id = Number(detail[1]);
    const failure = strava.detailFailures.get(id);
    if (failure) return refusal(failure);
    const found = strava.activities.find((a) => a.id === id);
    if (!found) {
      return json({ message: "Record Not Found", errors: [] }, 404);
    }
    return json(found);
  }

  return json({ message: "Record Not Found", errors: [] }, 404);
}

const prisma = getPrismaClient();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The stored cursor of most incremental cases. */
const CURSOR = new Date("2026-07-01T08:00:00.000Z");

/**
 * An activity as Strava records it. A run with heart rate by default; the
 * detail read adds calories and a description.
 */
function activity(
  id: number,
  start: Date | number,
  fields: Partial<StravaDetailedActivity> = {},
): StravaDetailedActivity {
  const iso = new Date(start).toISOString();
  return {
    id,
    name: `Activity ${id}`,
    type: "Run",
    sport_type: "TrailRun",
    start_date: iso,
    start_date_local: iso.replace("Z", ""),
    distance: 5000,
    moving_time: 1500,
    elapsed_time: 1600,
    total_elevation_gain: 42,
    has_heartrate: true,
    average_heartrate: 148,
    max_heartrate: 171,
    calories: 480,
    description: "Hill reps",
    ...fields,
  };
}

/** A connected account: its own Strava app, and a grant Strava accepts. */
async function connectedUser(
  overrides: Parameters<typeof makeUser>[0] = {},
): Promise<User> {
  strava.accessTokens.add("access-1");
  strava.refreshGrants.set("refresh-1", {
    access: "access-2",
    refresh: "refresh-2",
  });
  return makeUser({
    stravaClientIdEncrypted: encrypt("client-123"),
    stravaClientSecretEncrypted: encrypt("client-secret-xyz"),
    stravaAccessTokenEncrypted: encrypt("access-1"),
    stravaRefreshTokenEncrypted: encrypt("refresh-1"),
    stravaAthleteId: "9001",
    ...overrides,
  });
}

function stravaWorkouts(userId: string) {
  return prisma.workout.findMany({
    where: { userId, source: "STRAVA" },
    orderBy: { startedAt: "asc" },
  });
}

async function storedUser(userId: string) {
  return prisma.user.findUniqueOrThrow({ where: { id: userId } });
}

function ledger(userId: string): Promise<IntegrationStatus | null> {
  return prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration: "strava" } },
  });
}

function listRequests(): URLSearchParams[] {
  return strava.requests
    .filter((r) => r.url.pathname === "/api/v3/athlete/activities")
    .map((r) => r.url.searchParams);
}

function admissionSends() {
  return strava.sends.filter(
    (s) => s.queue === "integration-backfill-admission",
  );
}

function recentCalls(row: IntegrationStatus | null): unknown[] {
  return Array.isArray(row?.recentCalls) ? row.recentCalls : [];
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  strava.activities = [];
  strava.accessTokens.clear();
  strava.refreshGrants.clear();
  strava.tokenFailure = null;
  strava.listFailure = null;
  strava.detailFailures.clear();
  strava.ignoreBefore = false;
  strava.refuseArrivals = false;
  strava.requests = [];
  strava.sends = [];
});

describe("an incremental sync", () => {
  it("stores each activity as a Workout row with the mapped fields", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    const runStart = new Date(CURSOR.getTime() + 2 * HOUR);
    const rideStart = new Date(CURSOR.getTime() + 30 * HOUR);
    strava.activities = [
      activity(1001, runStart),
      activity(1002, rideStart, {
        name: "Commute",
        type: "Ride",
        sport_type: "Ride",
        distance: 21_500.5,
        moving_time: 3000,
        elapsed_time: 3300,
        total_elevation_gain: 120,
        average_heartrate: 131.6,
        max_heartrate: 160,
        average_watts: 182.4,
        commute: true,
        calories: 640,
        description: undefined,
      }),
    ];

    await expect(syncUserStrava(user.id)).resolves.toBe(2);

    const [run, ride] = await stravaWorkouts(user.id);
    expect(run).toMatchObject({
      externalId: "1001",
      source: "STRAVA",
      sportType: "running",
      startedAt: runStart,
      // The clock window is the elapsed time; the duration is moving time.
      endedAt: new Date(runStart.getTime() + 1600 * 1000),
      durationSec: 1500,
      totalDistanceM: 5000,
      elevationM: 42,
      avgHeartRate: 148,
      maxHeartRate: 171,
      totalEnergyKcal: 480,
      metadata: {
        stravaName: "Activity 1001",
        stravaDescription: "Hill reps",
        stravaType: "TrailRun",
        elapsedTimeSec: 1600,
      },
    });
    expect(ride).toMatchObject({
      externalId: "1002",
      sportType: "cycling",
      startedAt: rideStart,
      endedAt: new Date(rideStart.getTime() + 3300 * 1000),
      durationSec: 3000,
      totalDistanceM: 21_500.5,
      elevationM: 120,
      avgHeartRate: 132,
      maxHeartRate: 160,
      totalEnergyKcal: 640,
      metadata: {
        stravaName: "Commute",
        stravaType: "Ride",
        averageWatts: 182.4,
        commute: true,
      },
    });

    // The cursor moves to the newest activity read, the ledger reads healthy.
    expect((await storedUser(user.id)).stravaLastActivityAt).toEqual(rideStart);
    expect(await ledger(user.id)).toMatchObject({
      state: "connected",
      lastError: null,
    });
  });

  it("asks for activities after the stored cursor minus a day of overlap, with the account's token", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.activities = [activity(1, CURSOR.getTime() + HOUR)];

    await syncUserStrava(user.id);

    const [list] = strava.requests;
    expect(`${list?.url.origin}${list?.url.pathname}`).toBe(
      "https://www.strava.com/api/v3/athlete/activities",
    );
    expect(list?.authorization).toBe("Bearer access-1");
    expect(Object.fromEntries(list!.url.searchParams)).toEqual({
      after: String((CURSOR.getTime() - DAY) / 1000),
      page: "1",
      per_page: "100",
    });
    // One detail read per activity, for the calories.
    expect(
      strava.requests
        .filter((r) => r.url.pathname.startsWith("/api/v3/activities/"))
        .map((r) => r.url.pathname),
    ).toEqual(["/api/v3/activities/1"]);
  });

  it("looks back thirty days when the account has no cursor yet", async () => {
    const user = await connectedUser();
    const recent = new Date(Date.now() - 2 * DAY);
    strava.activities = [
      activity(1, recent),
      activity(2, Date.now() - 45 * DAY),
    ];

    const before = Date.now();
    await expect(syncUserStrava(user.id)).resolves.toBe(1);
    const after = Date.now();

    const asked = Number(listRequests()[0]?.get("after")) * 1000;
    expect(asked).toBeGreaterThanOrEqual(before - 30 * DAY - 1000);
    expect(asked).toBeLessThanOrEqual(after - 30 * DAY);
    expect((await stravaWorkouts(user.id)).map((w) => w.externalId)).toEqual([
      "1",
    ]);
    expect((await storedUser(user.id)).stravaLastActivityAt).toEqual(recent);
  });

  it("does not move the cursor back for a late upload inside the overlap", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    const late = new Date(CURSOR.getTime() - 6 * HOUR);
    strava.activities = [activity(7, late)];

    await expect(syncUserStrava(user.id)).resolves.toBe(1);

    expect((await stravaWorkouts(user.id))[0]?.startedAt).toEqual(late);
    expect((await storedUser(user.id)).stravaLastActivityAt).toEqual(CURSOR);
  });

  it("is a clean no-op for an account without a Strava connection", async () => {
    const user = await makeUser();

    await expect(syncUserStrava(user.id)).resolves.toBe(0);

    expect(strava.requests).toEqual([]);
    expect(await ledger(user.id)).toBeNull();
  });
});

describe("a re-sync", () => {
  it("of the same payload adds no row and keeps each row's identity", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.activities = [
      activity(1, CURSOR.getTime() + HOUR),
      activity(2, CURSOR.getTime() + 2 * HOUR),
      activity(3, CURSOR.getTime() + 3 * HOUR),
    ];

    await expect(syncUserStrava(user.id)).resolves.toBe(3);
    const first = await stravaWorkouts(user.id);
    await prisma.user.update({
      where: { id: user.id },
      data: { stravaLastActivityAt: CURSOR },
    });
    await expect(syncUserStrava(user.id)).resolves.toBe(3);
    const second = await stravaWorkouts(user.id);

    expect(second).toHaveLength(3);
    expect(second.map((w) => w.id)).toEqual(first.map((w) => w.id));
    expect(await prisma.workout.count({ where: { userId: user.id } })).toBe(3);
  });

  it("overwrites an activity changed at Strava in place", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    const start = CURSOR.getTime() + HOUR;
    strava.activities = [activity(1, start)];
    await syncUserStrava(user.id);
    const [before] = await stravaWorkouts(user.id);

    // Renamed, re-typed and trimmed on Strava after the first read.
    strava.activities = [
      activity(1, start, {
        name: "Easy ride",
        type: "Ride",
        sport_type: "Ride",
        distance: 12_000,
        moving_time: 2400,
        elapsed_time: 2500,
        average_heartrate: 120,
        max_heartrate: 150,
        calories: 300,
        description: "Recovery",
      }),
    ];
    await syncUserStrava(user.id);

    const after = await stravaWorkouts(user.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before!.id,
      sportType: "cycling",
      durationSec: 2400,
      endedAt: new Date(start + 2500 * 1000),
      totalDistanceM: 12_000,
      avgHeartRate: 120,
      maxHeartRate: 150,
      totalEnergyKcal: 300,
      metadata: {
        stravaName: "Easy ride",
        stravaDescription: "Recovery",
        stravaType: "Ride",
      },
    });
  });

  it("from the summary alone keeps the calories, heart rate and description an earlier detail read stored", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    const start = CURSOR.getTime() + HOUR;
    strava.activities = [activity(1, start)];
    await syncUserStrava(user.id);

    // The detail read fails this time, and the summary carries no heart rate.
    strava.detailFailures.set(1, { status: 500 });
    strava.activities = [
      activity(1, start, {
        distance: 5200,
        moving_time: 1800,
        has_heartrate: false,
        average_heartrate: undefined,
        max_heartrate: undefined,
      }),
    ];
    await expect(syncUserStrava(user.id)).resolves.toBe(1);

    const [row] = await stravaWorkouts(user.id);
    expect(row).toMatchObject({
      totalDistanceM: 5200,
      durationSec: 1800,
      totalEnergyKcal: 480,
      avgHeartRate: 148,
      maxHeartRate: 171,
      metadata: { stravaDescription: "Hill reps" },
    });
  });

  it("with a detail read writes what the detail returned, nulls included", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    const start = CURSOR.getTime() + HOUR;
    strava.activities = [activity(1, start)];
    await syncUserStrava(user.id);

    strava.activities = [activity(1, start, { calories: null })];
    await syncUserStrava(user.id);

    const [row] = await stravaWorkouts(user.id);
    expect(row?.totalEnergyKcal).toBeNull();
  });
});

describe("the arrival of a new workout", () => {
  function arrivalSends() {
    return strava.sends.filter((s) => s.queue === "data-arrival");
  }

  it("is announced once for the inserted row and not again when the row is updated", async () => {
    const user = await connectedUser();
    const start = Date.now() - 2 * HOUR;
    strava.activities = [activity(1, start)];

    await syncUserStrava(user.id);
    const [row] = await stravaWorkouts(user.id);
    await vi.waitFor(() => expect(arrivalSends()).toHaveLength(1));
    expect(arrivalSends()[0]?.payload).toMatchObject({
      userId: user.id,
      kind: "workout",
      refId: row!.id,
      source: "strava",
    });

    // The same activity again, changed: an update, not an arrival. A second
    // new activity after it proves the queue was listened to all along.
    strava.activities = [
      activity(1, start, { distance: 6000 }),
      activity(2, start + HOUR),
    ];
    await syncUserStrava(user.id);
    const second = await prisma.workout.findFirstOrThrow({
      where: { userId: user.id, externalId: "2" },
    });
    await vi.waitFor(() => expect(arrivalSends()).toHaveLength(2));
    expect(arrivalSends().map((s) => s.payload)).toEqual([
      expect.objectContaining({ refId: row!.id }),
      expect.objectContaining({ refId: second.id }),
    ]);
  });

  it("keeps the row when the announcement cannot be queued", async () => {
    const user = await connectedUser();
    strava.refuseArrivals = true;
    strava.activities = [activity(1, Date.now() - 2 * HOUR)];

    await expect(syncUserStrava(user.id)).resolves.toBe(1);

    expect(await stravaWorkouts(user.id)).toHaveLength(1);
    expect((await ledger(user.id))?.state).toBe("connected");
  });
});

describe("a row the database refuses", () => {
  // A moving time past the 32-bit range Postgres stores `duration_sec` in.
  const unstorable = { moving_time: 3_000_000_000 };

  it("fails the sync after attempting the rest, and leaves the cursor where it was", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.activities = [
      activity(1, CURSOR.getTime() + HOUR),
      activity(2, CURSOR.getTime() + 2 * HOUR, unstorable),
      activity(3, CURSOR.getTime() + 3 * HOUR),
    ];

    await expect(syncUserStrava(user.id)).rejects.toThrow();

    expect((await stravaWorkouts(user.id)).map((w) => w.externalId)).toEqual([
      "1",
      "3",
    ]);
    expect((await storedUser(user.id)).stravaLastActivityAt).toEqual(CURSOR);
    const row = await ledger(user.id);
    expect(row).toMatchObject({
      state: "error_transient",
      lastSuccessAt: null,
    });
    expect(row?.lastError).not.toBeNull();
  });

  it("leaves the backfill unfinished", async () => {
    const user = await connectedUser();
    strava.activities = [
      activity(1, CURSOR.getTime() + HOUR),
      activity(2, CURSOR.getTime() + 2 * HOUR, unstorable),
    ];

    await expect(runStravaBackfillForUser(user.id)).rejects.toThrow();

    const stored = await storedUser(user.id);
    expect(stored.stravaBackfillCompletedAt).toBeNull();
    expect(stored.stravaBackfillResumeBefore).toBeNull();
    expect(stored.stravaLastActivityAt).toBeNull();
  });
});

describe("the token", () => {
  it("is refreshed once after a refusal, and both rotated tokens are stored", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.accessTokens.delete("access-1");
    strava.activities = [activity(1, CURSOR.getTime() + HOUR)];

    await expect(syncUserStrava(user.id)).resolves.toBe(1);

    const tokenCalls = strava.requests.filter(
      (r) => r.url.pathname === "/oauth/token",
    );
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.method).toBe("POST");
    expect(
      Object.fromEntries(new URLSearchParams(tokenCalls[0]?.body ?? "")),
    ).toEqual({
      client_id: "client-123",
      client_secret: "client-secret-xyz",
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    });
    // Refused with the old token, retried and continued with the new one.
    expect(
      strava.requests
        .filter((r) => r.url.pathname !== "/oauth/token")
        .map((r) => r.authorization),
    ).toEqual(["Bearer access-1", "Bearer access-2", "Bearer access-2"]);

    const stored = await storedUser(user.id);
    expect(decrypt(stored.stravaAccessTokenEncrypted ?? "")).toBe("access-2");
    expect(decrypt(stored.stravaRefreshTokenEncrypted ?? "")).toBe("refresh-2");
    expect(await stravaWorkouts(user.id)).toHaveLength(1);
    expect((await ledger(user.id))?.state).toBe("connected");
  });

  it("is refreshed with the shared app from the environment when the account has no app of its own", async () => {
    vi.stubEnv("STRAVA_CLIENT_ID", "shared-client");
    vi.stubEnv("STRAVA_CLIENT_SECRET", "shared-secret");
    try {
      const user = await connectedUser({
        stravaLastActivityAt: CURSOR,
        stravaClientIdEncrypted: null,
        stravaClientSecretEncrypted: null,
      });
      strava.accessTokens.delete("access-1");

      await expect(syncUserStrava(user.id)).resolves.toBe(0);

      const refresh = strava.requests.find(
        (r) => r.url.pathname === "/oauth/token",
      );
      const form = new URLSearchParams(refresh?.body ?? "");
      expect(form.get("client_id")).toBe("shared-client");
      expect(form.get("client_secret")).toBe("shared-secret");
      const stored = await storedUser(user.id);
      expect(decrypt(stored.stravaRefreshTokenEncrypted ?? "")).toBe(
        "refresh-2",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refused at the token endpoint parks the connection for re-authorisation", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.accessTokens.delete("access-1");
    strava.tokenFailure = {
      status: 401,
      body: {
        message: "Authorization Error",
        errors: [{ resource: "Application", field: "", code: "invalid" }],
      },
    };
    strava.activities = [activity(1, CURSOR.getTime() + HOUR)];

    await expect(syncUserStrava(user.id)).rejects.toThrow();

    const row = await ledger(user.id);
    expect(row?.state).toBe("error_reauth");
    expect(row?.consecutiveFailuresByKind).toMatchObject({
      reauth_required: 1,
    });
    expect(recentCalls(row)[0]).toMatchObject({
      status: "reauth_required",
      errorCode: "401",
    });
    // Nothing was written, and the stored grant is the one it had.
    expect(await stravaWorkouts(user.id)).toEqual([]);
    const stored = await storedUser(user.id);
    expect(decrypt(stored.stravaAccessTokenEncrypted ?? "")).toBe("access-1");
    expect(decrypt(stored.stravaRefreshTokenEncrypted ?? "")).toBe("refresh-1");
    expect(stored.stravaLastActivityAt).toEqual(CURSOR);

    // The backfill does not spend a request on a grant waiting for the user.
    strava.requests = [];
    await expect(runStravaBackfillForUser(user.id)).resolves.toEqual({
      imported: 0,
      continued: false,
    });
    expect(strava.requests).toEqual([]);
    expect((await storedUser(user.id)).stravaBackfillCompletedAt).toBeNull();
  });
});

describe("a failed list read", () => {
  it("is booked transient with its status code, and nothing moves", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.activities = [activity(1, CURSOR.getTime() + HOUR)];
    strava.listFailure = { page: 1, status: 503 };

    await expect(syncUserStrava(user.id)).rejects.toThrow();

    const row = await ledger(user.id);
    expect(row).toMatchObject({
      state: "error_transient",
      lastSuccessAt: null,
    });
    expect(row?.consecutiveFailuresByKind).toMatchObject({ transient: 1 });
    expect(row?.lastError).not.toBeNull();
    expect(recentCalls(row)[0]).toMatchObject({
      status: "transient",
      errorCode: "503",
    });
    expect(await stravaWorkouts(user.id)).toEqual([]);
    expect((await storedUser(user.id)).stravaLastActivityAt).toEqual(CURSOR);
  });

  it("after an earlier failure, a successful sync clears the ledger", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    await recordSyncFailure({
      userId: user.id,
      integration: "strava",
      kind: "transient",
      message: "Strava fetchActivities error: 503",
      errorCode: "503",
    });
    strava.activities = [activity(1, CURSOR.getTime() + HOUR)];

    await syncUserStrava(user.id);

    const row = await ledger(user.id);
    expect(row).toMatchObject({ state: "connected", lastError: null });
    expect(row?.lastSuccessAt).toBeInstanceOf(Date);
    expect(row?.consecutiveFailuresByKind).toMatchObject({ transient: 0 });
  });
});

describe("a 429 in the middle of a walk", () => {
  it("keeps what was read, moves the cursor as far as an oldest-first walk proves, and books it transient", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    const starts = [1, 2, 3, 4, 5].map((n) => CURSOR.getTime() + n * HOUR);
    strava.activities = starts.map((s, i) => activity(i + 1, s));
    strava.detailFailures.set(4, {
      status: 429,
      headers: {
        "X-RateLimit-Limit": "200,2000",
        "X-RateLimit-Usage": "200,950",
      },
      body: { message: "Rate Limit Exceeded", errors: [] },
    });

    await expect(syncUserStrava(user.id)).resolves.toBe(3);

    expect((await stravaWorkouts(user.id)).map((w) => w.externalId)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect((await storedUser(user.id)).stravaLastActivityAt).toEqual(
      new Date(starts[2]!),
    );
    const row = await ledger(user.id);
    expect(row).toMatchObject({
      state: "error_transient",
      lastSuccessAt: null,
    });
    expect(recentCalls(row)[0]).toMatchObject({
      status: "transient",
      errorCode: "429",
    });
  });

  it("does not move the cursor past a newest-first walk it did not finish", async () => {
    const earlier = new Date("2026-06-01T00:00:00.000Z");
    const user = await connectedUser({ stravaLastActivityAt: earlier });
    strava.activities = [9, 8, 7].map((n) =>
      activity(n, CURSOR.getTime() + n * HOUR),
    );
    strava.detailFailures.set(7, { status: 429 });

    const run = await syncStravaHistory(user.id);

    expect(run.imported).toBe(2);
    expect(run.oldestStart).toEqual(new Date(CURSOR.getTime() + 8 * HOUR));
    expect((await stravaWorkouts(user.id)).map((w) => w.externalId)).toEqual([
      "8",
      "9",
    ]);
    expect((await storedUser(user.id)).stravaLastActivityAt).toEqual(earlier);
  });
});

describe("the history backfill", () => {
  const T0 = Date.UTC(2020, 0, 1);
  const PER_PAGE = 100;
  const MAX_PAGES = 40;

  /** A history of `total` activities; a higher id started later. */
  function history(total: number): void {
    strava.activities = Array.from({ length: total }, (_, i) =>
      activity(i + 1, T0 + (i + 1) * HOUR),
    );
  }

  it("reads newest first until a short page and marks the history complete", async () => {
    const user = await connectedUser();
    history(2 * PER_PAGE + 7);

    await expect(runStravaBackfillForUser(user.id)).resolves.toEqual({
      imported: 207,
      continued: false,
    });

    const lists = listRequests();
    expect(lists.map((q) => q.get("page"))).toEqual(["1", "2", "3"]);
    expect(lists.every((q) => !q.has("after") && !q.has("before"))).toBe(true);
    expect(await prisma.workout.count({ where: { userId: user.id } })).toBe(
      207,
    );
    const stored = await storedUser(user.id);
    expect(stored.stravaBackfillCompletedAt).toBeInstanceOf(Date);
    expect(stored.stravaBackfillResumeBefore).toBeNull();
    // The walk read the newest activity, so the incremental cursor sits on it.
    expect(stored.stravaLastActivityAt).toEqual(new Date(T0 + 207 * HOUR));
    expect(admissionSends()).toEqual([]);
  });

  it("ends on an empty page after a full one and still marks the history complete", async () => {
    const user = await connectedUser();
    history(PER_PAGE);

    await expect(runStravaBackfillForUser(user.id)).resolves.toEqual({
      imported: PER_PAGE,
      continued: false,
    });

    expect(listRequests().map((q) => q.get("page"))).toEqual(["1", "2"]);
    expect(
      (await storedUser(user.id)).stravaBackfillCompletedAt,
    ).toBeInstanceOf(Date);
  });

  it("stops at its page ceiling, records where it got to, and the next run goes on from there and finishes", async () => {
    const user = await connectedUser();
    history((MAX_PAGES + 1) * PER_PAGE);

    // The first run reads forty pages of the forty-one and is not complete.
    await expect(runStravaBackfillForUser(user.id)).resolves.toEqual({
      imported: MAX_PAGES * PER_PAGE,
      continued: true,
    });
    expect(listRequests()).toHaveLength(MAX_PAGES);
    // The oldest activity read is id 101; the next run asks for those
    // before a second past its start.
    const resumeBefore = new Date(T0 + 101 * HOUR + 1000);
    let stored = await storedUser(user.id);
    expect(stored.stravaBackfillCompletedAt).toBeNull();
    expect(stored.stravaBackfillResumeBefore).toEqual(resumeBefore);
    expect(admissionSends()).toHaveLength(1);
    expect(admissionSends()[0]).toMatchObject({
      payload: {
        kind: "strava-backfill",
        data: { userId: user.id, slice: 1 },
      },
      options: { startAfter: 15 * 60 },
    });

    // A run that gets no further than the last records nothing and sends
    // nothing; the next boot offers the account again.
    strava.ignoreBefore = true;
    strava.requests = [];
    strava.sends = [];
    await expect(runStravaBackfillForUser(user.id, 1)).resolves.toEqual({
      imported: MAX_PAGES * PER_PAGE,
      continued: false,
    });
    stored = await storedUser(user.id);
    expect(stored.stravaBackfillResumeBefore).toEqual(resumeBefore);
    expect(stored.stravaBackfillCompletedAt).toBeNull();
    expect(admissionSends()).toEqual([]);

    // Strava honouring `before` again: the run reads the rest and finishes.
    strava.ignoreBefore = false;
    strava.requests = [];
    await expect(runStravaBackfillForUser(user.id, 1)).resolves.toEqual({
      imported: PER_PAGE + 1,
      continued: false,
    });
    expect(new Set(listRequests().map((q) => q.get("before")))).toEqual(
      new Set([String(resumeBefore.getTime() / 1000)]),
    );
    expect(listRequests()).toHaveLength(2);
    stored = await storedUser(user.id);
    expect(stored.stravaBackfillCompletedAt).toBeInstanceOf(Date);
    expect(stored.stravaBackfillResumeBefore).toBeNull();
    // The activity at the resume point was read twice and stored once.
    expect(await prisma.workout.count({ where: { userId: user.id } })).toBe(
      (MAX_PAGES + 1) * PER_PAGE,
    );
  });

  it("sends the next run after the window a rate limit named, keeping the page it read", async () => {
    const user = await connectedUser();
    history(5 * PER_PAGE);
    strava.listFailure = {
      page: 2,
      status: 429,
      headers: { "Retry-After": "5400" },
      body: { message: "Rate Limit Exceeded", errors: [] },
    };

    await expect(runStravaBackfillForUser(user.id)).resolves.toEqual({
      imported: PER_PAGE,
      continued: true,
    });

    const stored = await storedUser(user.id);
    // Newest first: page one held ids 500 down to 401.
    expect(stored.stravaBackfillResumeBefore).toEqual(
      new Date(T0 + 401 * HOUR + 1000),
    );
    expect(stored.stravaBackfillCompletedAt).toBeNull();
    // A newest-first walk cut short leaves older activities unread, so the
    // incremental cursor does not move.
    expect(stored.stravaLastActivityAt).toBeNull();
    expect(await prisma.workout.count({ where: { userId: user.id } })).toBe(
      PER_PAGE,
    );
    expect(admissionSends()).toHaveLength(1);
    expect(admissionSends()[0]?.options).toMatchObject({ startAfter: 5400 });
    expect(recentCalls(await ledger(user.id))[0]).toMatchObject({
      status: "transient",
      errorCode: "429",
    });
  });
});

describe("POST /api/strava/sync", () => {
  it("syncs the caller's account and answers with the count it wrote", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.activities = [1, 2, 3, 4].map((n) =>
      activity(n, CURSOR.getTime() + n * HOUR),
    );

    const res = await callRoute(syncRoute, {
      method: "POST",
      route: "/api/strava/sync",
      auth: await makeSession(user),
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      imported: 4,
      failed: false,
      outcome: "success",
    });
    expect(await stravaWorkouts(user.id)).toHaveLength(4);
  });

  it("refuses an anonymous caller before asking Strava anything", async () => {
    await connectedUser({ stravaLastActivityAt: CURSOR });

    const res = await callRoute(syncRoute, {
      method: "POST",
      route: "/api/strava/sync",
      auth: anonymous,
    });

    expect(res.status).toBe(401);
    expect(strava.requests).toEqual([]);
  });

  it("answers 502 without the upstream detail when the sync fails, with the failure on the ledger", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    strava.listFailure = {
      page: 1,
      status: 500,
      body: { message: "internal detail access-1", errors: [] },
    };

    const res = await callRoute(syncRoute, {
      method: "POST",
      route: "/api/strava/sync",
      auth: await makeSession(user),
    });

    expect(res.status).toBe(502);
    expect(res.error).toBe("Strava sync failed");
    expect(JSON.stringify(res.body)).not.toContain("access-1");
    expect((await ledger(user.id))?.state).toBe("error_transient");
  });

  it("refuses the sixth request in a minute without asking Strava", async () => {
    const user = await connectedUser({ stravaLastActivityAt: CURSOR });
    const auth = await makeSession(user);

    for (let i = 0; i < 5; i++) {
      const ok = await callRoute(syncRoute, {
        method: "POST",
        route: "/api/strava/sync",
        auth,
      });
      expect(ok.status).toBe(200);
    }
    strava.requests = [];
    const refused = await callRoute(syncRoute, {
      method: "POST",
      route: "/api/strava/sync",
      auth,
    });

    expect(refused.status).toBe(429);
    expect(refused.meta?.errorCode).toBe("rate_limited_self");
    expect(strava.requests).toEqual([]);
  });
});
