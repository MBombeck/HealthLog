/**
 * v1.42 — `GET /api/insights/score-history` against real Postgres.
 *
 * What the unit tests cannot show: that each score's points land on the day
 * the day view shows the same score for (the readiness row stamped the day
 * before its wake day, the sleep score of the night that ended that morning),
 * that the health score's line breaks where the recipe changed, that the
 * window, the module gate, the record standing and the query limits hold.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { userDayKey } from "@/lib/tz/format";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

interface History {
  score: string;
  days: number;
  points: Array<{ day: string; value: number; seamBreak: boolean }>;
  band: { lo: number; hi: number; n: number } | null;
}

const TZ = "Europe/Berlin";
const shift = (key: string, days: number) =>
  new Date(Date.parse(`${key}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

let counter = 0;

async function makeUser(label: string, modules: Record<string, boolean> = {}) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `sh-${suffix}`,
      email: `sh-${suffix}@example.test`,
      role: "USER",
      timezone: TZ,
      locale: "en",
      modulePreferencesJson: modules,
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

async function history(query: string): Promise<Response> {
  const { GET } = await import("@/app/api/insights/score-history/route");
  return (GET as Handler)(
    new NextRequest(`http://localhost/api/insights/score-history?${query}`),
    { params: Promise.resolve({}) },
  );
}

async function json<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

async function dayScores(date: string) {
  const { GET } = await import("@/app/api/day/[date]/route");
  const response = await (GET as Handler)(
    new NextRequest(`http://localhost/api/day/${date}`),
    { params: Promise.resolve({ date }) },
  );
  const day = await json<import("@/lib/day/contract").DayResponse>(response);
  return Object.fromEntries(day.scores.map((s) => [s.key, s]));
}

async function seedHealthScore(
  userId: string,
  key: string,
  composite: number,
  configVersion: number | null = 1,
) {
  await getPrismaClient().healthScoreRecord.create({
    data: {
      userId,
      dayKey: key,
      timezone: TZ,
      composite,
      band: "green",
      scoreVersion: 1,
      composition: ["sleep"],
      pillarScores: { sleep: composite },
      inputFingerprint: "a".repeat(64),
      configVersion,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("GET /api/insights/score-history", () => {
  it("serves the health score's stored days inside the window, oldest first", async () => {
    const owner = await makeUser("health");
    const today = userDayKey(new Date(), TZ);
    // Forty days, one without a row.
    for (let i = 39; i >= 0; i -= 1) {
      if (i === 3) continue;
      await seedHealthScore(owner.id, shift(today, -i), 60 + (i % 5));
    }
    await signIn(owner.id);

    const response = await history("score=HEALTH_SCORE&days=7");
    expect(response.status).toBe(200);
    const body = await json<History>(response);
    expect(body.score).toBe("HEALTH_SCORE");
    expect(body.days).toBe(7);
    expect(body.points.map((p) => p.day)).toEqual(
      [6, 5, 4, 2, 1, 0].map((i) => shift(today, -i)),
    );
    expect(body.points.at(-1)?.value).toBe(60);
    expect(body.points.every((p) => !p.seamBreak)).toBe(true);
    // The usual range reads the thirty days before the newest point, even on
    // a seven-day window.
    expect(body.band?.n).toBe(29);

    const all = await json<History>(
      await history("score=HEALTH_SCORE&days=3650"),
    );
    expect(all.points).toHaveLength(39);
  });

  it("breaks the health score's line where the recipe changed, and forms the range on the newest side", async () => {
    const owner = await makeUser("seam");
    const today = userDayKey(new Date(), TZ);
    for (let i = 20; i >= 0; i -= 1) {
      // Version 1 until nine days ago, version 2 from then on.
      await seedHealthScore(
        owner.id,
        shift(today, -i),
        i > 9 ? 40 : 80,
        i > 9 ? 1 : 2,
      );
    }
    await signIn(owner.id);

    const body = await json<History>(
      await history("score=HEALTH_SCORE&days=30"),
    );
    const seams = body.points.filter((p) => p.seamBreak).map((p) => p.day);
    expect(seams).toEqual([shift(today, -9)]);
    // Only the version-2 days stand behind the newest point: nine of them.
    expect(body.band).toEqual({ lo: 79, hi: 81, n: 9 });

    // A window that starts on the seam opens no seam of its own.
    const short = await json<History>(
      await history("score=HEALTH_SCORE&days=10"),
    );
    expect(short.points[0]).toMatchObject({
      day: shift(today, -9),
      seamBreak: false,
    });
  });

  it("files readiness on the wake day, as the day view does, and leaves a device's recovery out", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("readiness");
    const today = userDayKey(new Date(), TZ);
    for (let i = 12; i >= 0; i -= 1) {
      const key = shift(today, -i);
      // The nightly proxy is stamped at noon UTC of the day that ended.
      await db.measurement.create({
        data: {
          userId: owner.id,
          type: "RECOVERY_SCORE",
          value: 70 + (i % 4),
          unit: "score",
          source: "COMPUTED",
          measuredAt: new Date(`${shift(key, -1)}T12:00:00.000Z`),
        },
      });
    }
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "RECOVERY_SCORE",
        value: 12,
        unit: "score",
        source: "WHOOP",
        measuredAt: new Date(`${shift(today, -2)}T06:30:00.000Z`),
      },
    });
    await signIn(owner.id);

    const body = await json<History>(await history("score=READINESS&days=7"));
    expect(body.points.map((p) => p.day)).toEqual(
      [6, 5, 4, 3, 2, 1, 0].map((i) => shift(today, -i)),
    );
    expect(body.points.map((p) => p.value)).not.toContain(12);

    const target = shift(today, -2);
    const scores = await dayScores(target);
    expect(body.points.find((p) => p.day === target)?.value).toBe(
      scores.readiness?.value,
    );
  });

  it("gives the sleep score of each night the value the day view shows for its morning", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("sleep");
    const today = userDayKey(new Date(), TZ);
    for (let i = 14; i >= 1; i -= 1) {
      const key = shift(today, -i);
      await db.measurement.create({
        data: {
          userId: owner.id,
          type: "SLEEP_DURATION",
          value: 400 + (i % 4) * 20,
          unit: "min",
          sleepStage: "ASLEEP",
          source: "APPLE_HEALTH",
          // 01:00 to about 08:00 local, ending on the morning of `key`.
          measuredAt: new Date(`${key}T05:00:00.000Z`),
        },
      });
    }
    await signIn(owner.id);

    const body = await json<History>(
      await history("score=SLEEP_SCORE&days=30"),
    );
    expect(body.points.length).toBeGreaterThanOrEqual(10);
    for (const point of body.points) {
      expect(point.value).toBeGreaterThan(0);
      expect(point.value).toBeLessThanOrEqual(100);
    }
    for (const offset of [1, 5]) {
      const target = shift(today, -offset);
      const scores = await dayScores(target);
      expect(body.points.find((p) => p.day === target)?.value).toBe(
        scores.sleepScore?.value,
      );
    }
  });

  it("refuses readiness and the sleep score when their module is off, never the health score", async () => {
    const owner = await makeUser("modules", { recovery: false, sleep: false });
    await signIn(owner.id);
    expect((await history("score=READINESS&days=30")).status).toBe(403);
    expect((await history("score=SLEEP_SCORE&days=30")).status).toBe(403);
    expect((await history("score=HEALTH_SCORE&days=30")).status).toBe(200);
  });

  it("answers an empty record with no points and no range", async () => {
    const owner = await makeUser("empty");
    await signIn(owner.id);
    const body = await json<History>(
      await history("score=HEALTH_SCORE&days=90"),
    );
    expect(body).toEqual({
      score: "HEALTH_SCORE",
      days: 90,
      points: [],
      band: null,
    });
  });

  it("rejects an unknown score and a window out of range", async () => {
    const owner = await makeUser("invalid");
    await signIn(owner.id);
    for (const query of [
      "score=STRESS_SCORE&days=30",
      "score=HEALTH_SCORE&days=0",
      "score=HEALTH_SCORE&days=3651",
      "score=HEALTH_SCORE&days=7.5",
      "score=HEALTH_SCORE",
    ]) {
      expect((await history(query)).status, query).toBe(422);
    }
  });

  it("refuses a delegate holding a read grant: the history is a MANAGE read", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedHealthScore(owner.id, userDayKey(new Date(), TZ), 70);
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, owner.id);

    expect((await history("score=HEALTH_SCORE&days=30")).status).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    expect((await history("score=HEALTH_SCORE&days=30")).status).toBe(401);
  });
});
