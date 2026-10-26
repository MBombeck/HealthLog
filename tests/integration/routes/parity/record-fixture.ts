/**
 * One representative health record for the read-route parity walks.
 *
 * The aggregate routes (`/api/analytics`, `/api/dashboard/summary`,
 * `/api/insights/comprehensive`, `/api/insights/generate`) shape their body
 * from many domains at once, so a parity walk over them needs a record in
 * which every block has something to say: daily weight and blood pressure
 * long enough for the 90-day windows, a resting-pulse series, glucose in
 * three meal contexts (one untagged), staged sleep nights with a nap, steps,
 * oxygen saturation, HRV, a mood diary, a blood-pressure medication with an
 * intake history that has skips and gaps, a second medication, and an open
 * illness episode.
 *
 * Every value is a function of the day offset from `now`, so the record is
 * the same on every run. Medications carry fixed ids, because some payloads
 * hash or echo them; measurement ids are generated and blanked by `stable`.
 *
 * Not a test file. Only for tests under `tests/integration/`.
 */
import type { Prisma } from "@/generated/prisma/client";

import { getPrismaClient } from "../../setup";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A cuid-shaped fixed id: `c` and 24 lower-case alphanumerics. */
export function parityId(tag: string, n: number): string {
  return `c${`${tag}${n.toString(36)}`.padStart(24, "0")}`;
}

/** A local `YYYY-MM-DD` key of `at` in `tz`. */
function dayKey(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The UTC instant `hh:mm` on the day `d` days before `now`. */
function at(now: Date, d: number, hh: number, mm = 0): Date {
  const base = new Date(now.getTime() - d * DAY_MS);
  base.setUTCHours(hh, mm, 0, 0);
  return base;
}

export interface RecordFixture {
  bpMedicationId: string;
  otherMedicationId: string;
}

/**
 * Write the record onto an existing account. `tag` keeps the fixed ids of
 * two records in one database apart.
 */
export async function seedParityRecord(options: {
  userId: string;
  now: Date;
  tz: string;
  tag: string;
}): Promise<RecordFixture> {
  const { userId, now, tz, tag } = options;
  const prisma = getPrismaClient();
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const push = (row: Omit<Prisma.MeasurementCreateManyInput, "userId">) =>
    rows.push({ userId, createdAt: row.measuredAt, ...row });

  for (let d = 0; d < 60; d++) {
    push({
      type: "WEIGHT",
      value: Math.round((82 + d * 0.04) * 10) / 10,
      unit: "kg",
      source: "WITHINGS",
      deviceType: "scale",
      measuredAt: at(now, d, 6, 30),
    });
    push({
      type: "PULSE",
      value: 64 + (d % 6),
      unit: "bpm",
      measuredAt: at(now, d, 7, 1),
    });
    if (d % 7 === 0) {
      push({
        type: "BODY_FAT",
        value: Math.round((24 + d * 0.02) * 10) / 10,
        unit: "%",
        source: "WITHINGS",
        measuredAt: at(now, d, 6, 31),
      });
    }
  }
  for (let d = 0; d < 120; d++) {
    push({
      type: "BLOOD_PRESSURE_SYS",
      value: 123 + ((d * 7) % 15),
      unit: "mmHg",
      measuredAt: at(now, d, 7, 0),
    });
    push({
      type: "BLOOD_PRESSURE_DIA",
      value: 78 + ((d * 5) % 9),
      unit: "mmHg",
      measuredAt: at(now, d, 7, 0),
    });
  }
  for (let d = 0; d < 40; d++) {
    push({
      type: "RESTING_HEART_RATE",
      value: 58 + (d % 4),
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: at(now, d, 5, 0),
    });
  }
  for (let d = 0; d < 20; d++) {
    push({
      type: "BLOOD_GLUCOSE",
      value: 92 + (d % 7),
      unit: "mg/dL",
      glucoseContext: "FASTING",
      measuredAt: at(now, d, 6, 15),
    });
    push({
      type: "BLOOD_GLUCOSE",
      value: 128 + ((d * 3) % 20),
      unit: "mg/dL",
      glucoseContext: "POSTPRANDIAL",
      measuredAt: at(now, d, 11, 0),
    });
    push({
      type: "BLOOD_GLUCOSE",
      value: 105 + (d % 4),
      unit: "mg/dL",
      measuredAt: at(now, d, 10, 0),
    });
  }
  // Staged nights ending on the morning of each wake day, and one nap.
  for (let d = 0; d < 21; d++) {
    const stage = (
      sleepStage: "CORE" | "DEEP" | "REM" | "AWAKE",
      hh: number,
      mm: number,
      minutes: number,
    ) =>
      push({
        type: "SLEEP_DURATION",
        value: minutes,
        unit: "min",
        source: "APPLE_HEALTH",
        deviceType: "watch",
        sleepStage,
        measuredAt: at(now, d, hh, mm),
      });
    stage("CORE", 1, 0, 200 + (d % 5) * 10);
    stage("DEEP", 2, 30, 70 + (d % 3) * 5);
    stage("REM", 4, 0, 85 + (d % 4) * 5);
    stage("AWAKE", 4, 15, 12);
  }
  push({
    type: "SLEEP_DURATION",
    value: 35,
    unit: "min",
    source: "APPLE_HEALTH",
    deviceType: "watch",
    sleepStage: "CORE",
    measuredAt: at(now, 2, 13, 40),
  });
  for (let d = 0; d < 30; d++) {
    push({
      type: "ACTIVITY_STEPS",
      value: 6000 + ((d * 373) % 4000),
      unit: "count",
      source: "APPLE_HEALTH",
      measuredAt: at(now, d, 9, 0),
    });
    push({
      type: "HEART_RATE_VARIABILITY",
      value: 45 + (d % 8),
      unit: "ms",
      source: "APPLE_HEALTH",
      measuredAt: at(now, d, 4, 30),
    });
  }
  for (let d = 0; d < 10; d++) {
    push({
      type: "OXYGEN_SATURATION",
      value: 96 + (d % 3),
      unit: "%",
      source: "APPLE_HEALTH",
      measuredAt: at(now, d, 4, 40),
    });
  }
  await prisma.measurement.createMany({ data: rows });

  const moods = ["LAUSIG", "SCHLECHT", "OKAY", "GUT", "SUPER_GUT"];
  const moodRows: Prisma.MoodEntryCreateManyInput[] = [];
  for (let d = 0; d < 45; d++) {
    const score = 1 + ((d * 3) % 5);
    const loggedAt = at(now, d, 9, 30);
    moodRows.push({
      userId,
      date: dayKey(loggedAt, tz),
      mood: moods[score - 1],
      score,
      moodLoggedAt: loggedAt,
      tz,
      createdAt: loggedAt,
    });
  }
  await prisma.moodEntry.createMany({ data: moodRows });

  const bpMedicationId = parityId(`${tag}med`, 1);
  const otherMedicationId = parityId(`${tag}med`, 2);
  const created = new Date(now.getTime() - 90 * DAY_MS);
  await prisma.medication.create({
    data: {
      id: bpMedicationId,
      userId,
      name: "Ramipril",
      dose: "5mg",
      createdAt: created,
      schedules: {
        create: [
          {
            id: parityId(`${tag}sch`, 1),
            windowStart: "08:00",
            windowEnd: "10:00",
          },
        ],
      },
      categoryAssignment: { create: { category: "BLOOD_PRESSURE" } },
    },
  });
  await prisma.medication.create({
    data: {
      id: otherMedicationId,
      userId,
      name: "Vitamin D",
      dose: "1000 IU",
      createdAt: created,
      schedules: {
        create: [
          {
            id: parityId(`${tag}sch`, 2),
            windowStart: "20:00",
            windowEnd: "21:00",
          },
        ],
      },
    },
  });
  const intakes: Prisma.MedicationIntakeEventCreateManyInput[] = [];
  for (let d = 1; d <= 45; d++) {
    if (d % 9 === 0) continue;
    const scheduledFor = at(now, d, 6, 0);
    const skipped = d % 7 === 0;
    intakes.push({
      id: parityId(`${tag}ie`, d),
      userId,
      medicationId: bpMedicationId,
      scheduledFor,
      takenAt: skipped ? null : at(now, d, 6, 20),
      skipped,
      createdAt: scheduledFor,
    });
    if (d % 2 === 0) {
      const evening = at(now, d, 18, 0);
      intakes.push({
        id: parityId(`${tag}ie`, 100 + d),
        userId,
        medicationId: otherMedicationId,
        scheduledFor: evening,
        takenAt: at(now, d, 18, 30),
        createdAt: evening,
      });
    }
  }
  await prisma.medicationIntakeEvent.createMany({ data: intakes });

  await prisma.illnessEpisode.create({
    data: {
      id: parityId(`${tag}ill`, 1),
      userId,
      label: "Common cold",
      type: "INFECTION",
      onsetAt: new Date(now.getTime() - 3 * DAY_MS),
      createdAt: new Date(now.getTime() - 3 * DAY_MS),
    },
  });

  return { bpMedicationId, otherMedicationId };
}
