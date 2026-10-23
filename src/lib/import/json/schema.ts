/**
 * The schema of `POST /api/import`, one file of the app's own JSON back in.
 *
 * Two of the app's files feed it: the full backup's portable half and the
 * JSON export (both read in their own terms first, `normalize.ts`). What a
 * reading or a mood entry says in either file has a field here, and
 * `json-import-field-coverage.test.ts` holds the two exporters to it: a field
 * either exporter writes is either read below or named there with the reason
 * the import leaves it out.
 *
 * Lives here rather than in the route because the route module may export
 * nothing but its handlers, and the guard needs the field set.
 *
 * The objects are deliberately not strict. A file is a foreign archive: the
 * app's own files carry fields the import leaves out on purpose (row ids, the
 * source, sync bookkeeping), and a strict object would refuse every one of
 * them. An unknown key is stripped, never stored.
 */
import { z } from "zod/v4";

import { RhythmClassification } from "@/generated/prisma/enums";
import { decodeKeyList } from "@/lib/mood/context-vocabulary";
import { isValidTimezone } from "@/lib/tz/format";
import { isoDateTime } from "@/lib/validations/datetime";
import {
  isPlausibleEntryInstant,
  validateEntryInstant,
} from "@/lib/validations/entry-instant";
import {
  glucoseContextEnum,
  measurementTypeEnum,
  validateMeasurementRange,
} from "@/lib/validations/measurement";
import { moodContextSchema, moodLevelEnum } from "@/lib/validations/mood";
import { SLEEP_STAGE_NAMES } from "@/lib/validations/sleep-stage-entry";

import { fallbackMoodDateStart } from "./mood-instant";

/** Rows per section, and the file as a whole, as the route has always capped them. */
export const JSON_IMPORT_MAX_ROWS = 10_000;
export const JSON_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

// The type is the canonical enum, so every type the exporters write comes
// back; a hand-kept subset once dropped four of eleven.
export const jsonImportMeasurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    // A range reading's bounds (an hourly heart-rate statistic's min and
    // max). Without them the reading comes back as a single value.
    valueMin: z.number().finite().optional(),
    valueMax: z.number().finite().optional(),
    unit: z.string(),
    // The canonical entry-instant bound the single POST and edit paths use,
    // so a crafted file cannot forward-date a reading. `validateEntryInstant`
    // rejects any future instant beyond a 5-min skew tolerance and any
    // instant before 1900; the field transforms to a `Date`.
    measuredAt: validateEntryInstant(
      isoDateTime().transform((s) => new Date(s)),
    ),
    glucoseContext: glucoseContextEnum.optional(),
    // A sleep row's stage. Without it a night of stages comes back as that
    // many undifferentiated sleep readings.
    sleepStage: z.enum(SLEEP_STAGE_NAMES).optional(),
    // A device's own verdict on an ECG, a rhythm alert or a steadiness
    // score: the reading's meaning, not a detail of it.
    rhythmClassification: z.enum(RhythmClassification).optional(),
    // Which device wrote the reading (watch, phone). The per-night sleep
    // collapse picks between writers by it.
    deviceType: z.string().min(1).max(32).optional(),
    notes: z.string().optional(),
    // Optional source-stable id. When present, the import upserts on
    // `(userId, type, source=IMPORT, externalId)` so a re-import of the same
    // export is idempotent rather than minting a duplicate set — mirrors the
    // mood path. Absent → first-write-wins create with a NULL externalId
    // (distinct in the unique key), which DOES duplicate on re-import.
    // Stability is enforced per entry in the import loop, not at the
    // field: a schema-level refusal would fail the whole file on one bad
    // row.
    // @external-id-checked-per-entry: src/lib/import/json/measurements.ts
    externalId: z.string().min(1).max(120).optional(),
  })
  .refine(
    (data) => validateMeasurementRange(data.type, data.value) === null,
    "Wert ausserhalb des plausiblen Bereichs",
  )
  .refine(
    (data) =>
      data.valueMin === undefined ||
      data.valueMax === undefined ||
      data.valueMin <= data.valueMax,
    { message: "valueMin must be <= valueMax", path: ["valueMin"] },
  );

/**
 * A multi-select of the day context. The backup writes it as the stored JSON
 * string, unparsed; every other writer sends the list. Both read as the list.
 */
function keyList<T extends z.ZodType>(list: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? decodeKeyList(value) : value),
    list,
  );
}

export const jsonImportMoodContextSchema = moodContextSchema.extend({
  contactCircles: keyList(moodContextSchema.shape.contactCircles),
  leisureCategories: keyList(moodContextSchema.shape.leisureCategories),
});

const levelADimension = z.number().int().min(0).max(10);

export const jsonImportMoodEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    mood: moodLevelEnum,
    score: z.number().int().min(1).max(5),
    // The five level-A values. `a1` is derived from `mood` when the file
    // leaves it out; the other four are only ever what the person answered.
    a1: levelADimension.optional(),
    a2: levelADimension.optional(),
    a3: levelADimension.optional(),
    a4: levelADimension.optional(),
    a5: levelADimension.optional(),
    tags: z.string().optional(),
    // Capped like every other mood note.
    note: z.string().max(500).optional(),
    // The same entry-instant bound as measurements; an imported mood log
    // cannot be forward-dated. Optional, and a `Date` when set.
    loggedAt: validateEntryInstant(
      isoDateTime().transform((s) => new Date(s)),
    ).optional(),
    // The zone the `date` string is anchored to. Absent, the entry keeps the
    // legacy reading, which is what an entry without one always meant.
    tz: z
      .string()
      .max(64)
      .refine(isValidTimezone, { message: "Unknown time zone" })
      .optional(),
    // The entry's rated factors and ticked tags, by catalogue key. A key the
    // importing account cannot resolve costs that one link, and is counted.
    factors: z
      .array(
        z.object({
          key: z.string().max(60),
          rating: z.number().int().min(1).max(5),
        }),
      )
      .max(30)
      .optional(),
    structuredTags: z.array(z.string().max(60)).max(30).optional(),
    // The day context. Absent says nothing about it; a file that carries one
    // replaces whatever the entry held.
    context: jsonImportMoodContextSchema.optional(),
    // Optional source-stable id (e.g. a Daylio row id). When
    // present, the import upserts on `(userId, source, externalId)` so a
    // re-import of the same export is idempotent rather than minting a
    // duplicate; absent → the legacy first-write-wins create path.
    // Stability is enforced per entry in the import loop, not at the
    // field: a schema-level refusal would fail the whole file on one bad
    // row.
    // @external-id-checked-per-entry: src/lib/import/json/mood.ts
    externalId: z.string().min(1).max(120).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.loggedAt) return;
    const dateStart = fallbackMoodDateStart(entry.date);
    if (!dateStart || !isPlausibleEntryInstant(dateStart)) {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "Mood date must be between 1900 and today",
      });
    }
  });

export const jsonImportSchema = z.object({
  measurements: z
    .array(jsonImportMeasurementSchema)
    .max(JSON_IMPORT_MAX_ROWS)
    .optional(),
  moodEntries: z
    .array(jsonImportMoodEntrySchema)
    .max(JSON_IMPORT_MAX_ROWS)
    .optional(),
});

export type JsonImportMeasurement = z.infer<typeof jsonImportMeasurementSchema>;
export type JsonImportMoodEntry = z.infer<typeof jsonImportMoodEntrySchema>;
