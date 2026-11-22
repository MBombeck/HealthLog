/**
 * The mood slice of the backup payload schema.
 *
 * Part of the mood backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

/**
 * `MoodEntry.tags` is stored as a JSON-array-as-string in the
 * `mood_entries.tags` column ("[\"work\",\"sleep\"]"). The previous
 * schema accepted any `string` here, so a malformed blob in a backup
 * (or one tampered with mid-restore) would land in the DB and crash
 * downstream readers that `JSON.parse` it. We now refine to one of
 * `null` / empty-string (legacy null wire format) / a JSON string
 * that parses to a `string[]`. v1.4.15 H2.
 */
export const moodEntryTagsSchema = z
  .union([z.null(), z.string()])
  .nullable()
  .optional()
  .refine(
    (v) => {
      if (v == null || v === "") return true;
      try {
        const parsed = JSON.parse(v) as unknown;
        return (
          Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
        );
      } catch {
        return false;
      }
    },
    { message: "tags must be null, empty, or a JSON array of strings" },
  );
export const moodFactorSchema = z
  .object({
    key: z.string().min(1),
    rating: z.number().int(),
  })
  .passthrough();
export const moodEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    date: z.string().min(1),
    mood: z.string().min(1),
    score: z.number().int().min(0).max(10),
    // The five level-A values. Optional and nullable: a file written before
    // they existed carries none, and an entry whose sliders were never touched
    // carries nulls. Absent restores as NULL, never as a defaulted midpoint —
    // a restore that invents an answer is worse than one that admits none.
    a1: z.number().int().min(0).max(10).nullable().optional(),
    a2: z.number().int().min(0).max(10).nullable().optional(),
    a3: z.number().int().min(0).max(10).nullable().optional(),
    a4: z.number().int().min(0).max(10).nullable().optional(),
    a5: z.number().int().min(0).max(10).nullable().optional(),
    tags: moodEntryTagsSchema,
    // The free text, in both storage shapes. A portable export carries the
    // decrypted `note`; a disaster-recovery file carries `noteEncrypted` plus
    // whatever legacy plaintext the row still holds. Same pair, and same
    // handling on restore, as `Measurement.notes` / `notesEncrypted`.
    note: z.string().nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    source: z.string().min(1).optional(),
    externalId: z.string().nullable().optional(),
    loggedAt: isoDateTime,
    // The IANA zone the `date` string is anchored to. Absent means the legacy
    // Europe/Berlin reading, which is what a row written before v1.4.25 means
    // by a NULL here — so an old file keeps its old meaning exactly.
    tz: z.string().nullable().optional(),
    syncedAt: isoDateTime.optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    // Equal to `deletedAt` when the phone reported the deletion (v1.49.0).
    appleHealthDeletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    factors: z.array(moodFactorSchema).default([]),
    // BINARY structured-tag keys. Separate from `factors`, which keeps its
    // RATED-only meaning, so every file written before this one parses
    // unchanged and restores identically: absent reads as none.
    structuredTags: z.array(z.string().min(1)).default([]),
    // When each link (rated or not) was written, by tag key. Disaster-recovery
    // files only; a file without it restores the links stamped with the
    // restore, as before.
    linkCreatedAt: z
      .array(z.object({ key: z.string().min(1), createdAt: isoDateTime }))
      .optional(),
    // The day context, when the entry had one. Optional and nullable at the
    // top: a file written before this existed carries no `context` key at all
    // and must parse and restore exactly as it did. Every field inside is
    // optional for the same reason a context row's columns are nullable —
    // only the sections somebody opened say anything.
    //
    // The two multi-selects ride as the stored JSON string rather than as
    // arrays, so the restore writes the column back verbatim and a file cannot
    // arrive with a list the parser and the column disagree about. Nothing is
    // re-validated against the vocabulary here: a backup restores what the
    // account had, and a key retired between the export and the restore is
    // still that person's answer.
    context: z
      .object({
        workStatus: z.string().nullable().optional(),
        workMinutes: z.number().int().nullable().optional(),
        overtimeMinutes: z.number().int().nullable().optional(),
        workLoad: z.number().int().nullable().optional(),
        workSatisfaction: z.number().int().nullable().optional(),
        contactCircles: z.string().nullable().optional(),
        contactForm: z.string().nullable().optional(),
        contactExtent: z.string().nullable().optional(),
        contactQuality: z.number().int().nullable().optional(),
        contactSupport: z.number().int().nullable().optional(),
        leisureCategories: z.string().nullable().optional(),
        leisureMinutes: z.number().int().nullable().optional(),
        leisureJoy: z.number().int().nullable().optional(),
        leisureRecovery: z.number().int().nullable().optional(),
        eventType: z.string().nullable().optional(),
        eventValence: z.number().int().nullable().optional(),
        eventAt: isoDateTime.nullable().optional(),
        // Same pair as the entry's own note: a portable file carries the
        // plain text, a disaster-recovery file the ciphertext.
        note: z.string().nullable().optional(),
        notesEncrypted: base64BytesSchema.nullable().optional(),
        // The context row's own stamps, disaster-recovery files only.
        createdAt: isoDateTime.optional(),
        updatedAt: isoDateTime.optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
/**
 * A mood tag the account created, as opposed to the seeded catalogue.
 *
 * Carried for the same reason as a custom cycle symptom, but the failure it
 * prevents is louder: the restore resolves an entry's rated factors by key and
 * throws on one it cannot find, so an account with a single custom rated tag
 * could not be restored at all.
 */
export const customMoodTagSchema = z
  .object({
    id: z.string().min(1).optional(),
    key: z.string().min(1),
    labelKey: z.string().min(1),
    categoryId: z.string().min(1),
    // "BINARY" | "RATED", enforced in app code rather than a DB enum.
    kind: z.string().min(1),
    isActive: z.boolean().default(true),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().default(0),
    // The user's own words for the tag. Without it the tag comes back as a
    // bare key and the person who named it "Migräne" gets `custom:cm3x9…`
    // instead. Ciphertext on a disaster-recovery file, readable `label` on a
    // portable one; the restore seals the readable value under its own key.
    labelEncrypted: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    // The scale a RATED factor was recorded on. `inverse` marks a factor
    // where a HIGH value is bad (stress, conflict). Dropping it does not lose
    // a label, it silently reverses the meaning of every rating already
    // stored against that tag.
    scaleMin: z.number().int().default(1),
    scaleMax: z.number().int().default(5),
    inverse: z.boolean().default(false),
  })
  .passthrough();
/**
 * A grouping the account created for its own mood factors. `id` is REQUIRED,
 * unlike everywhere else in this file, because a custom tag addresses its
 * category by that id and nothing else can resolve the pairing.
 */
export const customMoodTagCategorySchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
    labelKey: z.string().min(1),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    // Same split as the custom tag's label.
    labelEncrypted: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
  })
  .passthrough();
/** A tag the account hid, named by key so a seeded tag resolves anywhere. */
export const hiddenMoodTagSchema = z
  .object({
    key: z.string().min(1),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();
