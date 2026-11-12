/**
 * `GET /api/insights/presence`, against Postgres.
 *
 * The Insights tab strip gates its pills on this one answer: the reading
 * count per type and whether the record has mood entries, a scheduled
 * medication, workouts and ECG recordings. It must answer for the record on
 * screen, a delegate's switched record included, and read nothing a
 * switched-off module hides. Every call goes through the contract check. All
 * data invented.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { User } from "@/generated/prisma/client";
import { GET as getPresence } from "@/app/api/insights/presence/route";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

import { callRoute, type RouteAuth } from "../kit/call-route";
import {
  makeGrant,
  makeMeasurement,
  makeMedication,
  makeSession,
  makeUser,
  makeWorkout,
} from "../kit/factories";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY_MS = 86_400_000;

interface PresenceBody {
  metrics: Record<string, { count: number }>;
  hasMood: boolean;
  hasMedication: boolean;
  hasWorkouts: boolean;
  hasEcgRecordings: boolean;
}

async function presence(auth: RouteAuth) {
  const res = await callRoute<PresenceBody>(getPresence, {
    method: "GET",
    route: "/api/insights/presence",
    auth,
  });
  expect(res.status).toBe(200);
  return res.data;
}

/** Two weight readings, a recent mood, a medication, a workout and an ECG. */
async function seedEverything(user: Pick<User, "id">) {
  for (const daysAgo of [3, 2]) {
    await makeMeasurement(user, {
      measuredAt: new Date(Date.now() - daysAgo * DAY_MS),
    });
  }
  const loggedAt = new Date(Date.now() - 5 * DAY_MS);
  await prisma.moodEntry.create({
    data: {
      userId: user.id,
      date: loggedAt.toISOString().slice(0, 10),
      mood: "GUT",
      score: 4,
      moodLoggedAt: loggedAt,
    },
  });
  await makeMedication(user);
  await makeWorkout(user);
  await prisma.ecgRecording.create({
    data: {
      userId: user.id,
      source: "APPLE_HEALTH",
      externalRecordingId: `ecg-${user.id}`,
      recordedAt: new Date(Date.now() - DAY_MS),
      waveformEncrypted: Buffer.from([0]),
      samplingFrequency: 512,
      sampleCount: 0,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  __resetAllCachesForTests();
});

describe("GET /api/insights/presence", () => {
  it("answers what the record holds", async () => {
    const user = await makeUser({ timezone: "Europe/Berlin" });
    await seedEverything(user);

    expect(await presence(await makeSession(user))).toEqual({
      metrics: { WEIGHT: { count: 2 } },
      hasMood: true,
      hasMedication: true,
      hasWorkouts: true,
      hasEcgRecordings: true,
    });
  });

  it("answers nothing for an empty record", async () => {
    const user = await makeUser();
    expect(await presence(await makeSession(user))).toEqual({
      metrics: {},
      hasMood: false,
      hasMedication: false,
      hasWorkouts: false,
      hasEcgRecordings: false,
    });
  });

  it("counts no mood older than the overview's 90 days and no medication that expects no dose", async () => {
    const user = await makeUser();
    const loggedAt = new Date(Date.now() - 120 * DAY_MS);
    await prisma.moodEntry.create({
      data: {
        userId: user.id,
        date: loggedAt.toISOString().slice(0, 10),
        mood: "GUT",
        score: 4,
        moodLoggedAt: loggedAt,
      },
    });
    await makeMedication(user, { asNeeded: true });
    await makeMedication(user, { trackIntake: false });
    await makeMedication(user, {}, []);

    const body = await presence(await makeSession(user));
    expect(body.hasMood).toBe(false);
    expect(body.hasMedication).toBe(false);
  });

  it("reads nothing a switched-off module hides", async () => {
    const user = await makeUser({
      modulePreferencesJson: {
        mood: false,
        medications: false,
        workouts: false,
      },
    });
    await seedEverything(user);

    expect(await presence(await makeSession(user))).toMatchObject({
      metrics: { WEIGHT: { count: 2 } },
      hasMood: false,
      hasMedication: false,
      hasWorkouts: false,
      hasEcgRecordings: true,
    });
  });

  it("answers for the record a delegate has switched to", async () => {
    const owner = await makeUser();
    const delegate = await makeUser();
    await seedEverything(owner);
    await makeGrant(owner, delegate, { access: "MANAGE" });
    const auth = await makeSession(delegate);

    expect((await presence(auth)).hasMood).toBe(false);

    await switchSessionTo(auth.sessionId, owner.id);
    expect(await presence(auth)).toEqual({
      metrics: { WEIGHT: { count: 2 } },
      hasMood: true,
      hasMedication: true,
      hasWorkouts: true,
      hasEcgRecordings: true,
    });
  });

  it("refuses a delegate whose grant only reads", async () => {
    const owner = await makeUser();
    const delegate = await makeUser();
    await makeGrant(owner, delegate);
    const auth = await makeSession(delegate);
    await switchSessionTo(auth.sessionId, owner.id);

    const res = await callRoute(getPresence, {
      method: "GET",
      route: "/api/insights/presence",
      auth,
    });
    expect(res.status).toBe(403);
  });
});
