/**
 * Person-defined symptoms as lines on the timeline (#981), driven through
 * `GET /api/timeline` against real Postgres.
 *
 * What the unit tests cannot show: that the record's own logged symptoms
 * are offered (hidden ones included, never-logged ones not) and nobody
 * else's, that a definition id from another record finds nothing, that a
 * day is the record's local day and its value the day's highest intensity,
 * that an `all` window reaches back to a chosen symptom's first entry, that
 * a switched-off illness module reads nothing, and that a whole-record
 * grant shares the lines. Labels are decrypted server-side. All data
 * invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import type { TimelineResponse } from "@/lib/day/contract";
import { shiftDateKey } from "@/lib/tz/format";

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

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

let counter = 0;

const DAY_MS = 86_400_000;

/** The calendar day `n` days before today (UTC), so data stays in range. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

const MODULES = { timeline: true, illness: true };

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `tl-sym-${suffix}`,
      email: `tl-sym-${suffix}@example.test`,
      displayName: `TL ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      modulePreferencesJson: MODULES,
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

async function shareWholeRecord(ownerId: string, delegateId: string) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: ownerId,
    granteeId: delegateId,
    access: "READ",
    scope: null,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegateId });
  const session = await signIn(delegateId);
  await switchSessionTo(session.id, ownerId);
}

async function getTimeline(query: string): Promise<Response> {
  const { GET } = await import("@/app/api/timeline/route");
  return (GET as Handler)(
    new NextRequest(`http://localhost/api/timeline?${query}`, {
      method: "GET",
    }),
    { params: Promise.resolve({}) },
  );
}

async function data(response: Response): Promise<TimelineResponse> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: TimelineResponse }).data;
}

/** Days of the seeded headache, as the record's local zone cuts them. */
const DAYS = {
  first: () => daysAgo(30),
  // 23:30 UTC is already the next day in Berlin, summer or winter.
  lateNight: () => shiftDateKey(daysAgo(20), 1),
  twice: () => daysAgo(10),
};

/**
 * A record with a headache logged on three days (one of them twice, one
 * late at night), a hidden nausea logged once long ago, and a dizziness
 * that was defined but never logged.
 */
async function seedSymptoms(userId: string) {
  const db = getPrismaClient();
  const define = (label: string, sortOrder: number, isActive = true) =>
    db.symptomDefinition.create({
      data: {
        userId,
        labelEncrypted: encryptToBytes(label),
        icon: "brain",
        sortOrder,
        isActive,
      },
    });
  const headache = await define("Headache", 0);
  const nausea = await define("Nausea", 1, false);
  const dizziness = await define("Dizziness", 2);
  const log = (definitionId: string, iso: string, intensity: number) =>
    db.symptomEvent.create({
      data: { userId, definitionId, occurredAt: new Date(iso), intensity },
    });
  await log(headache.id, `${daysAgo(30)}T12:00:00.000Z`, 4);
  await log(headache.id, `${daysAgo(20)}T23:30:00.000Z`, 7);
  await log(headache.id, `${daysAgo(10)}T08:00:00.000Z`, 2);
  await log(headache.id, `${daysAgo(10)}T15:00:00.000Z`, 9);
  // Long before anything else in the record.
  await log(nausea.id, `${daysAgo(900)}T12:00:00.000Z`, 3);
  return { headache, nausea, dizziness };
}

/** A 40-day range: under six weeks, so every point is one day. */
const DAY_WINDOW = () => `zoom=range&from=${daysAgo(39)}&to=${daysAgo(0)}`;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("symptom lines on the timeline", () => {
  it("offers the record's logged symptoms and draws a chosen one by local day and day peak", async () => {
    const owner = await makeUser("owner");
    const { headache, nausea } = await seedSymptoms(owner.id);
    await signIn(owner.id);

    const timeline = await data(
      await getTimeline(`${DAY_WINDOW()}&values=WEIGHT,symptom:${headache.id}`),
    );
    expect(timeline.bucket).toBe("day");
    // Never-logged dizziness is not offered; hidden nausea is, marked.
    expect(timeline.availableSymptoms).toEqual([
      {
        key: `symptom:${headache.id}`,
        definitionId: headache.id,
        label: "Headache",
        icon: "brain",
        isActive: true,
      },
      {
        key: `symptom:${nausea.id}`,
        definitionId: nausea.id,
        label: "Nausea",
        icon: "brain",
        isActive: false,
      },
    ]);
    expect(timeline.symptomSeries).toHaveLength(1);
    const [line] = timeline.symptomSeries;
    expect(line).toMatchObject({
      key: `symptom:${headache.id}`,
      definitionId: headache.id,
      label: "Headache",
      isActive: true,
      scale: { min: 0, max: 10 },
    });
    expect(line.points).toEqual([
      { t: DAYS.first(), mean: 4, count: 1 },
      { t: DAYS.lateNight(), mean: 7, count: 1 },
      // Logged twice: the day's value is its highest intensity.
      { t: DAYS.twice(), mean: 9, count: 1 },
    ]);
    // A symptom does not touch the measurement lines.
    expect(timeline.series).toEqual([]);
  });

  it("averages day peaks over the logged days in a coarser bucket", async () => {
    const owner = await makeUser("owner");
    const { headache } = await seedSymptoms(owner.id);
    await signIn(owner.id);

    // Across 200 days the bucket is a month.
    const months = await data(
      await getTimeline(
        `zoom=range&from=${daysAgo(199)}&to=${daysAgo(0)}&values=symptom:${headache.id}`,
      ),
    );
    expect(months.bucket).toBe("month");
    const points = months.symptomSeries[0].points;
    // Three logged days in all, never a silent day counted as zero.
    expect(points.reduce((n, p) => n + p.count, 0)).toBe(3);
    // Each mean is of its month's day peaks (rounded to two decimals).
    const total = points.reduce((sum, p) => sum + p.mean * p.count, 0);
    expect(total).toBeCloseTo(4 + 7 + 9, 1);
  });

  it("reaches an `all` window back to a chosen symptom's first entry", async () => {
    const owner = await makeUser("owner");
    const { nausea, headache } = await seedSymptoms(owner.id);
    await signIn(owner.id);

    const without = await data(
      await getTimeline(`zoom=all&values=symptom:${headache.id}`),
    );
    expect(without.range.dataFrom).toBe(DAYS.first());
    const withNausea = await data(
      await getTimeline(`zoom=all&values=symptom:${nausea.id}`),
    );
    expect(withNausea.range.dataFrom).toBe(daysAgo(900));
    expect(withNausea.symptomSeries[0].points.map((p) => p.count)).toEqual([1]);
  });

  it("finds nothing under another record's definition id, and does not refuse", async () => {
    const owner = await makeUser("owner");
    const other = await makeUser("other");
    const { headache: theirs } = await seedSymptoms(other.id);
    await signIn(owner.id);

    const timeline = await data(
      await getTimeline(`zoom=all&values=symptom:${theirs.id},symptom:gone123`),
    );
    expect(timeline.symptomSeries).toEqual([]);
    expect(timeline.availableSymptoms).toEqual([]);
    // Another record's first entry does not move this record's window.
    expect(timeline.range.dataFrom).toBeNull();

    // A malformed id is refused.
    expect((await getTimeline(`values=symptom:..%2Fx`)).status).toBe(422);
  });

  it("draws and offers nothing with the illness module off", async () => {
    const owner = await makeUser("owner");
    const { headache } = await seedSymptoms(owner.id);
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { ...MODULES, illness: false } },
    });
    await signIn(owner.id);

    const timeline = await data(
      await getTimeline(`zoom=all&values=symptom:${headache.id}`),
    );
    expect(timeline.symptomSeries).toEqual([]);
    expect(timeline.availableSymptoms).toEqual([]);
    expect(timeline.range.dataFrom).toBeNull();
  });

  it("shares the lines on a whole-record grant", async () => {
    const owner = await makeUser("owner");
    const { headache } = await seedSymptoms(owner.id);
    const whole = await makeUser("whole");
    await shareWholeRecord(owner.id, whole.id);

    const shared = await data(
      await getTimeline(`${DAY_WINDOW()}&values=symptom:${headache.id}`),
    );
    expect(shared.symptomSeries[0].points).toHaveLength(3);
    expect(shared.availableSymptoms.map((s) => s.label)).toEqual([
      "Headache",
      "Nausea",
    ]);
  });
});
