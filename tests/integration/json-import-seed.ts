/**
 * One account with every column the exporters read filled in, for the JSON
 * import's round trip and its field-coverage guard.
 *
 * Every reading carries what makes it that reading: a range keeps its bounds,
 * a sleep night its stages and its writer, a rhythm alert its verdict, a
 * glucose value its meal-time context, a note its text. The mood entry
 * carries a note, all five level-A values, its zone, a catalogue factor and
 * tag, the account's own tag and its own rated factor (in a group of its own)
 * and a full day context. A field
 * the seed leaves empty is a field neither test can see arrive, so nothing
 * here is left at its default.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { encodeKeyList } from "@/lib/mood/context-vocabulary";
import { encryptCustomLabel } from "@/lib/mood/custom-tags";

import { makeUser } from "../kit/factories";

export const JI_FACTOR_KEY = "ji_sleep_quality";
export const JI_TAG_KEY = "ji_headache";
/** The account's own tag, in a seeded group. */
export const JI_OWN_TAG_KEY = "custom:ji_long_walk";
/** The account's own group, and its own rated factor in it. */
export const JI_OWN_CATEGORY_KEY = "customcat:ji_outdoors";
export const JI_OWN_FACTOR_KEY = "custom:ji_trail_feel";
export const JI_OWN_TAG_LABEL = "Long walk";

export const JI_MEASUREMENTS = [
  {
    type: "WEIGHT",
    value: 81.4,
    unit: "kg",
    at: "2026-09-10T06:30:00.000Z",
    note: "after the run",
  },
  {
    type: "PULSE",
    value: 64,
    valueMin: 52,
    valueMax: 91,
    unit: "bpm",
    at: "2026-09-11T07:00:00.000Z",
    deviceType: "watch",
  },
  {
    type: "BLOOD_GLUCOSE",
    value: 104,
    unit: "mg/dL",
    at: "2026-09-12T08:00:00.000Z",
    glucoseContext: "FASTING",
  },
  {
    type: "BLOOD_GLUCOSE",
    value: 141,
    unit: "mg/dL",
    at: "2026-09-12T13:00:00.000Z",
    note: "after lunch",
    glucoseContext: "POSTPRANDIAL",
  },
  {
    type: "IRREGULAR_RHYTHM_NOTIFICATION",
    value: 1,
    unit: "count",
    at: "2026-09-12T15:00:00.000Z",
    rhythmClassification: "IRREGULAR",
    deviceType: "watch",
  },
  // One night, as a watch writes it: a stage per row.
  {
    type: "SLEEP_DURATION",
    value: 70,
    unit: "minutes",
    at: "2026-09-12T23:40:00.000Z",
    sleepStage: "DEEP",
    deviceType: "watch",
  },
  {
    type: "SLEEP_DURATION",
    value: 240,
    unit: "minutes",
    at: "2026-09-13T03:40:00.000Z",
    sleepStage: "CORE",
    deviceType: "watch",
  },
  {
    type: "SLEEP_DURATION",
    value: 95,
    unit: "minutes",
    at: "2026-09-13T05:15:00.000Z",
    sleepStage: "REM",
    deviceType: "watch",
  },
] as const;

export const JI_MOOD = {
  date: "2026-09-12",
  mood: "GUT",
  score: 4,
  a1: 8,
  a2: 3,
  a3: 6,
  a4: 7,
  a5: 5,
  tags: JSON.stringify(["work", "sleep"]),
  note: "long day, good evening",
  tz: "America/New_York",
  at: "2026-09-13T01:30:00.000Z",
} as const;

/** A second entry with nothing but the label: what a one-tap check-in writes. */
export const JI_MOOD_BARE = {
  date: "2026-09-11",
  mood: "OKAY",
  score: 3,
  at: "2026-09-11T20:30:00.000Z",
} as const;

export interface SeededOwner {
  ownerId: string;
}

/** The catalogue the links resolve against: seeded rows, owned by no account. */
export async function seedJsonImportCatalogue(
  prisma: PrismaClient,
): Promise<void> {
  // Fixed ids, as the migrations seed the real catalogue (whose `custom`
  // group the test database holds too): a group's id is the same on every
  // server, which is what lets an imported tag find it.
  const category = await prisma.moodTagCategory.create({
    data: {
      id: "mtc_ji_category",
      key: "ji_category",
      labelKey: "mood.tagCategory.ji",
    },
  });
  await prisma.moodTag.create({
    data: {
      id: "mt_ji_headache",
      categoryId: category.id,
      key: JI_TAG_KEY,
      labelKey: "mood.tag.jiHeadache",
      kind: "BINARY",
    },
  });
  await prisma.moodTag.create({
    data: {
      id: "mt_ji_sleep_quality",
      categoryId: category.id,
      key: JI_FACTOR_KEY,
      labelKey: "mood.tag.jiSleepQuality",
      kind: "RATED",
      scaleMin: 1,
      scaleMax: 5,
    },
  });
}

export async function seedJsonImportOwner(
  prisma: PrismaClient,
): Promise<SeededOwner> {
  const owner = await makeUser({
    timezone: "Europe/Berlin",
    glucoseUnit: "mmol/L" /* the JSON export stays in the stored unit */,
  });
  const ownerId = owner.id;
  for (const m of JI_MEASUREMENTS) {
    await prisma.measurement.create({
      data: {
        userId: ownerId,
        type: m.type,
        value: m.value,
        valueMin: "valueMin" in m ? m.valueMin : null,
        valueMax: "valueMax" in m ? m.valueMax : null,
        unit: m.unit,
        measuredAt: new Date(m.at),
        source: "APPLE_HEALTH",
        notes: null,
        notesEncrypted: encryptNote("note" in m ? m.note : null),
        glucoseContext: "glucoseContext" in m ? m.glucoseContext : null,
        sleepStage: "sleepStage" in m ? m.sleepStage : null,
        rhythmClassification:
          "rhythmClassification" in m ? m.rhythmClassification : null,
        deviceType: "deviceType" in m ? m.deviceType : null,
      },
    });
  }
  // A reading deleted before the backup: its row is the record of a
  // deletion, and the import leaves it out.
  await prisma.measurement.create({
    data: {
      userId: ownerId,
      type: "WEIGHT",
      value: 90,
      unit: "kg",
      measuredAt: new Date("2026-09-09T06:30:00.000Z"),
      source: "MANUAL",
      deletedAt: new Date("2026-09-09T07:00:00.000Z"),
    },
  });

  const category = await prisma.moodTagCategory.findUniqueOrThrow({
    where: { key: "ji_category" },
  });
  const ownTag = await prisma.moodTag.create({
    data: {
      userId: ownerId,
      categoryId: category.id,
      key: JI_OWN_TAG_KEY,
      labelKey: "mood.tag.custom",
      kind: "BINARY",
      labelEncrypted: encryptCustomLabel(JI_OWN_TAG_LABEL),
    },
  });
  const ownCategory = await prisma.moodTagCategory.create({
    data: {
      userId: ownerId,
      key: JI_OWN_CATEGORY_KEY,
      labelKey: "mood.tagCategory.custom",
      icon: null,
      sortOrder: 7,
      labelEncrypted: encryptCustomLabel("Outdoors"),
    },
  });
  const ownFactor = await prisma.moodTag.create({
    data: {
      userId: ownerId,
      categoryId: ownCategory.id,
      key: JI_OWN_FACTOR_KEY,
      labelKey: "mood.tag.custom",
      kind: "RATED",
      scaleMin: 1,
      scaleMax: 5,
      inverse: true,
      sortOrder: 2,
      labelEncrypted: encryptCustomLabel("How the trail felt"),
    },
  });
  const [tag, factor] = await Promise.all([
    prisma.moodTag.findUniqueOrThrow({ where: { key: JI_TAG_KEY } }),
    prisma.moodTag.findUniqueOrThrow({ where: { key: JI_FACTOR_KEY } }),
  ]);

  const entry = await prisma.moodEntry.create({
    data: {
      userId: ownerId,
      date: JI_MOOD.date,
      mood: JI_MOOD.mood,
      score: JI_MOOD.score,
      moodA1: JI_MOOD.a1,
      stressA2: JI_MOOD.a2,
      energyA3: JI_MOOD.a3,
      connectionA4: JI_MOOD.a4,
      stabilityA5: JI_MOOD.a5,
      tags: JI_MOOD.tags,
      note: null,
      noteEncrypted: encryptNote(JI_MOOD.note),
      tz: JI_MOOD.tz,
      source: "MANUAL",
      moodLoggedAt: new Date(JI_MOOD.at),
    },
  });
  await prisma.moodEntryTagLink.createMany({
    data: [
      { moodEntryId: entry.id, moodTagId: tag.id },
      { moodEntryId: entry.id, moodTagId: ownTag.id },
      { moodEntryId: entry.id, moodTagId: factor.id, rating: 4 },
      { moodEntryId: entry.id, moodTagId: ownFactor.id, rating: 2 },
    ],
  });
  await prisma.moodContext.create({
    data: {
      moodEntryId: entry.id,
      userId: ownerId,
      workStatus: "regular",
      workMinutes: 540,
      overtimeMinutes: 60,
      workLoad: 7,
      workSatisfaction: 6,
      contactCircles: encodeKeyList(["partner", "family"]),
      contactForm: "inPerson",
      contactExtent: "extended",
      contactQuality: 8,
      contactSupport: 7,
      leisureCategories: encodeKeyList(["reading"]),
      leisureMinutes: 90,
      leisureJoy: 8,
      leisureRecovery: 7,
      eventType: "goodNews",
      eventValence: 3,
      eventAt: new Date("2026-09-12T18:00:00.000Z"),
      notesEncrypted: encryptNote("the call went well"),
    },
  });
  await prisma.moodEntry.create({
    data: {
      userId: ownerId,
      date: JI_MOOD_BARE.date,
      mood: JI_MOOD_BARE.mood,
      score: JI_MOOD_BARE.score,
      moodA1: 5,
      source: "MANUAL",
      moodLoggedAt: new Date(JI_MOOD_BARE.at),
    },
  });
  return { ownerId };
}
