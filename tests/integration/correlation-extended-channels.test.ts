/**
 * v1.44 — the extended correlation channel reads against a real Postgres.
 *
 * The unit battery (`correlation-extended-channels.test.ts`) pins the pure
 * shapers; this suite proves the reads that feed them: the room-climate
 * hour-mean SQL and its zone conversion, the nutrient day sum across sources,
 * the alcohol tag read from the legacy flat list, and the training read with
 * a session stored by two services.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  fetchAlcoholSeries,
  fetchIndoorClimateSeries,
  fetchNutrientSeries,
  fetchTrainingSeries,
} from "@/lib/insights/correlation-channel-series";

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = "Europe/Berlin";

let seq = 0;
async function seedUser(prisma: ReturnType<typeof getPrismaClient>) {
  seq += 1;
  return prisma.user.create({
    data: {
      username: `corr-extended-${seq}`,
      email: `corr-extended-${seq}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
}

/** A UTC day key `daysAgo` days back. */
function dayKey(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extended correlation channels — reads", () => {
  it("folds the room climate to overnight means on the waking day, in the person's zone", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);
    const wake = dayKey(5);
    const evening = dayKey(6);
    // Berlin is UTC+1 or +2; 20:30 UTC on the evening is at least 21:30
    // local, 02:00 UTC on the waking day at least 03:00 local, both inside
    // the 21:00–07:00 window. Four hours each side, one reading per quarter
    // hour at 600 ppm before midnight and 1000 ppm after.
    const rows = [];
    for (let h = 0; h < 2; h += 1) {
      for (let q = 0; q < 4; q += 1) {
        rows.push({
          value: 600,
          measuredAt: new Date(
            `${evening}T2${h}:${String(q * 15).padStart(2, "0")}:00Z`,
          ),
        });
      }
    }
    for (let h = 1; h < 4; h += 1) {
      for (let q = 0; q < 4; q += 1) {
        rows.push({
          value: 1000,
          measuredAt: new Date(
            `${wake}T0${h}:${String(q * 15).padStart(2, "0")}:00Z`,
          ),
        });
      }
    }
    // Midday on the waking day is outside the window.
    rows.push({ value: 5000, measuredAt: new Date(`${wake}T11:00:00Z`) });
    await prisma.measurement.createMany({
      data: rows.map((r) => ({
        userId: user.id,
        type: "INDOOR_CO2" as const,
        unit: "ppm",
        source: "EXTERNAL" as const,
        ...r,
      })),
    });

    const series = await fetchIndoorClimateSeries(
      user.id,
      TZ,
      new Date(Date.now() - 30 * DAY_MS),
    );
    const co2 = series.find((s) => s.key === "INDOOR_CO2");
    // Two evening hours at 600, three morning hours at 1000: (1200 + 3000) / 5.
    expect(co2?.points).toEqual([{ day: wake, value: 840 }]);
    expect(co2?.targets).toEqual(["SLEEP_DURATION"]);
  });

  it("sums a nutrient day across sources", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);
    await prisma.nutrientIntakeDay.createMany({
      data: [
        {
          userId: user.id,
          day: dayKey(3),
          nutrient: "water",
          amount: 1500,
          unit: "ml",
          source: "APPLE_HEALTH",
        },
        {
          userId: user.id,
          day: dayKey(3),
          nutrient: "water",
          amount: 250,
          unit: "ml",
          source: "MANUAL",
        },
        {
          userId: user.id,
          day: dayKey(3),
          nutrient: "caffeine",
          amount: 160,
          unit: "mg",
          source: "APPLE_HEALTH",
        },
      ],
    });
    const series = await fetchNutrientSeries(
      user.id,
      TZ,
      new Date(Date.now() - 30 * DAY_MS),
    );
    expect(series.find((s) => s.key === "HYDRATION")?.points).toEqual([
      { day: dayKey(3), value: 1750 },
    ]);
    expect(series.find((s) => s.key === "CAFFEINE")?.points).toEqual([
      { day: dayKey(3), value: 160 },
    ]);
  });

  it("reads alcohol days from the flat tag list and skips deleted entries", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);
    const data = [];
    for (let d = 1; d <= 12; d += 1) {
      data.push({
        userId: user.id,
        date: dayKey(d),
        mood: "GUT",
        score: 4,
        source: "MANUAL",
        moodLoggedAt: new Date(`${dayKey(d)}T12:00:00Z`),
        tags: d % 2 === 0 ? JSON.stringify(["alcohol"]) : null,
      });
    }
    data.push({
      userId: user.id,
      date: dayKey(13),
      mood: "GUT",
      score: 4,
      source: "MANUAL",
      moodLoggedAt: new Date(`${dayKey(13)}T12:00:00Z`),
      tags: JSON.stringify(["alcohol"]),
      deletedAt: new Date(),
    });
    await prisma.moodEntry.createMany({ data });
    const series = await fetchAlcoholSeries(
      user.id,
      TZ,
      new Date(Date.now() - 30 * DAY_MS),
    );
    expect(series.points).toHaveLength(12);
    expect(series.points.filter((p) => p.value === 1)).toHaveLength(6);
  });

  it("counts a workout stored by two services once and reads the stored impulse", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);
    const start = new Date(`${dayKey(4)}T10:00:00Z`);
    await prisma.workout.createMany({
      data: [
        {
          userId: user.id,
          sportType: "RUNNING",
          source: "APPLE_HEALTH",
          startedAt: start,
          endedAt: new Date(start.getTime() + 1800_000),
          durationSec: 1800,
          externalId: "a",
        },
        {
          userId: user.id,
          sportType: "RUNNING",
          source: "STRAVA",
          startedAt: new Date(start.getTime() + 30_000),
          endedAt: new Date(start.getTime() + 1830_000),
          durationSec: 1795,
          externalId: "s",
        },
      ],
    });
    await prisma.strainTrimpCache.createMany({
      data: [
        {
          userId: user.id,
          day: dayKey(4),
          dayTrimp: 70,
          refPersonal: 150,
          anchor: "population",
          trainingDays: 1,
        },
        {
          userId: user.id,
          day: dayKey(2),
          dayTrimp: 30,
          refPersonal: 150,
          anchor: "population",
          trainingDays: 2,
        },
      ],
    });
    const [minutes, load] = await fetchTrainingSeries(
      user.id,
      TZ,
      new Date(Date.now() - 30 * DAY_MS),
    );
    expect(minutes.points).toEqual([{ day: dayKey(4), value: 30 }]);
    expect(load.points).toEqual([
      { day: dayKey(4), value: 70 },
      { day: dayKey(3), value: 0 },
      { day: dayKey(2), value: 30 },
    ]);
  });
});
