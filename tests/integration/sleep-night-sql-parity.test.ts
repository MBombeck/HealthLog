/**
 * The sleep list pages its nights in SQL (`sleepNightPage`) and fills them
 * from the JS reconstruction (`reconstructSleepSessions`). The two cut the
 * same stage rows into sessions and name each session's night by the same
 * rule, or the list drops, doubles or mislabels nights. This suite runs both
 * over one fixture set of awkward shapes and holds them to the same nights,
 * then holds the list, the night view and the series to one answer per day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Stage = "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP" | null;

interface Seg {
  /** Segment end, minutes after the fixture day's UTC midnight. */
  end: number;
  minutes: number;
  stage: Stage;
  source?: "APPLE_HEALTH" | "WHOOP" | "WITHINGS";
  deviceType?: string | null;
}

const H = 60;

/** A run of contiguous segments of `step` minutes cycling through stages. */
function run(
  start: number,
  end: number,
  step: number,
  stages: Stage[],
  extra: Partial<Seg> = {},
): Seg[] {
  const out: Seg[] = [];
  let i = 0;
  for (let t = start + step; t <= end; t += step) {
    out.push({
      end: t,
      minutes: step,
      stage: stages[i % stages.length],
      ...extra,
    });
    i += 1;
  }
  return out;
}

const NIGHT: Stage[] = ["CORE", "DEEP", "CORE", "REM", "AWAKE"];

/**
 * Ten shapes, one per day modulo ten, minutes relative to the day's UTC
 * midnight (negative = the evening before).
 */
function shape(i: number): Seg[] {
  switch (i % 10) {
    case 0:
      // A dense watch night in five-minute segments.
      return run(-1 * H, 7 * H, 5, NIGHT, { deviceType: "watch" });
    case 1:
      // The watch stops before midnight, the phone's in-bed runs past it.
      return [
        ...run(-6 * H, -10, 10, NIGHT, { deviceType: "watch" }),
        { end: 20, minutes: 6 * H + 20, stage: "IN_BED", deviceType: "phone" },
      ];
    case 2:
      // An afternoon nap and no night.
      return run(13 * H, 14 * H, 15, ["CORE", "REM"]);
    case 3:
      // A night and a nap.
      return [
        ...run(-2 * H, 6 * H, 30, NIGHT),
        ...run(14 * H, 14 * H + 40, 20, ["CORE"]),
      ];
    case 4:
      // A split night, three and a half hours apart: two sessions.
      return [
        ...run(-2 * H, 1 * H, 30, NIGHT),
        ...run(4 * H + 30, 7 * H, 30, NIGHT),
      ];
    case 5:
      // Exactly the session gap apart: one session.
      return [
        ...run(-2 * H, 1 * H, 30, NIGHT),
        ...run(4 * H, 7 * H, 30, NIGHT),
      ];
    case 6:
      // One long stage block.
      return [
        { end: 3 * H, minutes: 4 * H, stage: "CORE" },
        { end: 5 * H, minutes: 2 * H, stage: "REM" },
      ];
    case 7:
      // A bare aggregate with its granular twin, and a zero-minute granular
      // row from a second writer beside a bare night.
      return [
        { end: 6 * H, minutes: 7 * H, stage: "ASLEEP" },
        ...run(-1 * H, 6 * H, 60, ["CORE", "DEEP", "REM"]),
        { end: 6 * H, minutes: 0, stage: "REM", source: "WITHINGS" },
        { end: 6 * H, minutes: 6 * H, stage: "ASLEEP", source: "WITHINGS" },
      ];
    case 8:
      // An in-bed-only evening and a stage-less night.
      return [
        { end: -8 * H, minutes: 40, stage: "IN_BED" },
        { end: -8 * H + 30, minutes: 20, stage: "AWAKE" },
        { end: 6 * H, minutes: 6 * H, stage: null },
      ];
    default:
      // A summary-shaped writer (every stage on one instant) beside a
      // partial timed night.
      return [
        { end: 7 * H, minutes: 200, stage: "CORE", source: "WHOOP" },
        { end: 7 * H, minutes: 90, stage: "DEEP", source: "WHOOP" },
        { end: 7 * H, minutes: 80, stage: "REM", source: "WHOOP" },
        ...run(2 * H, 7 * H, 30, NIGHT),
      ];
  }
}

const BASE = Date.UTC(2024, 2, 1); // three years back, across two DST turns
const DAYS = 120;

async function seed(timezone: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `parity-${timezone.replace("/", "-")}`.toLowerCase(),
      email: `parity-${timezone.length}@example.test`,
      role: "USER",
      timezone,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const rows = [];
  for (let d = 0; d < DAYS; d++) {
    const midnight = BASE + d * 86_400_000;
    for (const [k, seg] of shape(d).entries()) {
      rows.push({
        userId: user.id,
        type: "SLEEP_DURATION" as const,
        value: seg.minutes,
        unit: "minutes",
        source: seg.source ?? ("APPLE_HEALTH" as const),
        deviceType: seg.deviceType ?? null,
        measuredAt: new Date(midnight + seg.end * 60_000),
        externalId: `p-${d}-${k}`,
        sleepStage: seg.stage,
      });
    }
  }
  await prisma.measurement.createMany({ data: rows });
  return user;
}

interface ListRow {
  dayKey: string;
  value: number;
  mainAsleepMinutes: number | null;
  napCount: number;
  napAsleepMinutes: number;
}

async function list(query: string) {
  const { GET } = await import("@/app/api/measurements/route");
  const res = await GET(
    new NextRequest(`http://localhost/api/measurements?${query}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    data: { measurements: ListRow[]; meta: { total: number } };
  };
}

async function nightView(date: string) {
  const { GET } = await import("@/app/api/sleep/night/route");
  const res = await GET(
    new NextRequest(`http://localhost/api/sleep/night?date=${date}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    data: {
      night: string | null;
      main: { asleepMinutes: number } | null;
      naps: Array<{ asleepMinutes: number }>;
    };
  };
}

describe("sleep nights: SQL page and JS reconstruction agree", () => {
  for (const tz of ["UTC", "Europe/Berlin"]) {
    it(`names the same nights over every shape (${tz})`, async () => {
      const user = await seed(tz);
      const { sleepNightPage, readSleepRows } =
        await import("@/lib/measurements/list/sleep-nights");
      const { reconstructSleepSessions } =
        await import("@/lib/analytics/sleep-night");
      const page = await sleepNightPage(user.id, tz, {
        sortDir: "asc",
        limit: 10_000,
        offset: 0,
      });
      const rows = await readSleepRows(
        user.id,
        new Date(BASE - 2 * 86_400_000),
        new Date(BASE + (DAYS + 2) * 86_400_000),
      );
      const scorable = reconstructSleepSessions(rows, tz, null).filter(
        (s) => s.asleepMinutes > 0,
      );
      const jsNights = [...new Set(scorable.map((s) => s.night))].sort();
      expect(page.nights.map((n) => n.night)).toEqual(jsNights);
      expect(page.total).toBe(jsNights.length);
      // Every reconstructed session of a page night lies inside the night's
      // SQL span, the in-bed-only ones included: the reconstruction adds
      // their in-bed time to the night, so a chunked read must reach them.
      const span = new Map(page.nights.map((n) => [n.night, n]));
      const sessions = reconstructSleepSessions(rows, tz, null).filter((s) =>
        span.has(s.night),
      );
      expect(sessions.length).toBeGreaterThan(scorable.length);
      for (const s of sessions) {
        const n = span.get(s.night)!;
        expect(s.start.getTime()).toBeGreaterThanOrEqual(
          n.spanStart.getTime() - 1000,
        );
        expect(s.end.getTime()).toBeLessThanOrEqual(n.spanEnd.getTime() + 1000);
      }
    }, 240_000);

    it(`reads the same in-bed time a night at a time and in chunks (${tz})`, async () => {
      const user = await seed(tz);
      const { readSleepNights, readSleepRows } =
        await import("@/lib/measurements/list/sleep-nights");
      const { reconstructSleepNights } =
        await import("@/lib/analytics/sleep-night");
      const chunked = await readSleepNights(user.id, tz, null, {
        maxNights: 10_000,
      });
      const whole = new Map(
        reconstructSleepNights(
          await readSleepRows(
            user.id,
            new Date(BASE - 2 * 86_400_000),
            new Date(BASE + (DAYS + 2) * 86_400_000),
          ),
          tz,
          null,
        ).map((n) => [n.night, n]),
      );
      expect(chunked.length).toBeGreaterThan(DAYS - 2);
      for (const night of chunked) {
        const ref = whole.get(night.night)!;
        expect(night.inBedMinutes).toBe(ref.inBedMinutes);
        expect(night.asleepMinutes).toBe(ref.asleepMinutes);
      }
    }, 240_000);
  }

  it("gives every page night a row the night view answers for the same day", async () => {
    await seed("Europe/Berlin");
    const first = await list("type=SLEEP_DURATION&limit=7&sortDir=asc");
    const total = first.data.meta.total;
    const rows: ListRow[] = [];
    for (let offset = 0; offset < total; offset += 7) {
      const page = await list(
        `type=SLEEP_DURATION&limit=7&offset=${offset}&sortDir=asc`,
      );
      // No short page before the last one.
      expect(page.data.measurements).toHaveLength(Math.min(7, total - offset));
      rows.push(...page.data.measurements);
    }
    expect(rows).toHaveLength(total);
    let napOnly = 0;
    for (const row of rows) {
      const view = await nightView(row.dayKey);
      expect(view.data.night).toBe(row.dayKey);
      // The row's value is the day's sleep, main night plus naps; the main
      // night alone rides beside it.
      const napMinutes = view.data.naps.reduce(
        (sum, n) => sum + n.asleepMinutes,
        0,
      );
      expect(row.value).toBe(
        Math.round((view.data.main?.asleepMinutes ?? 0) + napMinutes),
      );
      expect(row.mainAsleepMinutes).toBe(
        view.data.main ? Math.round(view.data.main.asleepMinutes) : null,
      );
      expect(view.data.naps).toHaveLength(row.napCount);
      if (row.napCount > 0) expect(row.value).toBeGreaterThan(0);
      if (!view.data.main) {
        napOnly += 1;
        expect(row.napCount).toBeGreaterThan(0);
      }
    }
    // The afternoon-nap days have no main night and still have their row.
    expect(napOnly).toBe(DAYS / 10);
  }, 480_000);

  it("states the same day total in the list and the series", async () => {
    await seed("Europe/Berlin");
    const { GET } = await import("@/app/api/measurements/series/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/measurements/series?kind=sleep&days=3650",
      ),
    );
    expect(res.status).toBe(200);
    const series = (
      (await res.json()) as {
        data: { points: Array<{ id: string; value: number }> };
      }
    ).data.points;
    const rows = (await list("type=SLEEP_DURATION&limit=1000&sortDir=asc")).data
      .measurements;
    const byDay = new Map(series.map((p) => [p.id.slice("sleep:".length), p]));
    let napDays = 0;
    for (const row of rows) {
      const point = byDay.get(row.dayKey);
      expect(point, row.dayKey).toBeDefined();
      // Hours to two places against whole minutes: within a minute.
      expect(Math.abs(point!.value * 60 - row.value)).toBeLessThanOrEqual(1);
      if (row.napCount > 0) napDays += 1;
    }
    expect(napDays).toBeGreaterThan(0);
  }, 240_000);

  it("answers the latest main night, not a later day of naps alone", async () => {
    const user = await seed("UTC");
    const prisma = getPrismaClient();
    // Two afternoon naps on the two days after the last fixture day.
    const after = BASE + DAYS * 86_400_000;
    await prisma.measurement.createMany({
      data: [0, 1].map((d) => ({
        userId: user.id,
        type: "SLEEP_DURATION" as const,
        value: 40,
        unit: "minutes",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(after + d * 86_400_000 + 14 * 3_600_000),
        externalId: `late-nap-${d}`,
        sleepStage: "CORE" as const,
      })),
    });
    const { GET } = await import("@/app/api/sleep/night/route");
    const res = await GET(new NextRequest("http://localhost/api/sleep/night"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { night: string; main: unknown; naps: unknown[] };
    };
    expect(body.data.main).not.toBeNull();
    // The answer is a fixture night, before the naps.
    expect(body.data.night < new Date(after).toISOString().slice(0, 10)).toBe(
      true,
    );
    // The nap days stay reachable by date.
    const napDay = new Date(after + 86_400_000).toISOString().slice(0, 10);
    const nap = await nightView(napDay);
    expect(nap.data.main).toBeNull();
    expect(nap.data.naps).toHaveLength(1);
  }, 240_000);

  it("reaches the oldest night from the series' All range", async () => {
    await seed("Europe/Berlin");
    const { GET } = await import("@/app/api/measurements/series/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/measurements/series?kind=sleep&days=3650",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { points: Array<{ id: string }> };
    };
    const oldest = (await list("type=SLEEP_DURATION&limit=1&sortDir=asc")).data
      .measurements[0].dayKey;
    // Years old, past any one-year cut.
    expect(body.data.points[0].id).toBe(`sleep:${oldest}`);
    expect(oldest < "2024-03-03").toBe(true);
  }, 240_000);
});
