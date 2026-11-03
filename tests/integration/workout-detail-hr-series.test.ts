/**
 * Integration suite for the heart-rate curve on `GET /api/workouts/{id}`.
 *
 * The curve is the one part of the workout-detail envelope that is
 * assembled from rows the workout does not own: when a session carries no
 * stored sensor stream, the server reconstructs it from the account's raw
 * `PULSE` measurements around the session. Two boundaries decide whether
 * that reconstruction is honest, and neither is provable from a unit test
 * with a mocked Prisma:
 *
 *   - the WINDOW. A reading taken after the session ended is not part of
 *     the session. The query pads by five minutes so a boundary reading
 *     still lands in the first / last bucket, and the fold then clamps to
 *     the session itself — a pad reading must not extend the curve past
 *     the finish.
 *   - the OWNER. The measurement read is scoped to the calling account.
 *     Another account's pulse at the same wall-clock minute must not
 *     enter this curve.
 *
 * Both run through the real route against a real Postgres, and the
 * fixture places a reading on the far side of each boundary with a bpm
 * value no in-window reading has, so a leak is visible in the numbers
 * rather than only in a count.
 */
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_USER_ID = "user-workout-hr-series";
const OTHER_USER_ID = "user-workout-hr-series-other";

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

const { GET } = await import("@/app/api/workouts/[id]/route");

/**
 * Session window: 07:00 → 07:30 UTC ten days ago. The pulse-window fallback
 * only reconstructs a curve inside the dense-intraday retention horizon
 * (`DENSE_INTRADAY_RETENTION_DAYS`, 90 days), so the fixture day must stay
 * relative to the test run — a fixed calendar date silently aged past the
 * horizon and turned every curve assertion red on day 91.
 */
const SESSION_DAY = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const STARTED_AT = new Date(`${SESSION_DAY}T07:00:00.000Z`);
const ENDED_AT = new Date(`${SESSION_DAY}T07:30:00.000Z`);
const SPAN_SEC = 1800;

/**
 * In-window readings sit in this band; every out-of-window reading is
 * placed outside it, so an assertion on the curve's bpm bounds names any
 * leak directly.
 */
const IN_WINDOW_LOW = 120;
const IN_WINDOW_HIGH = 168;
/** After the finish but inside the query's five-minute pad. */
const PAD_TAIL_BPM = 44;
/** Well outside the padded window on either side. */
const FAR_BEFORE_BPM = 201;
const FAR_AFTER_BPM = 51;
/** Another account's reading in the middle of this session. */
const FOREIGN_BPM = 199;

interface HrSeriesPoint {
  tSec: number;
  mean: number;
  min: number;
  max: number;
}

interface WorkoutDetailBody {
  data: {
    id: string;
    hrSeries: {
      source: string;
      bucketSec: number;
      envelope: boolean;
      points: HrSeriesPoint[];
    } | null;
  } | null;
  error: string | null;
}

async function createUser(id: string, username: string) {
  await getPrismaClient().user.create({
    data: { id, username, email: `${username}@example.test` },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await createUser(TEST_USER_ID, "workout-hr-series");
  await createUser(OTHER_USER_ID, "workout-hr-series-other");
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

/**
 * The session under test, with no stored sample stream — so the route has
 * to reconstruct the curve from `PULSE` rows and the boundaries above are
 * the ones that decide what it sees.
 */
async function createWorkout(): Promise<string> {
  const row = await getPrismaClient().workout.create({
    data: {
      userId: TEST_USER_ID,
      sportType: "running",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      durationSec: SPAN_SEC,
      avgHeartRate: 144,
      maxHeartRate: IN_WINDOW_HIGH,
      source: "MANUAL",
    },
    select: { id: true },
  });
  return row.id;
}

function pulseRow(userId: string, offsetSec: number, value: number) {
  return {
    userId,
    type: "PULSE" as const,
    value,
    unit: "bpm",
    measuredAt: new Date(STARTED_AT.getTime() + offsetSec * 1000),
  };
}

/**
 * A dense in-window sweep plus one reading on the far side of each
 * boundary. The sweep alternates across the in-window band so the fold
 * has a real shape to carry.
 */
async function seedPulse() {
  const rows = [] as ReturnType<typeof pulseRow>[];
  for (let offset = 0; offset < SPAN_SEC; offset += 5) {
    const swing = Math.round(
      ((IN_WINDOW_HIGH - IN_WINDOW_LOW) / 2) *
        (1 + Math.sin((offset / SPAN_SEC) * Math.PI * 4)),
    );
    rows.push(pulseRow(TEST_USER_ID, offset, IN_WINDOW_LOW + swing));
  }
  // Two minutes after the finish: inside the query's pad, outside the
  // session. The query returns it; the curve must not.
  rows.push(pulseRow(TEST_USER_ID, SPAN_SEC + 120, PAD_TAIL_BPM));
  // Far outside the padded window on both sides.
  rows.push(pulseRow(TEST_USER_ID, -20 * 60, FAR_BEFORE_BPM));
  rows.push(pulseRow(TEST_USER_ID, SPAN_SEC + 15 * 60, FAR_AFTER_BPM));
  // Another account, mid-session.
  rows.push(pulseRow(OTHER_USER_ID, Math.floor(SPAN_SEC / 2), FOREIGN_BPM));
  await getPrismaClient().measurement.createMany({ data: rows });
}

async function fetchDetail(id: string): Promise<WorkoutDetailBody> {
  const request = new NextRequest(
    `http://localhost/api/workouts/${id}?compact=1`,
  );
  const response = await GET(request, { params: Promise.resolve({ id }) });
  return (await response.json()) as WorkoutDetailBody;
}

describe("GET /api/workouts/{id} — reconstructed heart-rate curve", () => {
  it("reconstructs the curve from the account's pulse readings", async () => {
    const id = await createWorkout();
    await seedPulse();

    const body = await fetchDetail(id);
    expect(body.error).toBeNull();
    const series = body.data?.hrSeries;
    expect(series).not.toBeNull();
    expect(series!.source).toBe("pulse_window");
    expect(series!.points.length).toBeGreaterThan(2);
  });

  it("stops the curve at the finish — a reading inside the query pad is not part of the session", async () => {
    const id = await createWorkout();
    await seedPulse();

    const series = (await fetchDetail(id)).data!.hrSeries!;
    const lastTSec = series.points[series.points.length - 1].tSec;
    expect(lastTSec).toBeLessThan(SPAN_SEC);
    // The pad reading is the only source of a sub-100 bpm value in the
    // fixture, so naming the value proves it stayed out rather than
    // merely proving a count.
    expect(series.points.map((p) => p.min)).not.toContain(PAD_TAIL_BPM);
    expect(Math.min(...series.points.map((p) => p.min))).toBeGreaterThanOrEqual(
      IN_WINDOW_LOW,
    );
  });

  it("keeps readings from outside the window and from other accounts out of the curve", async () => {
    const id = await createWorkout();
    await seedPulse();

    const series = (await fetchDetail(id)).data!.hrSeries!;
    const maxima = series.points.map((p) => p.max);
    expect(maxima).not.toContain(FAR_BEFORE_BPM);
    expect(maxima).not.toContain(FOREIGN_BPM);
    expect(series.points.map((p) => p.min)).not.toContain(FAR_AFTER_BPM);
    expect(Math.max(...maxima)).toBeLessThanOrEqual(IN_WINDOW_HIGH);
  });

  it("serves no curve when the account's readings do not cover the session", async () => {
    const id = await createWorkout();
    // A handful of opportunistic readings in the first minute. Enough
    // rows to clear the sample floor, nowhere near enough to describe a
    // half-hour session — the route says nothing rather than drawing a
    // curve out of a corner of it.
    await getPrismaClient().measurement.createMany({
      data: Array.from({ length: 12 }, (_, i) =>
        pulseRow(TEST_USER_ID, i * 4, 130 + i),
      ),
    });

    const body = await fetchDetail(id);
    expect(body.error).toBeNull();
    expect(body.data?.hrSeries).toBeNull();
  });

  it("does not reach the reconstruction at all for another account's workout", async () => {
    const foreign = await getPrismaClient().workout.create({
      data: {
        userId: OTHER_USER_ID,
        sportType: "running",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        durationSec: SPAN_SEC,
        source: "MANUAL",
      },
      select: { id: true },
    });
    await seedPulse();

    const request = new NextRequest(
      `http://localhost/api/workouts/${foreign.id}?compact=1`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: foreign.id }),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/workouts/{id} — a route whose track cannot be read", () => {
  it("reports no route at all instead of a route with a null geometry", async () => {
    const id = await createWorkout();
    // Neither the sealed column nor the legacy readable one holds a track:
    // the shape an unreadable or JSON-null row resolves to.
    await getPrismaClient().workoutRoute.create({
      data: { workoutId: id, geometry: Prisma.JsonNull },
    });
    const body = (await fetchDetail(id)) as unknown as {
      data: { route: unknown };
    };
    expect(body.data.route).toBeNull();
  });
});
