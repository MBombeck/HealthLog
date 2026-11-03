/**
 * The ladder, the job and the route, against real Postgres and the real rows.
 *
 * The unit tests prove the arithmetic and the gates in isolation. This proves
 * the assembly: that an account one day short of the threshold really gets
 * nothing written, that the day it crosses really gets a row, that switching
 * the module off really takes the rows away again, and that deleting back
 * below the threshold does not leave a forecast standing with a fresh date on
 * it. Every one of those is a claim about what is IN THE TABLE, so every
 * assertion reads the table rather than a return value.
 *
 * It is also the automated half of the ladder walk the phase plan asks a human
 * to do. What is left for a browser is what a browser is for: that the band is
 * legible at 390 px and that the count sits beside the number rather than in a
 * tooltip.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

const USER = "user-mood-prognosis";
const TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Fixed clock: a ladder test that slides with the calendar is a date bomb. */
const FIXED_NOW = new Date("2026-08-08T09:00:00.000Z");
/**
 * The instant the seed and the job are dated against. The ladder cases keep
 * the fixed clock; the route cases move it to the real one, because the route
 * reads the forecast against the wall clock and a forecast seeded at a fixed
 * date goes stale under it as the calendar moves on.
 */
let NOW = FIXED_NOW;

function dayKey(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

async function seedUser(): Promise<void> {
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "mood-prognosis",
      email: "mood-prognosis@example.test",
      timezone: TZ,
    },
  });
}

/**
 * `count` consecutive days, each carrying a rating and a stress value the
 * rating follows. A clean relationship on purpose: the point of this file is
 * the plumbing, and a fixture the screening refuses would test the refusal
 * path twice and the write path never.
 */
async function seedDays(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const stress = i % 11;
    await getPrismaClient().moodEntry.create({
      data: {
        userId: USER,
        date: dayKey(i),
        tz: TZ,
        mood: "OKAY",
        score: 3,
        moodA1: Math.round(0.8 * (10 - stress) + 1),
        stressA2: stress,
        source: "MANUAL",
        moodLoggedAt: new Date(NOW.getTime() - i * DAY_MS),
      },
    });
  }
}

async function runJob() {
  const { runMoodPrognosisRefresh } =
    await import("@/lib/jobs/mood-prognosis-refresh");
  return runMoodPrognosisRefresh(NOW);
}

function storedRows() {
  return getPrismaClient().moodPrediction.findMany({
    where: { userId: USER },
    orderBy: { date: "asc" },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

describe("the minimum-n ladder, end to end", () => {
  it("writes nothing at one day short of the threshold, and says why", async () => {
    await seedUser();
    await seedDays(29);

    const summary = await runJob();
    expect(summary.refreshed).toBe(0);
    // The account is not in the cohort at all: the job's cheap cut is the same
    // threshold, so an account a day short is never even read. The next case
    // is the other half of the evidence — one more day and `scanned` is 1, so
    // this zero is the cut landing in the right place rather than a sweep that
    // matched nothing.
    expect(summary.scanned).toBe(0);
    expect(await storedRows()).toEqual([]);

    const { readMoodPrognosis } =
      await import("@/lib/analytics/mood-prognosis/read");
    const reading = await readMoodPrognosis(USER, NOW, TZ);
    expect(reading.present).toBe(false);
    if (!reading.present) {
      expect(reading.reason).toBe("learning-phase");
      expect(reading.entries).toBe(29);
      expect(reading.nextThreshold).toBe(30);
    }
  });

  it("writes a banded, counted, provisional forecast on the day it crosses", async () => {
    await seedUser();
    await seedDays(30);

    const summary = await runJob();
    expect(summary.scanned).toBe(1);
    expect(summary.refreshed).toBe(1);

    const rows = await storedRows();
    expect(rows.length).toBeGreaterThan(0);
    // The trailing window, not the whole year of days.
    expect(rows.length).toBeLessThanOrEqual(7);

    for (const row of rows) {
      expect(row.predicted).toBeGreaterThanOrEqual(0);
      expect(row.predicted).toBeLessThanOrEqual(10);
      // The band and the count are part of the value, not decoration.
      expect(row.ciLow).not.toBeNull();
      expect(row.ciHigh).not.toBeNull();
      expect(row.ciLow!).toBeLessThanOrEqual(row.predicted);
      expect(row.ciHigh!).toBeGreaterThanOrEqual(row.predicted);
      expect(row.n).toBe(30);
      expect(row.modelVersion).toBe("mood-ridge-1");
      // The stored evidence the explanation is generated from.
      const contributions = JSON.parse(row.features) as Array<{
        feature: string;
        contribution: number;
      }>;
      expect(contributions.length).toBeGreaterThan(0);
      expect(contributions[0].feature).toBe("dimension:a2");
      expect(typeof contributions[0].contribution).toBe("number");
    }

    const { readMoodPrognosis } =
      await import("@/lib/analytics/mood-prognosis/read");
    const reading = await readMoodPrognosis(USER, NOW, TZ);
    expect(reading.present).toBe(true);
    if (reading.present) {
      // Thirty days is a forecast, and a forecast at thirty days is labelled.
      expect(reading.provisional).toBe(true);
      expect(reading.stage).toBe("provisional");
      expect(reading.n).toBe(30);
      // The self-assessment is returned unchanged beside it, never merged.
      const entry = await getPrismaClient().moodEntry.findFirstOrThrow({
        where: { userId: USER, date: reading.date },
      });
      expect(reading.selfAssessment).toBe(entry.moodA1);
      expect(reading.deviation).not.toBeNull();
    }
  });

  it("drops the provisional label once the account has enough days", async () => {
    await seedUser();
    await seedDays(70);
    await runJob();

    const { readMoodPrognosis } =
      await import("@/lib/analytics/mood-prognosis/read");
    const reading = await readMoodPrognosis(USER, NOW, TZ);
    expect(reading.present).toBe(true);
    if (reading.present) {
      expect(reading.provisional).toBe(false);
      expect(reading.stage).toBe("regular");
      expect(reading.seasonalUnlocked).toBe(false);
    }
  });

  it("computes nothing and stores nothing while the mood module is off", async () => {
    await seedUser();
    await seedDays(40);
    await runJob();
    expect((await storedRows()).length).toBeGreaterThan(0);

    await getPrismaClient().user.update({
      where: { id: USER },
      data: { modulePreferencesJson: { mood: false } },
    });

    const summary = await runJob();
    expect(summary.moduleOff).toBe(1);
    expect(summary.refreshed).toBe(0);
    // And the rows it wrote before are gone: a forecast that outlives the
    // switch that turned its module off is a claim nobody asked for.
    expect(await storedRows()).toEqual([]);
  });

  it("clears a stale forecast when the account falls back below the threshold", async () => {
    await seedUser();
    await seedDays(40);
    await runJob();
    const before = await storedRows();
    expect(before.length).toBeGreaterThan(0);

    // Delete back under the threshold. The account is no longer in the
    // eligibility half of the cohort at all, so the pass only reaches it
    // through the rows it already holds.
    await getPrismaClient().moodEntry.deleteMany({
      where: { userId: USER, date: { gte: dayKey(28) } },
    });

    const summary = await runJob();
    expect(summary.scanned).toBe(1);
    expect(summary.refused).toBe(1);
    expect(
      await storedRows(),
      "the forecast outlived its own eligibility — a stale claim with a fresh date on it",
    ).toEqual([]);
  });

  it("replaces rather than accumulates across passes", async () => {
    await seedUser();
    await seedDays(40);
    await runJob();
    const first = await storedRows();

    // A row from a pass that will not be repeated: an older day, written by
    // hand the way a previous window would have left it.
    await getPrismaClient().moodPrediction.create({
      data: {
        userId: USER,
        date: dayKey(200),
        predicted: 5,
        ciLow: 4,
        ciHigh: 6,
        n: 99,
        modelVersion: "mood-ridge-0",
        features: "[]",
        computedAt: new Date(NOW.getTime() - 200 * DAY_MS),
      },
    });

    await runJob();
    const after = await storedRows();
    expect(after.map((r) => r.date)).toEqual(first.map((r) => r.date));
    expect(after.some((r) => r.modelVersion === "mood-ridge-0")).toBe(false);
  });
});

describe("GET /api/mood/prognosis", () => {
  beforeEach(() => {
    NOW = new Date();
  });
  afterEach(() => {
    NOW = FIXED_NOW;
  });

  /**
   * A signed-in browser session.
   *
   * The expiry is off the REAL clock, not the fixture's: the seeded days are
   * dated against `NOW` so the ladder cannot slide with the calendar, but a
   * session stamped from a fixed instant expires the moment the wall clock
   * passes it, and every route then answers 401 for a reason that has nothing
   * to do with what the case is about.
   *
   * `actingOn` is passed only for a delegate. Switching an owner's session
   * into their own record would make the request a delegated one against a
   * grant that does not exist, and the refusal would look like the scope
   * refusal this file is trying to prove.
   */
  async function signIn(userId: string, actingOn?: string) {
    const session = await getPrismaClient().session.create({
      data: {
        userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    cookieJar.set("healthlog_session", session.id);
    if (actingOn) await switchSessionTo(session.id, actingOn);
    return session;
  }

  it("answers the owner with both readings", async () => {
    await seedUser();
    await seedDays(40);
    await runJob();
    await signIn(USER);

    const { GET } = await import("@/app/api/mood/prognosis/route");
    const res = await GET(
      new NextRequest("http://localhost/api/mood/prognosis"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { present: boolean; n: number; predicted: number; ciLow: number };
    };
    expect(body.data.present).toBe(true);
    expect(body.data.n).toBe(40);
    expect(typeof body.data.predicted).toBe("number");
    expect(typeof body.data.ciLow).toBe("number");
  });

  it("refuses below the floor even while a stale row survives, and never emits an out-of-enum stage", async () => {
    // The gap the read path has to close on its own. The job runs nightly, so
    // between an entry deletion and the next 04:35 pass a MoodPrediction row
    // outlives its own eligibility. If the read path trusted the row it would
    // answer present:true with a value the account no longer has the data to
    // support — and with stage "insufficient", which is not in the published
    // enum, so a strict client decode fails the whole payload. The read path
    // must agree with the job's own stale rule: below the floor is absence.
    await seedUser();
    await seedDays(40);
    await runJob();
    expect((await storedRows()).length).toBeGreaterThan(0);

    // Delete back to 20 rated days — under the 30-day forecast floor, but
    // still inside the learning band, so the refusal reason is a real rung
    // rather than the empty-account one. Deliberately DO NOT run the job: the
    // point is what the route answers in the window before the sweep clears
    // the row. The existing "clears a stale forecast" case runs the job before
    // reading, which is exactly why it never saw this.
    await getPrismaClient().moodEntry.deleteMany({
      where: { userId: USER, date: { gte: dayKey(20) } },
    });
    expect(
      (await storedRows()).length,
      "the row must still be on disk — otherwise this proves nothing about the read path",
    ).toBeGreaterThan(0);

    await signIn(USER);
    const { GET } = await import("@/app/api/mood/prognosis/route");
    const res = await GET(
      new NextRequest("http://localhost/api/mood/prognosis"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        present: boolean;
        reason?: string;
        stage?: string;
        predicted?: number;
      };
    };
    expect(
      body.data.present,
      "the read path served a forecast to an account below every floor",
    ).toBe(false);
    expect(body.data).not.toHaveProperty("predicted");
    // The out-of-enum stage a strict Codable decode chokes on must never leave
    // the route at all.
    expect(body.data.stage).toBeUndefined();
    expect(body.data.reason).toBe("learning-phase");
  });

  it("refuses a delegate whose grant does not open the whole record", async () => {
    await seedUser();
    await seedDays(40);
    await runJob();
    const rows = await storedRows();
    expect(rows.length).toBeGreaterThan(0);

    const delegate = await getPrismaClient().user.create({
      data: {
        id: "user-mood-prognosis-delegate",
        username: "mood-prognosis-delegate",
        email: "mood-prognosis-delegate@example.test",
        timezone: TZ,
      },
    });
    await getPrismaClient().accountGrant.create({
      data: {
        grantorId: USER,
        granteeId: delegate.id,
        access: "READ",
        acceptedAt: new Date(),
        // Only the mind section. The forecast reads across sections and names
        // what it read, so it is not a mind payload.
        scopeJson: ["mind"] as never,
      },
    });
    await signIn(delegate.id, USER);

    const { GET } = await import("@/app/api/mood/prognosis/route");
    const res = await GET(
      new NextRequest("http://localhost/api/mood/prognosis"),
    );
    expect(res.status).toBe(403);

    // Asserted on the bytes, not on a parsed field: the point is that not one
    // figure of the owner's reached the response. The error's random request
    // id is taken out first, since its hex digits can spell any small count.
    const raw = (await res.text()).replace(/"requestId":"[^"]*"/, "");
    expect(raw).not.toContain("predicted");
    expect(raw).not.toContain("ciLow");
    expect(raw).not.toContain("dimension:a2");
    expect(raw).not.toContain(String(rows[0].n));
    expect(raw).not.toContain(rows[0].date);
  });

  it("blanks the surface when the mood module is off", async () => {
    await seedUser();
    await seedDays(40);
    await runJob();
    await getPrismaClient().user.update({
      where: { id: USER },
      data: { modulePreferencesJson: { mood: false } },
    });
    await signIn(USER);

    const { GET } = await import("@/app/api/mood/prognosis/route");
    const res = await GET(
      new NextRequest("http://localhost/api/mood/prognosis"),
    );
    expect(res.status).toBe(403);
  });
});
