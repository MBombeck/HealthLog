/**
 * v1.38 — the linked day block, proven against real Postgres to be a read of
 * the owning module rather than a copy of it.
 *
 * The claim the whole design rests on cannot be made by a shape test. "The
 * response has a `sleep` key" would stay green over an implementation that
 * copied the figure onto the mood row at write time and never looked at it
 * again — and that implementation is exactly the failure mode this feature
 * exists to avoid. So the test changes the SOURCE and reads the mood surface
 * again: write a sleep session, read the block, correct the session, read
 * again, assert the block moved.
 *
 * Beside it, the two absences that are easy to get wrong:
 *   - a module switched off blanks its block rather than answering zero;
 *   - a day with no rows answers `{ present: false }`, which is a different
 *     fact from a day of no sleep.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-mood-linkage";
const DAY = "2026-06-11";

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
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "mood-linkage",
      email: "mood-linkage@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

interface LinkedFigure {
  present: boolean;
  value?: number;
  unit?: string;
}
interface LinkedBody {
  available: boolean;
  reason?: string;
  day: string;
  sleep: { available: boolean; asleep?: LinkedFigure; inBed?: LinkedFigure };
  activity: {
    available: boolean;
    reason?: string;
    steps?: LinkedFigure;
    activeEnergy?: LinkedFigure;
  };
  vitals: {
    available: boolean;
    restingHeartRate?: LinkedFigure;
    heartRateVariability?: LinkedFigure;
  };
  body: {
    available: boolean;
    reason?: string;
    logged?: boolean;
    symptoms?: string[];
    episodeId?: string | null;
  };
}

async function readLinked(day = DAY): Promise<LinkedBody> {
  const { GET } = await import("@/app/api/mood/linked-context/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/mood/linked-context?date=${day}&tz=Europe%2FBerlin`,
    ),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: LinkedBody };
  return body.data;
}

/** One night's sleep, as the sleep module stores it: minutes per stage. */
async function writeSleep(minutes: number) {
  return getPrismaClient().measurement.create({
    data: {
      userId: TEST_USER_ID,
      type: "SLEEP_DURATION",
      value: minutes,
      unit: "min",
      // A night that ends on the morning of DAY: the reconstruction keys a
      // night on the day it woke up on.
      measuredAt: new Date("2026-06-11T05:30:00.000Z"),
      sleepStage: "ASLEEP",
      source: "MANUAL",
    },
  });
}

describe("mood context linkage (real Postgres)", () => {
  it("a corrected sleep session moves the linked figure, because nothing was copied", async () => {
    const row = await writeSleep(400);

    const before = await readLinked();
    expect(before.sleep.available).toBe(true);
    expect(before.sleep.asleep).toEqual({
      present: true,
      value: 400,
      unit: "min",
    });

    // The correction, made where the fact lives.
    await getPrismaClient().measurement.update({
      where: { id: row.id },
      data: { value: 455 },
    });

    const after = await readLinked();
    expect(after.sleep.asleep).toEqual({
      present: true,
      value: 455,
      unit: "min",
    });
  });

  it("a day with no rows answers absence, not zero", async () => {
    const linked = await readLinked();
    expect(linked.sleep.available).toBe(true);
    expect(linked.sleep.asleep).toEqual({ present: false });
    expect(linked.activity.steps).toEqual({ present: false });
    expect(linked.vitals.restingHeartRate).toEqual({ present: false });
    // Never a zero: a night nobody recorded and a night of no sleep are
    // different facts, and only one of them belongs in a health record.
    expect(JSON.stringify(linked)).not.toContain('"value":0');
  });

  it("sums the day's activity and takes the day's latest vital", async () => {
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 4000,
          unit: "steps",
          measuredAt: new Date("2026-06-11T08:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 2500,
          unit: "steps",
          measuredAt: new Date("2026-06-11T18:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 61,
          unit: "bpm",
          measuredAt: new Date("2026-06-11T07:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 58,
          unit: "bpm",
          measuredAt: new Date("2026-06-11T21:00:00.000Z"),
          source: "MANUAL",
        },
        // The day before, to prove the window does not bleed.
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 9999,
          unit: "steps",
          measuredAt: new Date("2026-06-10T12:00:00.000Z"),
          source: "MANUAL",
        },
      ],
    });

    const linked = await readLinked();
    expect(linked.activity.steps).toEqual({
      present: true,
      value: 6500,
      unit: "steps",
    });
    expect(linked.vitals.restingHeartRate).toEqual({
      present: true,
      value: 58,
      unit: "bpm",
    });
  });

  it("blanks the sleep block when the sleep module is off, rather than answering zero", async () => {
    await writeSleep(400);
    expect((await readLinked()).sleep.available).toBe(true);

    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      data: { modulePreferencesJson: { sleep: false } },
    });

    const linked = await readLinked();
    expect(linked.sleep).toEqual({
      available: false,
      reason: "module-disabled",
    });
    // The block is gone, not zeroed and not filtered down to an empty figure.
    expect(linked.sleep).not.toHaveProperty("asleep");
    // And the other blocks are untouched by that choice.
    expect(linked.activity.available).toBe(true);
    expect(linked.vitals.available).toBe(true);
  });

  it("links the illness day-log read-only, and blanks it when the module is off", async () => {
    const episode = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: TEST_USER_ID,
        label: "cold",
        type: "INFECTION",
        onsetAt: new Date("2026-06-10T08:00:00.000Z"),
      },
    });
    // The symptom catalogue is seeded reference data every instance has, so
    // this upserts rather than creating: the point of the test is the link,
    // not the row.
    const symptom = await getPrismaClient().illnessSymptom.upsert({
      where: { key: "cough" },
      create: { key: "cough", labelKey: "illness.symptom.cough" },
      update: {},
    });
    await getPrismaClient().illnessDayLog.create({
      data: {
        userId: TEST_USER_ID,
        episodeId: episode.id,
        date: DAY,
        functionalImpact: 2,
        symptomLinks: { create: [{ symptomId: symptom.id, severity: 2 }] },
      },
    });

    const linked = await readLinked();
    expect(linked.body.available).toBe(true);
    expect(linked.body.logged).toBe(true);
    expect(linked.body.symptoms).toEqual(["cough"]);
    expect(linked.body.episodeId).toBe(episode.id);

    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      data: { modulePreferencesJson: { illness: false } },
    });
    expect((await readLinked()).body).toEqual({
      available: false,
      reason: "module-disabled",
    });
  });

  it("sums one source per day, not both, when two report the same day", async () => {
    // Two sources reporting the same day is the ordinary case for anyone
    // syncing a phone and a watch, and summing both doubles the number on the
    // mood sheet. The repo's cure is the canonical-source picker every other
    // steps/energy read already runs through.
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 6000,
          unit: "steps",
          measuredAt: new Date("2026-06-11T08:00:00.000Z"),
          source: "APPLE_HEALTH",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 5900,
          unit: "steps",
          measuredAt: new Date("2026-06-11T09:00:00.000Z"),
          source: "FITBIT",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVE_ENERGY_BURNED",
          value: 500,
          unit: "kcal",
          measuredAt: new Date("2026-06-11T08:00:00.000Z"),
          source: "APPLE_HEALTH",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVE_ENERGY_BURNED",
          value: 480,
          unit: "kcal",
          measuredAt: new Date("2026-06-11T09:00:00.000Z"),
          source: "FITBIT",
        },
      ],
    });

    const linked = await readLinked();
    // One stream, whichever the ladder picks — never the two added together.
    expect([6000, 5900]).toContain(linked.activity.steps?.value);
    expect([500, 480]).toContain(linked.activity.activeEnergy?.value);
    expect(linked.activity.steps?.value).not.toBe(11900);
    expect(linked.activity.activeEnergy?.value).not.toBe(980);
  });

  it("takes one source's vital for the day rather than whichever row is last", async () => {
    // The default resting-heart-rate ladder ranks FITBIT above APPLE_HEALTH,
    // and the fixture puts the LOWER-ranked source last in the day on purpose:
    // a source-blind "latest of the day" answers 71, the canonical stream
    // answers 62. Without that ordering the two rules agree and the case
    // proves nothing.
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 60,
          unit: "bpm",
          measuredAt: new Date("2026-06-11T07:00:00.000Z"),
          source: "FITBIT",
        },
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 62,
          unit: "bpm",
          measuredAt: new Date("2026-06-11T12:00:00.000Z"),
          source: "FITBIT",
        },
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 71,
          unit: "bpm",
          // 21:00 Berlin, deliberately still inside the same local day: at
          // 22:00 UTC in June this row would belong to the NEXT Berlin day and
          // the case would pass without proving anything.
          measuredAt: new Date("2026-06-11T19:00:00.000Z"),
          source: "APPLE_HEALTH",
        },
      ],
    });

    const linked = await readLinked();
    // The picked source's latest, not the day's latest.
    expect(linked.vitals.restingHeartRate).toEqual({
      present: true,
      value: 62,
      unit: "bpm",
    });
  });

  it("keeps ambient movement available when the workouts module is off", async () => {
    // `workouts` gates workout SESSIONS. Steps and active energy are ambient
    // movement and are deliberately unscoped — the module ownership table says
    // so, and gating them here made the mood sheet stricter than every other
    // surface in the product.
    await getPrismaClient().measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        value: 3000,
        unit: "steps",
        measuredAt: new Date("2026-06-11T08:00:00.000Z"),
        source: "MANUAL",
      },
    });
    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      data: { modulePreferencesJson: { workouts: false } },
    });

    const linked = await readLinked();
    expect(linked.activity.available).toBe(true);
    expect(linked.activity.steps).toEqual({
      present: true,
      value: 3000,
      unit: "steps",
    });
  });

  it("blanks the vitals block when the recovery module is off", async () => {
    // Resting heart rate and heart-rate variability are owned by `recovery`,
    // which the ownership table has said since v1.30.22. The block claimed to
    // be core and answered them regardless, which made the release note's
    // "a module you have switched off leaves its block out entirely" false.
    await getPrismaClient().measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "RESTING_HEART_RATE",
        value: 58,
        unit: "bpm",
        measuredAt: new Date("2026-06-11T07:00:00.000Z"),
        source: "MANUAL",
      },
    });
    expect((await readLinked()).vitals.available).toBe(true);

    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      data: { modulePreferencesJson: { recovery: false } },
    });

    const linked = await readLinked();
    expect(linked.vitals).toEqual({
      available: false,
      reason: "module-disabled",
    });
    expect(linked.vitals).not.toHaveProperty("restingHeartRate");
  });

  it("refuses a delegate whose grant does not open the whole record", async () => {
    // The finding this case exists for: the route reads sleep, activity,
    // vitals and the illness journal, and it used to declare `mind`. A
    // delegate given the mind section alone could therefore walk arbitrary
    // dates and read four other sections of the owner's record — no mood
    // entry even had to exist for the date.
    //
    // The convention for a read that crosses sections is `record`, and a
    // scoped grant never reaches one. So the scoped delegate loses the linked
    // block entirely, which is the honest answer rather than a filtered one.
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 7777,
          unit: "steps",
          measuredAt: new Date("2026-06-11T08:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 55,
          unit: "bpm",
          measuredAt: new Date("2026-06-11T07:00:00.000Z"),
          source: "MANUAL",
        },
      ],
    });
    const episode = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: TEST_USER_ID,
        label: "cold",
        type: "INFECTION",
        onsetAt: new Date("2026-06-10T08:00:00.000Z"),
      },
    });
    await getPrismaClient().illnessDayLog.create({
      data: {
        userId: TEST_USER_ID,
        episodeId: episode.id,
        date: DAY,
        functionalImpact: 3,
      },
    });

    const delegate = await getPrismaClient().user.create({
      data: {
        id: "user-mood-linkage-delegate",
        username: "mood-linkage-delegate",
        email: "mood-linkage-delegate@example.test",
        timezone: "Europe/Berlin",
      },
    });
    await getPrismaClient().accountGrant.create({
      data: {
        grantorId: TEST_USER_ID,
        granteeId: delegate.id,
        access: "READ",
        acceptedAt: new Date(),
        // Only the mind section. Everything this route reads is outside it.
        scopeJson: ["mind"] as never,
      },
    });
    const session = await getPrismaClient().session.create({
      data: {
        userId: delegate.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    cookieJar.set("healthlog_session", session.id);
    await switchSessionTo(session.id, TEST_USER_ID);

    const { GET } = await import("@/app/api/mood/linked-context/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/mood/linked-context?date=${DAY}&tz=Europe%2FBerlin`,
      ),
    );
    expect(res.status).toBe(403);
    const raw = await res.text();
    // Asserted on the bytes, not on a parsed field: the point is that not one
    // of the owner's figures reached the response. The request id is random
    // and can contain any digit run, so it is taken out before the check.
    const bytes = raw.replace(/"requestId":"[^"]*"/, "");
    expect(bytes).not.toContain("7777");
    expect(bytes).not.toContain("55");
    expect(bytes).not.toContain("functionalImpact");
  });

  it("refuses a malformed day", async () => {
    const { GET } = await import("@/app/api/mood/linked-context/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/mood/linked-context?date=yesterday",
      ),
    );
    expect(res.status).toBe(422);
  });
});
