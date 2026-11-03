/**
 * #1220 — a Google Health backfill bounded by progress and a horizon in
 * years instead of a count of pages, against Postgres.
 *
 * What went wrong. Every page-by-page data type counted the pages it had
 * written across all of its slices and stopped at a ceiling (10,000 for heart
 * rate). A watch that records heart rate every few seconds fills some 4,000
 * pages a year, so the count ran out about two and a half years back. It
 * never reset: from then on every slice found heart rate at its ceiling,
 * wrote nothing, failed as stuck, and the backfill was never marked complete,
 * so the integration card said older history was loading for good.
 *
 * What this pins, each through the real backfill job, sync, walk and
 * progress note:
 *   - a heart-rate walk that crosses the old ceiling, slice by slice,
 *     completes and imports every reading once;
 *   - an account left at the old ceiling resumes with the next slice, from
 *     where it stopped, and completes;
 *   - a Google that keeps answering with the same page is stopped after a
 *     bounded number of requests; the data type waits a day for a second
 *     attempt (a restart before then leaves it alone), and only when that
 *     one stalls too does the backfill complete with the type noted as
 *     ending there;
 *   - a walk that stalls before writing anything notes no end at all;
 *   - a history older than the horizon is imported up to the horizon, and the
 *     data type is noted as ending at it;
 *   - a history handed out oldest first is read whole, not ended at the
 *     horizon on its first page.
 *
 * Google is replaced at the `safeFetch` seam by a generator that builds each
 * heart-rate page from the filter and page token it is asked with. Run under
 * the production heap ceiling: `NODE_OPTIONS=--max-old-space-size=524`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "gh-progress-bound-owner";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");

const fake = vi.hoisted(() => ({
  now: 0,
  /** Readings in the history, newest first, `spacing` ms apart. */
  total: 0,
  spacing: 0,
  /** Readings per page Google hands out. */
  perPage: 1000,
  /** Answer every heart-rate request with the newest page and a next token. */
  loop: false,
  /** Answer every heart-rate request with no readings and a next token. */
  empty: false,
  /** Hand the history out oldest first instead. */
  asc: false,
  heartRateRequests: 0,
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    ...actual,
    safeFetch: async (url: string) => {
      const u = new URL(url);
      if (!u.pathname.endsWith("/dataTypes/heart-rate/dataPoints")) {
        return respond({});
      }
      fake.heartRateRequests += 1;
      if (fake.empty) {
        return respond({ dataPoints: [], nextPageToken: "1" });
      }
      const filter = u.searchParams.get("filter") ?? "";
      const upTo = /physical_time <= "([^"]+)"/.exec(filter)?.[1];
      const from = /physical_time >= "([^"]+)"/.exec(filter)?.[1];
      // Reading `g` is `g * spacing` old and sits at position `g` of the
      // list, or `total - 1 - g` oldest first. The first position asked for
      // is the first reading at or beyond the edge.
      const first = upTo
        ? Math.max(0, Math.ceil((fake.now - Date.parse(upTo)) / fake.spacing))
        : from
          ? Math.max(
              0,
              fake.total -
                1 -
                Math.floor((fake.now - Date.parse(from)) / fake.spacing),
            )
          : 0;
      const page = fake.loop ? 0 : Number(u.searchParams.get("pageToken") ?? 0);
      const start = first + page * fake.perPage;
      const end = Math.min(fake.total, start + fake.perPage);
      const dataPoints = [];
      for (let position = start; position < end; position++) {
        const g = fake.asc ? fake.total - 1 - position : position;
        dataPoints.push({
          name: `users/me/dataTypes/heart-rate/dataPoints/${8_000_000_000 + g}`,
          dataSource: { platform: "FITBIT" },
          heartRate: {
            beatsPerMinute: String(50 + (g % 70)),
            sampleTime: {
              physicalTime: new Date(fake.now - g * fake.spacing).toISOString(),
            },
          },
        });
      }
      return respond({
        dataPoints,
        ...(fake.loop || end < fake.total
          ? { nextPageToken: String(page + 1) }
          : {}),
      });
    },
  };
});

/** The next slices the backfill queues, recorded, with their delays. */
const sent = vi.hoisted(() => ({
  slices: [] as number[],
  delays: [] as number[],
}));
vi.mock("@/lib/jobs/boss-instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/boss-instance")>()),
  getGlobalBoss: () => ({
    send: async (
      _queue: string,
      data: { data?: { slice?: number } },
      options?: { startAfter?: number },
    ) => {
      sent.slices.push(data.data?.slice ?? -1);
      sent.delays.push(options?.startAfter ?? 0);
      return `job-${sent.slices.length}`;
    },
  }),
}));

const OTHER_COLLECTIONS = [
  "fetchSteps",
  "fetchDistance",
  "fetchActiveEnergy",
  "fetchFloors",
  "fetchVo2Max",
  "fetchWeight",
  "fetchBodyFat",
  "fetchSpo2",
  "fetchHrv",
  "fetchRhr",
  "fetchRespiratoryRate",
  "fetchBloodGlucose",
  "fetchCoreBodyTemperature",
  "fetchSleepTemperature",
  "fetchExercise",
  "sleep",
];

/**
 * A fresh account. Every collection but heart rate is noted as done unless
 * `backfillProgress` says otherwise: the walks this file is about are heart
 * rate's, and the others would only add requests.
 */
async function seed(opts: {
  total: number;
  spacing: number;
  perPage: number;
  backfillProgress?: object;
}): Promise<void> {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { encrypt } = await import("@/lib/crypto");
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "Europe/Berlin" },
  });
  await prisma.googleHealthConnection.create({
    data: {
      userId: USER,
      googleUserId: `google-${USER}`,
      accessToken: encrypt("access"),
      refreshToken: encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 7 * DAY),
      backfillProgress: opts.backfillProgress ?? { done: OTHER_COLLECTIONS },
    },
  });
  fake.now = NOW;
  fake.total = opts.total;
  fake.spacing = opts.spacing;
  fake.perPage = opts.perPage;
  fake.loop = false;
  fake.empty = false;
  fake.asc = false;
  fake.heartRateRequests = 0;
  sent.slices = [];
  sent.delays = [];
}

/** Pages a slice reads here: a fifth of production, so slices stay cheap. */
const SLICE_PAGES = 100;

/**
 * Run slices the way the admission drain does, each one sending the next,
 * until one ends the chain or sends the next one an hour or more out (a
 * collection waiting for another attempt). Returns how many ran.
 */
async function runChain(maxSlices: number, from = 0): Promise<number> {
  const { runGoogleHealthBackfillForUser } =
    await import("@/lib/jobs/google-health-backfill");
  let slice = from;
  let ran = 0;
  for (; ran < maxSlices; ran++) {
    const before = sent.slices.length;
    const outcome = await runGoogleHealthBackfillForUser(
      USER,
      () => false,
      slice,
      { slicePages: SLICE_PAGES },
    );
    if (!outcome.continued) return ran + 1;
    expect(sent.slices.length).toBe(before + 1);
    slice = sent.slices.at(-1)!;
    if (sent.delays.at(-1)! >= 3600) return ran + 1;
  }
  throw new Error(`backfill did not finish within ${maxSlices} slices`);
}

async function connection() {
  return getPrismaClient().googleHealthConnection.findUniqueOrThrow({
    where: { userId: USER },
    select: { backfillCompletedAt: true, backfillProgress: true },
  });
}

async function pulseRows(): Promise<number> {
  return getPrismaClient().measurement.count({
    where: { userId: USER, type: "PULSE", source: "GOOGLE_HEALTH" },
  });
}

const savedHorizon = process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS;
beforeEach(() => {
  delete process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS;
});
afterAll(async () => {
  if (savedHorizon !== undefined) {
    process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS = savedHorizon;
  }
  await truncateAllTables(getPrismaClient());
});

describe("Google Health backfill bounded by progress, not pages (#1220)", () => {
  it("walks across the old page ceiling, slice after slice, to the end", async () => {
    // Three years of heart rate, one reading a page, so a slice's pages are
    // cheap. The stored count starts just short of the old ceiling of
    // ten thousand, standing in for the dense pages a real watch fills
    // before it: the old walk stopped a hundred pages in and never
    // completed. Since the count no longer bounds anything, the walk
    // crosses it over several slices and reaches the start of the history.
    const pages = 350;
    await seed({
      total: pages,
      spacing: Math.floor((3 * 365 * DAY) / pages),
      perPage: 1,
      backfillProgress: {
        done: OTHER_COLLECTIONS,
        cursors: {
          fetchHeartRate: {
            at: new Date(NOW).toISOString(),
            order: "desc",
            pages: 9_900,
          },
        },
      },
    });

    const slices = await runChain(10);

    const c = await connection();
    expect(c.backfillCompletedAt).toBeInstanceOf(Date);
    // Nothing ended short: the note goes with the stamp.
    expect(c.backfillProgress).toBeNull();
    expect(await pulseRows()).toBe(pages);
    // Back to the start of the three years, well past where the old count
    // ran out.
    const oldest = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: USER, type: "PULSE" },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true },
    });
    expect(NOW - oldest.measuredAt.getTime()).toBeGreaterThan(
      (3 * 365 - 7) * DAY,
    );
    // More than one slice, each one before the last sending the next.
    expect(slices).toBeGreaterThanOrEqual(3);
    expect(sent.slices).toEqual(
      Array.from({ length: slices - 1 }, (_, i) => i + 1),
    );
  }, 900_000);

  it("resumes an account left at the old ceiling and completes it", async () => {
    // The state the report showed: every other collection done, heart rate
    // at its ten thousand pages with its edge some way back.
    const edgeIndex = 20_000;
    const total = edgeIndex + 10 * 1000;
    const edge = new Date(NOW - edgeIndex * 60_000).toISOString();
    await seed({
      total,
      spacing: 60_000,
      perPage: 1000,
      backfillProgress: {
        done: OTHER_COLLECTIONS,
        cursors: {
          fetchHeartRate: { at: edge, order: "desc", pages: 10_000 },
        },
      },
    });

    const slices = await runChain(10);

    const c = await connection();
    expect(c.backfillCompletedAt).toBeInstanceOf(Date);
    expect(c.backfillProgress).toBeNull();
    // Everything from the edge back was written, none of what was newer.
    expect(await pulseRows()).toBe(total - edgeIndex);
    expect(slices).toBeGreaterThanOrEqual(1);
    // Read from the edge on, not from the newest page.
    expect(fake.heartRateRequests).toBeLessThanOrEqual(10 + 2 * slices);
  }, 600_000);

  it("parks a walk Google keeps answering with the same page, and ends it only after a day brings no progress", async () => {
    await seed({ total: 5_000, spacing: 60_000, perPage: 1000 });
    fake.loop = true;
    const { GOOGLE_HEALTH_NO_PROGRESS_PAGES } =
      await import("@/lib/google-health/backfill-bounds");
    const { googleHealthBackfillEndedList } =
      await import("@/lib/google-health/backfill-progress");
    const walk = 1 + GOOGLE_HEALTH_NO_PROGRESS_PAGES;
    const prisma = getPrismaClient();
    /** Let a day pass for the parked walk. */
    const dayLater = async () => {
      const progress = (await connection()).backfillProgress as {
        ended: Record<string, { endedAt: string; attempts?: number }>;
      };
      progress.ended.fetchHeartRate!.endedAt = new Date(
        Date.now() - 25 * HOUR,
      ).toISOString();
      await prisma.googleHealthConnection.update({
        where: { userId: USER },
        data: { backfillProgress: progress },
      });
      return progress.ended.fetchHeartRate!;
    };

    // First attempt: the first page and the twenty that repeat it. Not
    // complete, nothing published, and the next slice a day out.
    await runChain(5);
    expect(fake.heartRateRequests).toBe(walk);
    let c = await connection();
    expect(c.backfillCompletedAt).toBeNull();
    expect(googleHealthBackfillEndedList(c.backfillProgress)).toEqual([]);
    expect(sent.delays.at(-1)).toBeGreaterThan(23 * 3600);

    // A slice that comes early (a restart) leaves it alone and waits again.
    await runChain(1, sent.slices.at(-1)!);
    expect(fake.heartRateRequests).toBe(walk);
    expect((await connection()).backfillCompletedAt).toBeNull();

    // A day later the walk goes on from its edge and gets one page further
    // before the wall. That is progress: it parks again, counting afresh,
    // rather than ending a history that is still coming in.
    expect((await dayLater()).attempts ?? 1).toBe(1);
    await runChain(5, sent.slices.at(-1)!);
    expect(fake.heartRateRequests).toBe(2 * walk);
    c = await connection();
    expect(c.backfillCompletedAt).toBeNull();
    expect(await pulseRows()).toBe(1999);
    expect((await dayLater()).attempts ?? 1).toBe(1);

    // Another day, and nothing lies past the edge any more: the walk meets
    // the wall where it stood, and this time the history ends there.
    fake.total = 1999;
    await runChain(5, sent.slices.at(-1)!);
    // No page of this attempt is new, the first included.
    expect(fake.heartRateRequests).toBe(
      2 * walk + GOOGLE_HEALTH_NO_PROGRESS_PAGES,
    );
    c = await connection();
    expect(c.backfillCompletedAt).toBeInstanceOf(Date);
    expect(googleHealthBackfillEndedList(c.backfillProgress)).toEqual([
      {
        type: "PULSE",
        // The oldest reading the second attempt's one real page wrote.
        endsAt: new Date(NOW - 1998 * 60_000).toISOString(),
        reason: "no_progress",
      },
    ]);
    expect(await pulseRows()).toBe(1999);
  }, 600_000);

  it("notes no end for a walk that wrote nothing before it stalled", async () => {
    // Pages without a single reading, forever: there is no place to say the
    // history ends at, and "today" would be false. The slice fails as stuck.
    await seed({ total: 5_000, spacing: 60_000, perPage: 1000 });
    fake.empty = true;
    const { runGoogleHealthBackfillForUser } =
      await import("@/lib/jobs/google-health-backfill");
    const { GOOGLE_HEALTH_NO_PROGRESS_PAGES } =
      await import("@/lib/google-health/backfill-bounds");

    await expect(
      runGoogleHealthBackfillForUser(USER, () => false, 0, {
        slicePages: SLICE_PAGES,
      }),
    ).rejects.toThrow(/no progress in slice 0/);
    expect(fake.heartRateRequests).toBe(GOOGLE_HEALTH_NO_PROGRESS_PAGES);
    const c = await connection();
    expect(c.backfillCompletedAt).toBeNull();
    expect(c.backfillProgress).not.toHaveProperty("ended");
    expect(await pulseRows()).toBe(0);
  }, 600_000);

  it("reads back to the horizon and notes where the history ends", async () => {
    process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS = "1";
    // Three years of one reading a day.
    await seed({ total: 3 * 365, spacing: DAY, perPage: 100 });

    await runChain(5);

    const { googleHealthBackfillEndedList } =
      await import("@/lib/google-health/backfill-progress");
    const c = await connection();
    expect(c.backfillCompletedAt).toBeInstanceOf(Date);
    const ended = googleHealthBackfillEndedList(c.backfillProgress);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ type: "PULSE", reason: "horizon" });
    const horizon = Date.parse(ended[0]!.endsAt);
    // About a year back from when the slice ran.
    expect(Math.abs(Date.now() - 365 * DAY - horizon)).toBeLessThan(2 * DAY);
    // Only the readings inside the horizon, and the walk stopped at the
    // first page that crossed it instead of reading the rest.
    const inside = Array.from({ length: fake.total }, (_, g) => g).filter(
      (g) => NOW - g * DAY >= horizon,
    ).length;
    expect(await pulseRows()).toBe(inside);
    expect(fake.heartRateRequests).toBe(Math.ceil((inside + 1) / 100));
  }, 600_000);

  it("reads an oldest-first history whole instead of ending it at the horizon", async () => {
    // A list handed out oldest first starts beyond the horizon and works
    // toward it. Ending it there would drop the whole history; it is read
    // as it always was, and nothing is noted as ending short.
    process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS = "1";
    await seed({ total: 3 * 365, spacing: DAY, perPage: 100 });
    fake.asc = true;

    await runChain(5);

    const c = await connection();
    expect(c.backfillCompletedAt).toBeInstanceOf(Date);
    expect(c.backfillProgress).toBeNull();
    expect(await pulseRows()).toBe(fake.total);
  }, 600_000);
});
