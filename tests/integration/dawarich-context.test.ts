/**
 * Dawarich movement context against real SQL and a stub Dawarich instance.
 *
 * A small HTTP server on the loopback interface answers the four endpoints
 * HealthLog reads (`/api/v1/users/me`, `/timeline`, `/visits`, `/residency`,
 * `/places`) with the documented shapes, including the coordinates and names
 * Dawarich sends along. The tests drive the shipped route exports and the
 * sync, and read the database afterwards:
 *
 *   - one day with timeline, visits and residency yields the expected values;
 *     a day without a visit has `awayFromHomeMinutes: null`, not zero;
 *   - no coordinate or place name lands anywhere in the stored rows;
 *   - a private instance without the operator's grant is refused (422
 *     `private_origin_not_approved`) and nothing is stored;
 *   - with the environment module off the routes answer 403 and the job
 *     sends no request;
 *   - travel days become a trip suggestion; accepting it through the trip
 *     route covers it; dismissing hides it;
 *   - disconnecting with `deleteData` empties the days.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = "user-dawarich";
const API_KEY = "dawarich-test-key";
const HOME = 7;

// ── The stub instance ─────────────────────────────────────────────────

const requests: string[] = [];
let server: Server;
let origin = "";

const VISITS = [
  // Home overnight into 2026-06-15 (Berlin day = 22:00Z on the 14th to 22:00Z).
  {
    id: 1,
    started_at: "2026-06-14T18:00:00Z",
    ended_at: "2026-06-15T06:00:00Z",
    status: "confirmed",
    name: "Home Sweet Home",
    place: { id: HOME, latitude: 52.52, longitude: 13.405 },
  },
  {
    id: 2,
    started_at: "2026-06-15T07:00:00Z",
    ended_at: "2026-06-15T15:00:00Z",
    status: "confirmed",
    name: "Office Tower",
    place: { id: 9, latitude: 41.3874, longitude: 2.1686 },
  },
  {
    id: 3,
    started_at: "2026-06-15T16:00:00Z",
    ended_at: "2026-06-16T05:00:00Z",
    status: "suggested",
    name: "Home Sweet Home",
    place: { id: HOME, latitude: 52.52, longitude: 13.405 },
  },
];

const TIMELINE_DAYS = [
  {
    date: "2026-06-15",
    summary: {
      total_distance: 48.3,
      distance_unit: "km",
      places_visited: 4,
      mode_distances: { train: 30.5, driving: 12, walking: 1.2 },
    },
    bounds: { sw_lat: 41.38, sw_lng: 2.16, ne_lat: 52.52, ne_lng: 13.4 },
    entries: [{ type: "visit", name: "Office Tower" }],
  },
  {
    date: "2026-06-17",
    summary: { total_distance: 3.4, places_visited: 1, mode_distances: {} },
  },
];

function residency(year: number) {
  if (year !== 2026) return { year, daily_countries: {}, countries: [] };
  const daily: Record<string, string> = {};
  for (let d = 1; d <= 20; d++) {
    daily[`2026-05-${String(d).padStart(2, "0")}`] = "Germany";
  }
  daily["2026-06-15"] = "Spain";
  daily["2026-06-16"] = "Spain";
  daily["2026-06-17"] = "Spain";
  return {
    year,
    daily_countries: daily,
    countries: [
      { country_name: "Germany", iso_a2: "DE", days: 20 },
      { country_name: "Spain", iso_a2: "ES", days: 3 },
    ],
  };
}

/** A timeline that answers from the window, set by the test that needs it. */
let timelineAnswer: ((url: URL) => { status: number; body: unknown }) | null =
  null;

function answer(req: IncomingMessage): { status: number; body: unknown } {
  const url = new URL(req.url ?? "/", "http://stub");
  requests.push(url.pathname);
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  switch (url.pathname) {
    case "/api/v1/users/me":
      return { status: 200, body: { email: "someone@example.test" } };
    case "/api/v1/timeline":
      if (timelineAnswer) return timelineAnswer(url);
      return { status: 200, body: { days: TIMELINE_DAYS } };
    case "/api/v1/visits":
      return { status: 200, body: VISITS };
    case "/api/v1/residency":
      return {
        status: 200,
        body: residency(Number(url.searchParams.get("year"))),
      };
    case "/api/v1/places":
      return {
        status: 200,
        body: [
          { id: HOME, name: "Home Sweet Home", latitude: 52.52 },
          { id: 9, name: "Office Tower", latitude: 41.3874 },
        ],
      };
    case `/api/v1/places/${HOME}`:
      return { status: 200, body: { id: HOME, name: "Home Sweet Home" } };
    default:
      return { status: 404, body: { error: "not found" } };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const { status, body } = answer(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Fixtures ──────────────────────────────────────────────────────────

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  requests.length = 0;
  timelineAnswer = null;
  process.env.DAWARICH_PRIVATE_ORIGINS = origin;
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "dawarich-user",
      email: "dawarich@example.test",
      timezone: "Europe/Berlin",
      modulePreferencesJson: { environment: true },
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

function json(url: string, body: unknown, method = "POST") {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function connect(url = origin, apiKey = API_KEY) {
  const { POST } = await import("@/app/api/dawarich/connect/route");
  return POST(json("/api/dawarich/connect", { url, apiKey }));
}

async function setHome() {
  const { PATCH } = await import("@/app/api/dawarich/settings/route");
  return PATCH(json("/api/dawarich/settings", { homePlaceId: HOME }, "PATCH"));
}

async function syncFixedRange() {
  const { syncDawarichRange } = await import("@/lib/dawarich/sync");
  return syncDawarichRange(USER_ID, "2026-06-14", "2026-06-17");
}

async function storedDays() {
  return getPrismaClient().dawarichDay.findMany({
    where: { userId: USER_ID },
    orderBy: { date: "asc" },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Dawarich daily values", () => {
  it("turns one day of timeline, visits and residency into the expected values", async () => {
    expect((await connect()).status).toBe(200);
    expect((await setHome()).status).toBe(200);
    const result = await syncFixedRange();
    // 06-14 has the overnight home visit only; 06-15..06-17 hold values.
    expect(result.daysStored).toBe(4);

    const days = await storedDays();
    const byDate = new Map(days.map((d) => [d.date, d]));
    const june15 = byDate.get("2026-06-15")!;
    expect(june15).toMatchObject({
      totalDistanceM: 48_300,
      drivingDistanceM: 12_000,
      trainDistanceM: 30_500,
      placesVisited: 4,
      // 24 h minus 8 h (overnight) and 6 h (evening) at home.
      awayFromHomeMinutes: 600,
      isTravelDay: true,
    });
    // No visit touches 06-17: no coverage, not zero minutes.
    expect(byDate.get("2026-06-17")!.awayFromHomeMinutes).toBeNull();
    expect(byDate.get("2026-06-17")!.totalDistanceM).toBe(3_400);

    const { openDayCountry } = await import("@/lib/dawarich/connection");
    expect(openDayCountry(june15.countryCodeEncrypted)).toBe("ES");

    // The home country was derived from a year of residency.
    const { GET } = await import("@/app/api/dawarich/status/route");
    const status = await (await GET()).json();
    expect(status.data).toMatchObject({
      connected: true,
      homePlaceSet: true,
      homeCountry: "DE",
      daysStored: 4,
      oldestDay: "2026-06-14",
      latestDay: "2026-06-17",
    });
    expect(status.data.health).not.toBeNull();
  });

  it("stores no coordinate and no place name anywhere", async () => {
    await connect();
    await setHome();
    const { GET: places } = await import("@/app/api/dawarich/places/route");
    const listed = await (
      await places(new NextRequest("http://localhost/api/dawarich/places"))
    ).json();
    expect(listed.data.places.map((p: { name: string }) => p.name)).toEqual([
      "Home Sweet Home",
      "Office Tower",
    ]);
    await syncFixedRange();

    const prisma = getPrismaClient();
    const rows = await prisma.$queryRaw<Array<{ row: string }>>`
      SELECT row_to_json(d)::text AS "row" FROM "dawarich_days" d
      UNION ALL
      SELECT row_to_json(u)::text FROM "users" u
      UNION ALL
      SELECT row_to_json(s)::text FROM "integration_statuses" s
    `;
    // Clock times go first: a timestamp written at :52.52x seconds holds the
    // latitude's digits and failed the check without any coordinate stored.
    const dump = rows
      .map((r) => r.row)
      .join("\n")
      .replace(/\d{2}:\d{2}:\d{2}\.\d+/g, "<time>");
    for (const leak of [
      "Home Sweet",
      "Office Tower",
      "52.52",
      "41.38",
      "13.405",
    ]) {
      expect(dump, leak).not.toContain(leak);
    }
    const { openDawarichPrefs } = await import("@/lib/dawarich/connection");
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: USER_ID },
      select: { dawarichPrefsEncrypted: true },
    });
    expect(
      Object.keys(openDawarichPrefs(user.dawarichPrefsEncrypted)).sort(),
    ).toEqual([
      "derivedHomeCountry",
      "dismissedSuggestionIds",
      "homeCountry",
      "homePlaceId",
    ]);
  });

  it("carries the movement block on the owner's day, without places", async () => {
    await connect();
    await setHome();
    await syncFixedRange();
    const { GET } = await import("@/app/api/day/[date]/route");
    const res = await GET(new Request("http://localhost/api/day/2026-06-15"), {
      params: Promise.resolve({ date: "2026-06-15" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.movement).toMatchObject({
      source: "dawarich",
      distance: { unit: "km", total: 48.3, driving: 12, train: 30.5 },
      placesVisited: 4,
      awayFromHomeMinutes: 600,
      travel: { isTravelDay: true, countryCode: "ES" },
    });
  });
});

describe("Dawarich refusals", () => {
  it("refuses a private instance the operator did not list, and stores nothing", async () => {
    delete process.env.DAWARICH_PRIVATE_ORIGINS;
    const res = await connect();
    expect(res.status).toBe(422);
    expect((await res.json()).meta.errorCode).toBe(
      "private_origin_not_approved",
    );
    expect(requests).toEqual([]);
    const user = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: USER_ID },
      select: { dawarichUrlEncrypted: true },
    });
    expect(user.dawarichUrlEncrypted).toBeNull();
  });

  it("refuses a key the instance does not accept", async () => {
    const res = await connect(origin, "wrong-key");
    expect(res.status).toBe(422);
    expect((await res.json()).meta.errorCode).toBe(
      "dawarich.credentials_rejected",
    );
  });

  it("answers 403 and fetches nothing with the environment module off", async () => {
    await connect();
    requests.length = 0;
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { modulePreferencesJson: { environment: false } },
    });

    const { GET } = await import("@/app/api/dawarich/status/route");
    expect((await GET()).status).toBe(403);
    const { POST: sync } = await import("@/app/api/dawarich/sync/route");
    expect((await sync(json("/api/dawarich/sync", {}))).status).toBe(403);

    const { handleDawarichSync } = await import("@/lib/jobs/dawarich-sync");
    const boss = { send: vi.fn() };
    const discovery = await handleDawarichSync(boss as never, [
      { data: {} } as never,
    ]);
    expect(discovery.ok).toBe(true);
    expect(boss.send).not.toHaveBeenCalled();
    const run = await handleDawarichSync(boss as never, [
      { data: { userId: USER_ID } } as never,
    ]);
    expect(run.ok).toBe(true);
    expect(requests).toEqual([]);

    // The control: with the module on, the same run does reach the instance.
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { modulePreferencesJson: { environment: true } },
    });
    await handleDawarichSync(boss as never, [
      { data: { userId: USER_ID } } as never,
    ]);
    expect(requests).toContain("/api/v1/timeline");
  });

  it("records a failed fetch on the ledger as a short code", async () => {
    await connect();
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: {
        dawarichApiKeyEncrypted: (await import("@/lib/crypto")).encrypt(
          "revoked",
        ),
      },
    });
    await expect(syncFixedRange()).rejects.toThrow();
    const ledger = await getPrismaClient().integrationStatus.findUniqueOrThrow({
      where: {
        userId_integration: { userId: USER_ID, integration: "dawarich" },
      },
    });
    expect(ledger.state).toBe("error_reauth");
    expect(JSON.stringify(ledger.recentCalls)).toContain('"401"');
    expect(JSON.stringify(ledger.recentCalls)).not.toContain("127.0.0.1");
  });
});

describe("Travel suggestions", () => {
  async function suggestions() {
    const { GET } =
      await import("@/app/api/environment/travel/suggestions/route");
    return (await (await GET()).json()).data.suggestions as Array<{
      id: string;
      startDate: string;
      endDate: string;
      countryCode: string;
    }>;
  }

  it("suggests the run of travel days, and accepting it as a trip covers it", async () => {
    await connect();
    await setHome();
    await syncFixedRange();
    const open = await suggestions();
    expect(open).toEqual([
      {
        id: "2026-06-15_2026-06-17_ES",
        startDate: "2026-06-15",
        endDate: "2026-06-17",
        countryCode: "ES",
      },
    ]);

    const { POST } = await import("@/app/api/environment/travel/route");
    const trip = await POST(
      json("/api/environment/travel", {
        startDate: "2026-06-15",
        endDate: "2026-06-17",
        lat: 41.39,
        lon: 2.17,
        label: "Barcelona",
      }),
    );
    expect(trip.status).toBeLessThan(300);
    expect(await suggestions()).toEqual([]);
    // The trip is what the weather fetch reads for those days.
    const stored = await getPrismaClient().environmentTravelLocation.findMany({
      where: { userId: USER_ID },
    });
    expect(stored).toHaveLength(1);
  });

  it("dismisses a suggestion for good and refuses an unknown one", async () => {
    await connect();
    await setHome();
    await syncFixedRange();
    const [first] = await suggestions();
    const { POST } =
      await import("@/app/api/environment/travel/suggestions/[id]/dismiss/route");
    const dismiss = (id: string) =>
      POST(
        new NextRequest(
          `http://localhost/api/environment/travel/suggestions/${id}/dismiss`,
          { method: "POST" },
        ),
        { params: Promise.resolve({ id }) },
      );
    expect((await dismiss(first.id)).status).toBe(200);
    expect(await suggestions()).toEqual([]);
    const unknown = await dismiss("2020-01-01_2020-01-02_FR");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).meta.errorCode).toBe(
      "environment.travel_suggestion.not_found",
    );
  });
});

describe("Disconnect", () => {
  it("keeps the days by default and deletes them on request", async () => {
    await connect();
    await setHome();
    await syncFixedRange();
    const { POST } = await import("@/app/api/dawarich/disconnect/route");

    const kept = await (
      await POST(json("/api/dawarich/disconnect", {}))
    ).json();
    expect(kept.data).toEqual({ disconnected: true, deletedDays: 0 });
    expect(await storedDays()).toHaveLength(4);

    const gone = await (
      await POST(json("/api/dawarich/disconnect", { deleteData: true }))
    ).json();
    expect(gone.data).toEqual({ disconnected: true, deletedDays: 4 });
    expect(await storedDays()).toHaveLength(0);
  });
});

describe("Timeline days across a request boundary", () => {
  /**
   * The instance as Dawarich builds a timeline (`Timeline::DayAssembler`):
   * days in the Dawarich account's own zone, here New York while the
   * HealthLog account is in Berlin, and only what lies inside the requested
   * window is summed, so a window cut at Berlin midnight answers the New
   * York day it cuts with a fragment. Every New York day holds a 1 km trip
   * at 02:00 and a 10 km trip at 20:00 (02:00 the next morning in Berlin),
   * so a complete day is 11 km and a fragment 1 or 10. A window longer than
   * 31 days is refused as the instance refuses it.
   */
  const INSTANCE_TZ = "America/New_York";
  const nyDate = (ms: number) =>
    new Date(ms).toLocaleDateString("en-CA", { timeZone: INSTANCE_TZ });
  const nyInstant = (date: string, hour: number) => {
    // New York is UTC-4 for the whole summer range this test reads.
    return Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00-04:00`);
  };
  function instanceTimeline(url: URL) {
    const startMs = Date.parse(url.searchParams.get("start_at") ?? "");
    const endMs = Date.parse(url.searchParams.get("end_at") ?? "");
    if (endMs - startMs > 31 * 24 * 3_600_000) {
      return { status: 400, body: { error: "range too large" } };
    }
    const totals = new Map<string, number>();
    const from = new Date(startMs - 2 * 86_400_000);
    for (let d = from.getTime(); d <= endMs + 86_400_000; d += 86_400_000) {
      const date = nyDate(d);
      for (const [hour, km] of [
        [2, 1],
        [20, 10],
      ] as const) {
        const at = nyInstant(date, hour);
        if (at < startMs || at > endMs) continue;
        totals.set(date, (totals.get(date) ?? 0) + km);
      }
    }
    return {
      status: 200,
      body: {
        days: [...totals].map(([date, km]) => ({
          date,
          summary: {
            total_distance: km,
            places_visited: 0,
            mode_distances: {},
          },
        })),
      },
    };
  }

  it("never lets a boundary fragment overwrite a complete day", async () => {
    timelineAnswer = instanceTimeline;
    expect((await connect()).status).toBe(200);
    await getPrismaClient().dawarichDay.deleteMany({});

    const { syncDawarichRange } = await import("@/lib/dawarich/sync");
    // Sixty days: three timeline requests, two boundaries between them.
    await syncDawarichRange(USER_ID, "2026-06-01", "2026-07-30");

    const days = await storedDays();
    expect(days).toHaveLength(60);
    const wrong = days
      .filter((d) => d.totalDistanceM !== 11_000)
      .map((d) => `${d.date}=${d.totalDistanceM}`);
    expect(wrong).toEqual([]);
  });
});
