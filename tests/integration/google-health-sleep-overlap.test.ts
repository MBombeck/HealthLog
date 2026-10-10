/**
 * #1195 — overlapping Google Health sleep segments, synced against Postgres.
 *
 * What went wrong. A measurement row has two unique identities: its
 * externalId, and its natural key `(type, measuredAt, source, sleepStage)`.
 * A sleep segment is stored at its END, so two segments of the same stage
 * that end at the same instant share a natural key even though Google gives
 * them different externalIds. Google reports such segments: two sessions over
 * one stretch of a night, and segments it re-scores so that one ends where a
 * sibling already ends. The sync updated rows by externalId one by one, the
 * update that moved a row onto a slot another row held threw P2002, and the
 * whole sync was marked failed, every hour, for a sync that had written
 * everything else.
 *
 * What this pins:
 *   - a re-score that moves a segment onto a sibling's slot is a clean sync,
 *     with one row left on that slot carrying the longer segment;
 *   - two sessions reporting the same segments do not double the night, and
 *     re-syncing them leaves every row untouched (no tombstone churn, no
 *     `syncVersion` bump), so the slot does not change hands every hour;
 *   - the night's asleep total is the union of the overlapping segments,
 *     never their sum.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "gh-sleep-overlap-owner";
const TZ = "Europe/Berlin";

const fake = vi.hoisted(() => ({
  sessions: [] as unknown[],
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string) => {
      const u = new URL(url);
      const body = u.pathname.endsWith("/dataTypes/sleep/dataPoints")
        ? { dataPoints: fake.sessions }
        : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

/** The night under test: 22:00 UTC two days ago to 06:00 UTC yesterday. */
const NIGHT_START = (() => {
  const d = new Date();
  d.setUTCHours(22, 0, 0, 0);
  return d.getTime() - 2 * 24 * 60 * 60 * 1000;
})();
const at = (minutes: number): string =>
  new Date(NIGHT_START + minutes * 60_000).toISOString();

function segment(type: string, from: number, to: number) {
  return { type, startTime: at(from), endTime: at(to) };
}

function session(
  id: string,
  stages: Array<ReturnType<typeof segment>>,
): unknown {
  const starts = stages.map((s) => s.startTime).sort();
  const ends = stages.map((s) => s.endTime).sort();
  return {
    name: `users/me/dataTypes/sleep/dataPoints/${id}`,
    sleep: {
      interval: { startTime: starts[0], endTime: ends[ends.length - 1] },
      stages,
    },
  };
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { encrypt } = await import("@/lib/crypto");
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: TZ },
  });
  await prisma.googleHealthConnection.create({
    data: {
      userId: USER,
      googleUserId: `google-${USER}`,
      accessToken: encrypt("access"),
      refreshToken: encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  fake.sessions = [];
}, 120_000);

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

async function sync() {
  const { syncUserGoogleHealth } = await import("@/lib/google-health/sync");
  return syncUserGoogleHealth(USER);
}

async function sleepRows() {
  return getPrismaClient().measurement.findMany({
    where: { userId: USER, type: "SLEEP_DURATION" },
    select: {
      id: true,
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      externalId: true,
      deletedAt: true,
      syncVersion: true,
    },
    orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
  });
}

async function asleepMinutes(): Promise<number> {
  const { reconstructSleepNights } =
    await import("@/lib/analytics/sleep-night");
  const live = (await sleepRows()).filter((r) => r.deletedAt === null);
  const nights = reconstructSleepNights(live, TZ);
  return nights.reduce((sum, n) => sum + n.asleepMinutes, 0);
}

describe("Google Health overlapping sleep segments (#1195)", () => {
  it("lands a re-score that moves a segment onto a sibling's slot without failing the sync", async () => {
    // First scoring: two LIGHT segments, the second starting inside the
    // first, ending at different instants.
    fake.sessions = [
      session("night", [
        segment("LIGHT", 0, 60),
        segment("LIGHT", 30, 120),
        segment("DEEP", 120, 180),
      ]),
    ];
    const first = await sync();
    expect(first.failed).toBe(false);

    // Re-score: the first segment now runs to 120, onto the end the second
    // segment already holds. Same stage, same end: one natural key.
    fake.sessions = [
      session("night", [
        segment("LIGHT", 0, 120),
        segment("LIGHT", 30, 120),
        segment("DEEP", 120, 180),
      ]),
    ];
    const second = await sync();
    expect(second.failed).toBe(false);

    const live = (await sleepRows()).filter((r) => r.deletedAt === null);
    const lightAt120 = live.filter(
      (r) => r.sleepStage === "CORE" && r.measuredAt.toISOString() === at(120),
    );
    expect(lightAt120).toHaveLength(1);
    // The longer segment holds the slot.
    expect(lightAt120[0]!.value).toBe(120);
    expect(lightAt120[0]!.externalId).toContain(`:sleep:${at(0)}`);
    // 120 minutes of light sleep (00:00-02:00) and 60 of deep: the overlap
    // is counted once.
    expect(await asleepMinutes()).toBe(180);

    // The same answer again is a no-op: the slot keeps its row.
    const before = await sleepRows();
    const third = await sync();
    expect(third.failed).toBe(false);
    expect(await sleepRows()).toEqual(before);
  });

  it("keeps both readings when a segment moves off a slot a new segment takes", async () => {
    fake.sessions = [
      session("night", [segment("LIGHT", 0, 60), segment("DEEP", 90, 150)]),
    ];
    expect((await sync()).failed).toBe(false);

    // Re-score: the light segment now runs to 90, and a new light segment
    // ends at 60, the slot the first one is leaving.
    fake.sessions = [
      session("night", [
        segment("LIGHT", 0, 90),
        segment("LIGHT", 30, 60),
        segment("DEEP", 90, 150),
      ]),
    ];
    expect((await sync()).failed).toBe(false);

    const light = (await sleepRows())
      .filter((r) => r.deletedAt === null && r.sleepStage === "CORE")
      .map((r) => [r.measuredAt.toISOString(), r.value, r.externalId]);
    expect(light).toEqual([
      [at(60), 30, expect.stringContaining(`:sleep:${at(30)}`)],
      [at(90), 90, expect.stringContaining(`:sleep:${at(0)}`)],
    ]);
  });

  it("keeps one row per segment when two sessions report the same night", async () => {
    const stages = [
      segment("DEEP", 60, 120),
      segment("REM", 120, 150),
      segment("LIGHT", 150, 240),
    ];
    fake.sessions = [session("phone", stages), session("watch", stages)];

    const first = await sync();
    expect(first.failed).toBe(false);
    const afterFirst = await sleepRows();
    expect(afterFirst.filter((r) => r.deletedAt === null)).toHaveLength(3);
    expect(await asleepMinutes()).toBe(180);

    // Hour after hour the same two sessions come back. Nothing moves:
    // neither session's window clears the other's rows, and the slot is not
    // handed from one session's externalId to the other's.
    for (let i = 0; i < 2; i++) {
      const again = await sync();
      expect(again.failed).toBe(false);
      expect(await sleepRows()).toEqual(afterFirst);
    }
    expect(await asleepMinutes()).toBe(180);
  });

  it("settles overlapping sessions that disagree, without failing and without inflating the night", async () => {
    // The watch's session ends its light segment later than the phone's.
    fake.sessions = [
      session("phone", [segment("LIGHT", 0, 90), segment("DEEP", 90, 150)]),
      session("watch", [segment("LIGHT", 10, 90), segment("DEEP", 90, 160)]),
    ];
    expect((await sync()).failed).toBe(false);

    // Re-score on the phone: its deep segment now ends where the watch's
    // does, so both sessions put a DEEP segment on one slot.
    fake.sessions = [
      session("phone", [segment("LIGHT", 0, 90), segment("DEEP", 90, 160)]),
      session("watch", [segment("LIGHT", 10, 90), segment("DEEP", 90, 160)]),
    ];
    expect((await sync()).failed).toBe(false);
    expect((await sync()).failed).toBe(false);

    const live = (await sleepRows()).filter((r) => r.deletedAt === null);
    const keys = live.map(
      (r) => `${r.sleepStage}|${r.measuredAt.toISOString()}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // Light 00:00-01:30 and deep 01:30-02:40: 160 minutes asleep.
    expect(await asleepMinutes()).toBe(160);
  });
});
