/**
 * Zod schemas + helpers for the per-user `DataBackup` JSON payload.
 *
 * Single source of truth shared by:
 *   - the pg-boss `data-backup` worker that writes a backup,
 *   - `GET /api/admin/backups/[id]/download` that streams it back as JSON,
 *   - `POST /api/admin/backups/upload` that ingests an admin-supplied file,
 *   - `POST /api/admin/backups/[id]/restore` that re-creates DB rows from it.
 *
 * The schema is intentionally permissive about *extra* fields (`.passthrough`)
 * so older snapshots written before a column was added still parse and so
 * future minor additions don't break old admins. Required fields are
 * deliberately tight — any drift surfaces as a validation error rather than
 * a silent data-loss restore.
 *
 * `schemaVersion` is the migration handle. Bump when the on-disk shape
 * changes incompatibly. The current writer (worker) historically did NOT
 * include this field; `parseBackupPayload()` defaults it to "1" so legacy
 * blobs continue to round-trip and the upload validator can still produce
 * a useful summary for them.
 */
import { z } from "zod/v4";
import {
  AllergyCategory,
  AllergySeverity,
  AllergyStatus,
  AllergyType,
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  CycleTrackingGoal,
  DocumentSummaryState,
  EncounterKind,
  EncounterStatus,
  ExtractedFactStatus,
  ExtractedFactType,
  EnvironmentLocationSource,
  FamilyRelationship,
  FlowLevel,
  GlucoseContext,
  HomeTestResult,
  IllnessLifecycle,
  IllnessType,
  InboundDocumentKind,
  InboundDocumentStatus,
  InjectionSite,
  IntakeAttributionSource,
  IntakeSource,
  MeasurementAggregationProvenance,
  MeasurementReminderEventKind,
  MeasurementSource,
  MeasurementType,
  AssessmentInstrument,
  MedicationCategory,
  PhaseMode,
  MedicationContainerType,
  MedicationInventoryState,
  MedicationDeliveryForm,
  MedicationScheduleType,
  MedicationSideEffectCategory,
  MedicationSideEffectEntry,
  OvulationTest,
  PersonalRecordDirection,
  ReminderOrigin,
  RhythmClassification,
  SecondarySymptom,
  SleepStage,
  VaccinationSite,
} from "@/generated/prisma/enums";
import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  healthProfileAiSectionSchema,
  healthProfileFactKindSchema,
  isHealthProfileFactValue,
} from "@/lib/validations/health-profile-facts";
import {
  advanceDirectiveStatusSchema,
  emergencyBloodTypeSchema,
  organDonorStatusSchema,
} from "@/lib/validations/emergency-profile";
import { REMINDER_EVENT_SOURCES } from "@/lib/measurement-reminders/satisfy";

export const BACKUP_SCHEMA_VERSION = "2" as const;
const LEGACY_BACKUP_SCHEMA_VERSION = "1" as const;

const isoDateTime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "Expected ISO-8601 date-time string",
  });

const base64BytesSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    { message: "Expected base64-encoded encrypted bytes" },
  );

const measurementSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: z.enum(MeasurementType),
    value: z.number(),
    valueMin: z.number().nullable().optional(),
    valueMax: z.number().nullable().optional(),
    unit: z.string().min(1),
    measuredAt: isoDateTime,
    source: z.enum(MeasurementSource).optional(),
    notes: z.string().nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    externalId: z.string().nullable().optional(),
    externalSourceVersion: z.string().nullable().optional(),
    // Authority of a `stats:` aggregate. `.optional()` keeps every backup
    // written before this field rode the payload parseable.
    aggregationProvenance: z
      .enum(MeasurementAggregationProvenance)
      .nullable()
      .optional(),
    glucoseContext: z.enum(GlucoseContext).nullable().optional(),
    sleepStage: z.enum(SleepStage).nullable().optional(),
    rhythmClassification: z.enum(RhythmClassification).nullable().optional(),
    deviceType: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const medicationScheduleSchema = z
  .object({
    id: z.string().min(1).optional(),
    windowStart: z.string().min(1),
    windowEnd: z.string().min(1),
    label: z.string().nullable().optional(),
    dose: z.string().nullable().optional(),
    // #219 — per-schedule units per dose. Serialised as a Decimal string in a
    // DR file (or a number in a hand-authored one); NULL means inherit.
    unitsPerDose: z.union([z.string(), z.number()]).nullable().optional(),
    daysOfWeek: z.string().nullable().optional(),
    timesOfDay: z.array(z.string()).optional(),
    reminderGraceMinutes: z.number().int().nullable().optional(),
    rrule: z.string().nullable().optional(),
    rollingIntervalDays: z.number().int().nullable().optional(),
    scheduleType: z.enum(MedicationScheduleType).optional(),
    cyclicOnWeeks: z.number().int().nullable().optional(),
    cyclicOffWeeks: z.number().int().nullable().optional(),
    doseWindows: z.unknown().nullable().optional(),
  })
  .passthrough();

/**
 * One recorded side effect, carried inside its medication.
 *
 * `notes` is the decrypted note in a portable export and the row's legacy
 * plaintext column in a canonical DR file; `notesEncrypted` is the base64
 * ciphertext and rides only in the DR case. The restore prefers the ciphertext
 * and encrypts the plaintext when that is all the file has, so neither shape
 * loses the note and neither writes plaintext back into the column.
 */
const medicationSideEffectSchema = z
  .object({
    id: z.string().min(1).optional(),
    occurredAt: isoDateTime,
    category: z.enum(MedicationSideEffectCategory),
    entry: z.enum(MedicationSideEffectEntry),
    severity: z.number().int().min(1).max(5),
    notes: z.string().nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * A span during which the drug was deliberately not taken.
 *
 * `resumedAt` is nullable rather than optional, and the writer always emits
 * it. An absent key and an explicit `null` would otherwise both have to mean
 * "still paused", and a file that simply forgot the field would assert an open
 * era that never existed. Readers run an open era to `now`.
 */
const medicationPauseEraSchema = z
  .object({
    id: z.string().min(1).optional(),
    pausedAt: isoDateTime,
    resumedAt: isoDateTime.nullable(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One step of a titration: when the dose moved and to what.
 *
 * The note follows the side-effect contract — decrypted prose in a portable
 * file, ciphertext plus any legacy plaintext in a recovery one.
 */
const medicationDoseChangeSchema = z
  .object({
    id: z.string().min(1).optional(),
    effectiveFrom: isoDateTime,
    doseValue: z.number(),
    doseUnit: z.string().min(1),
    note: z.string().nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * A pack on the shelf. `unitsTotal` / `unitsRemaining` cross the wire as
 * STRINGS: the columns are `Decimal(12,4)` because half tablets are a real
 * prescription, and a JSON number would round them on the way through.
 */
const medicationInventoryItemSchema = z
  .object({
    id: z.string().min(1).optional(),
    state: z.enum(MedicationInventoryState).optional(),
    containerType: z.enum(MedicationContainerType).optional(),
    unitsTotal: z.string().min(1),
    unitsRemaining: z.string().min(1),
    firstUseAt: isoDateTime.nullable().optional(),
    expiresAt: isoDateTime.nullable().optional(),
    printedExpiry: isoDateTime.nullable().optional(),
    purchasedAt: isoDateTime.nullable().optional(),
    manufacturer: z.string().nullable().optional(),
    doseStrength: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const medicationInventoryEventSchema = z
  .object({
    id: z.string().min(1).optional(),
    delta: z.number().int(),
    reason: z.string().min(1),
    occurredAt: isoDateTime,
  })
  .passthrough();

/**
 * The four reminder thresholds a drug was tuned to. Every field optional, so a
 * file written before a threshold existed restores the schema default rather
 * than refusing — but the OBJECT is nullable rather than absent, because "no
 * tuning" and "this file does not say" are different claims.
 */
const reminderPhaseConfigSchema = z
  .object({
    id: z.string().min(1).optional(),
    greenValue: z.number().int().optional(),
    greenMode: z.enum(PhaseMode).optional(),
    yellowValue: z.number().int().optional(),
    yellowMode: z.enum(PhaseMode).optional(),
    orangeValue: z.number().int().optional(),
    orangeMode: z.enum(PhaseMode).optional(),
    redValue: z.number().int().optional(),
    redMode: z.enum(PhaseMode).optional(),
  })
  .passthrough();

/**
 * One archived schedule era.
 *
 * `supersededByIndex` is the self-reference, and it is a POSITION in the
 * drug's own `scheduleRevisions` array rather than an id: a portable restore
 * mints fresh ids, so an id would address nothing. It stays a plain integer
 * with no range check here on purpose — the file is the wrong place to learn
 * that a position is out of range, because the array it indexes into is the
 * array being parsed. The restore does that check, against the rows it
 * actually wrote, and reports what it cannot resolve.
 *
 * `payload` is the snapshot of the superseded schedule rows, carried as
 * written. Unknown on purpose rather than typed: it is an era's frozen copy of
 * a shape that has changed several times, and a restore must not refuse a file
 * because a five-release-old snapshot spells a field the current form does not.
 */
const medicationScheduleRevisionSchema = z
  .object({
    id: z.string().min(1).optional(),
    validFrom: isoDateTime,
    validUntil: isoDateTime,
    payload: z.unknown(),
    source: z.string().min(1).optional(),
    supersededByIndex: z.number().int().nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * What a medication was supposed to move.
 *
 * The lab arm is a biomarker NAME rather than an id, the way a lab result's
 * cross-reference is: the id is fresh on a portable restore, and `Biomarker`
 * is unique on `(userId, name)`. Both arms are nullable because the live
 * schema produces a row with neither — deleting a biomarker sets the column
 * NULL and leaves the override behind as an orphan the resolver reads as "no
 * override".
 */
const medicationEfficacyTargetSchema = z
  .object({
    id: z.string().min(1).optional(),
    measurementType: z.enum(MeasurementType).nullable().optional(),
    biomarkerName: z.string().min(1).nullable().optional(),
    primary: z.boolean().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const medicationSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    dose: z.string(),
    treatmentClass: z.enum(MedicationCategory).optional(),
    dosesPerUnit: z.number().int().nullable().optional(),
    unitsPerDose: z.string().min(1).optional(),
    active: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    pausedAt: isoDateTime.nullable().optional(),
    snoozedUntil: isoDateTime.nullable().optional(),
    startsOn: isoDateTime.nullable().optional(),
    endsOn: isoDateTime.nullable().optional(),
    oneShot: z.boolean().optional(),
    asNeeded: z.boolean().optional(),
    deliveryForm: z.enum(MedicationDeliveryForm).optional(),
    trackInjectionSites: z.boolean().optional(),
    allowedInjectionSites: z.array(z.enum(InjectionSite)).optional(),
    liveActivityEnabled: z.boolean().optional(),
    criticalAlarmEnabled: z.boolean().optional(),
    atcCode: z.string().nullable().optional(),
    rxNormCode: z.string().nullable().optional(),
    lowStockNotifiedAt: isoDateTime.nullable().optional(),
    lowStockNotifiedThresholdDays: z.number().int().nullable().optional(),
    reorderLeadDays: z.number().int().nullable().optional(),
    externalSource: z.enum(IntakeSource).nullable().optional(),
    externalId: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    schedules: z.array(medicationScheduleSchema).default([]),
    // Defaulted so a file written before side effects rode the wire still
    // parses, and a drug with none writes [].
    sideEffects: z.array(medicationSideEffectSchema).default([]),
    // Defaulted for the same reason: a file written before pause eras rode the
    // wire still parses, and a drug that was never paused writes [].
    pauseEras: z.array(medicationPauseEraSchema).default([]),
    // Same default, same reason: an older file parses, a drug never titrated
    // writes [].
    doseChanges: z.array(medicationDoseChangeSchema).default([]),
    inventoryItems: z.array(medicationInventoryItemSchema).default([]),
    inventoryEvents: z.array(medicationInventoryEventSchema).default([]),
    phaseConfig: reminderPhaseConfigSchema.nullable().optional(),
    // Same default, same reason: an older file parses, and a drug whose
    // target the resolver derives rather than the person pinning it writes [].
    efficacyTargets: z.array(medicationEfficacyTargetSchema).default([]),
    // Same default again. A drug whose plan has never been replaced has no
    // archived era, and a file written before the eras travelled has no key.
    scheduleRevisions: z.array(medicationScheduleRevisionSchema).default([]),
  })
  .passthrough();

const intakeEventSchema = z
  .object({
    id: z.string().min(1).optional(),
    medicationId: z.string().min(1).optional(),
    medication: z.string().min(1),
    scheduledFor: isoDateTime,
    takenAt: isoDateTime.nullable().optional(),
    skipped: z.boolean().optional(),
    autoMissed: z.boolean().optional(),
    attributionSource: z.enum(IntakeAttributionSource).optional(),
    source: z.enum(IntakeSource).optional(),
    idempotencyKey: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    injectionSite: z.enum(InjectionSite).nullable().optional(),
    doseTaken: z.string().nullable().optional(),
    inventoryConsumption: z.unknown().nullable().optional(),
    externalId: z.string().nullable().optional(),
    updatedAt: isoDateTime.optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

/**
 * `MoodEntry.tags` is stored as a JSON-array-as-string in the
 * `mood_entries.tags` column ("[\"work\",\"sleep\"]"). The previous
 * schema accepted any `string` here, so a malformed blob in a backup
 * (or one tampered with mid-restore) would land in the DB and crash
 * downstream readers that `JSON.parse` it. We now refine to one of
 * `null` / empty-string (legacy null wire format) / a JSON string
 * that parses to a `string[]`. v1.4.15 H2.
 */
const moodEntryTagsSchema = z
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

const moodFactorSchema = z
  .object({
    key: z.string().min(1),
    rating: z.number().int(),
  })
  .passthrough();

const moodEntrySchema = z
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
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    factors: z.array(moodFactorSchema).default([]),
    // BINARY structured-tag keys. Separate from `factors`, which keeps its
    // RATED-only meaning, so every file written before this one parses
    // unchanged and restores identically: absent reads as none.
    structuredTags: z.array(z.string().min(1)).default([]),
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
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/* ── v1.15.0 cycle-tracking backup shapes ──────────────────────────── */

/**
 * One menstrual-cycle span. `startDate` is the natural per-user key
 * (matching the `(userId, startDate)` unique), so a restore upserts on it.
 * Predicted (forecast) rows are excluded from the backup — only observed
 * history round-trips.
 */
const cycleSpanSchema = z
  .object({
    id: z.string().min(1).optional(),
    startDate: z.string().min(1),
    endDate: z.string().nullable().optional(),
    periodEndDate: z.string().nullable().optional(),
    lengthDays: z.number().int().nullable().optional(),
    ovulationDate: z.string().nullable().optional(),
    ovulationConfirmed: z.boolean().optional(),
    isPredicted: z.boolean().optional(),
    tz: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One cycle day-log. `notesEncrypted` is carried as the AES-256-GCM
 * ciphertext envelope verbatim — the backup never decrypts it, so the
 * owner's free-text note round-trips encrypted (and a wrong-surface leak is
 * impossible). `symptomKeys` carries the seeded catalogue keys so the
 * restore can re-link without exporting internal join ids, and
 * `symptomSeverities` carries how hard each of them hit.
 */
/**
 * The intensity recorded against one of a day's symptoms.
 *
 * A sparse annotation over `symptomKeys`, not a replacement for it: the keys
 * still say which symptoms the day had, this says how hard the ones that were
 * rated hit. Only rated links appear, so a missing entry means the person never
 * put a number on it. `severity` is left as a plain integer here on purpose —
 * the 1-4 range is checked when the row is written, so a file carrying a value
 * outside it loses that one intensity instead of failing to restore at all.
 */
const cycleSymptomSeveritySchema = z
  .object({
    key: z.string().min(1),
    severity: z.number().int().nullable().optional(),
  })
  .passthrough();

const cycleDayLogSchema = z
  .object({
    id: z.string().min(1).optional(),
    date: z.string().min(1),
    cycleId: z.string().nullable().optional(),
    flow: z.enum(FlowLevel).nullable().optional(),
    intermenstrualBleeding: z.boolean().optional(),
    basalBodyTempC: z.number().nullable().optional(),
    temperatureExcluded: z.boolean().optional(),
    ovulationTest: z.enum(OvulationTest).nullable().optional(),
    cervicalMucus: z.enum(CervicalMucus).nullable().optional(),
    cervixPosition: z.enum(CervixPosition).nullable().optional(),
    cervixFirmness: z.enum(CervixFirmness).nullable().optional(),
    cervixOpening: z.enum(CervixOpening).nullable().optional(),
    sexualActivity: z.boolean().optional(),
    protectedSex: z.boolean().nullable().optional(),
    pregnancyTest: z.enum(HomeTestResult).nullable().optional(),
    progesteroneTest: z.enum(HomeTestResult).nullable().optional(),
    contraceptive: z.enum(ContraceptiveKind).nullable().optional(),
    sensitiveEncrypted: z.string().nullable().optional(),
    notesEncrypted: z.string().nullable().optional(),
    source: z.enum(MeasurementSource).optional(),
    externalId: z.string().nullable().optional(),
    tz: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    symptomKeys: z.array(z.string()).default([]),
    symptomSeverities: z.array(cycleSymptomSeveritySchema).default([]),
  })
  .passthrough();

/** Cycle-tracking preferences (one row per user). */
const cycleProfileSchema = z
  .object({
    id: z.string().min(1).optional(),
    goal: z.enum(CycleTrackingGoal).optional(),
    cycleTrackingEnabled: z.boolean().nullable().optional(),
    typicalCycleLength: z.number().int().nullable().optional(),
    typicalPeriodLength: z.number().int().nullable().optional(),
    lutealPhaseLength: z.number().int().nullable().optional(),
    secondarySymptom: z.enum(SecondarySymptom).nullable().optional(),
    predictionEnabled: z.boolean().optional(),
    rawChartMode: z.boolean().optional(),
    discreetNotifications: z.boolean().optional(),
    sensitiveCategoryEncryption: z.boolean().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
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
const customMoodTagSchema = z
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
    // The user's own words for the tag, encrypted at rest and carried
    // verbatim. Without it the tag comes back as a bare key and the person
    // who named it "Migräne" gets `custom:cm3x9…` instead.
    labelEncrypted: z.string().nullable().optional(),
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
 * A day's total for one nutrient, from one source.
 *
 * The export has written these since v1.29 and the canonical schema never
 * declared them, so `.passthrough()` carried the key through parsing and no
 * reader ever looked at it. The restore therefore dropped every water and
 * vitamin total on the floor while reporting success.
 */
const nutrientDaySchema = z
  .object({
    day: z.string().min(1),
    nutrient: z.string().min(1),
    amount: z.number(),
    unit: z.string().min(1),
    // Closed set in app code rather than a DB enum; kept as a string here so a
    // future source does not make an old file unparseable.
    source: z.string().min(1),
  })
  .passthrough();

/**
 * A symptom the account created, as opposed to the seeded catalogue.
 *
 * Carried because a day-log's symptom link resolves by key: without the
 * definition the key resolves to nothing on the restoring instance, and the
 * link is lost. The seeded rows are deliberately NOT carried — every instance
 * already has them, and shipping them would mean a restore could rewrite
 * another instance's reference data.
 */
const customCycleSymptomSchema = z
  .object({
    id: z.string().min(1).optional(),
    key: z.string().min(1),
    labelKey: z.string().min(1),
    categoryId: z.string().min(1),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
    // Same reasoning as the mood tag's: the user's own words live here.
    labelEncrypted: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * The account's durable self-context — one row per user.
 *
 * Portable exports carry the decrypted free text; disaster-recovery payloads
 * carry the AES-256-GCM envelopes as base64 and leave the plaintext fields
 * null. The restore prefers ciphertext when the file has it and re-encrypts
 * the plaintext otherwise, which is the same contract the lab note uses.
 */
const healthProfileBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    aboutMe: z.string().nullable().default(null),
    conditions: z.string().nullable().default(null),
    allergies: z.string().nullable().default(null),
    coachFocus: z.string().nullable().default(null),
    aiIncludedSections: z
      .array(healthProfileAiSectionSchema)
      .default([...DEFAULT_HEALTH_PROFILE_AI_SECTIONS]),
    // Emergency profile: three plaintext enums (carried by value in both
    // purposes), three free-text columns following the ciphertext-or-plaintext
    // split of the self-context fields above.
    emergencyBloodType: emergencyBloodTypeSchema.nullable().default(null),
    organDonorStatus: organDonorStatusSchema.nullable().default(null),
    advanceDirectiveStatus: advanceDirectiveStatusSchema
      .nullable()
      .default(null),
    emergencyContacts: z.string().nullable().default(null),
    emergencyImplants: z.string().nullable().default(null),
    emergencyNote: z.string().nullable().default(null),
    emergencyContactsEncrypted: base64BytesSchema.nullable().optional(),
    emergencyImplantsEncrypted: base64BytesSchema.nullable().optional(),
    emergencyNoteEncrypted: base64BytesSchema.nullable().optional(),
    aboutMeEncrypted: base64BytesSchema.nullable().optional(),
    conditionsEncrypted: base64BytesSchema.nullable().optional(),
    allergiesEncrypted: base64BytesSchema.nullable().optional(),
    coachFocusEncrypted: base64BytesSchema.nullable().optional(),
    pendingQuestionsEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const healthProfileFactBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: healthProfileFactKindSchema,
    value: z.string().nullable().default(null),
    valueEncrypted: base64BytesSchema.optional(),
    validFrom: isoDateTime,
    validUntil: isoDateTime.nullable(),
    provenance: z.enum(["USER_REPORTED", "USER_CORRECTION"]),
    supersededByRevisionId: z.string().min(1).nullable(),
    createdAt: isoDateTime,
  })
  .passthrough()
  .superRefine((fact, ctx) => {
    if (fact.valueEncrypted === undefined) {
      if (
        fact.value === null ||
        !isHealthProfileFactValue(fact.kind, fact.value)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "A portable profile fact requires a valid readable value",
        });
      }
    }
    if (
      fact.validUntil !== null &&
      Date.parse(fact.validUntil) <= Date.parse(fact.validFrom)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must be later than validFrom",
      });
    }
  });

/** One reading of a user-defined metric, nested under the metric that owns it. */
const customMetricEntryBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    value: z.number(),
    unit: z.string().min(1),
    measuredAt: isoDateTime,
    note: z.string().nullable().default(null),
    createdAt: isoDateTime.optional(),
    /// v1.37.20 (A3-11) — the entry tombstone rides DR payloads so a restore
    /// brings the account back exactly as it stood, undo affordance included.
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

/**
 * A metric the account defined itself.
 *
 * The one class of series no integration can ever re-sync: nobody else has the
 * definition and nobody else has the readings. It was classified as carried
 * from the day the backup plan was written and carried by nothing, so a
 * restore rebuilt the account without it and reported success.
 *
 * Readings are nested rather than flat-with-a-name-reference so the restore
 * has no parent to look up and therefore no lookup to miss.
 */
const customMetricBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    unit: z.string().min(1),
    targetLow: z.number().nullable().default(null),
    targetHigh: z.number().nullable().default(null),
    decimals: z.number().int().nullable().default(null),
    description: z.string().nullable().default(null),
    correlationEnabled: z.boolean().default(false),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    deletedAt: isoDateTime.nullable().optional(),
    entries: z.array(customMetricEntryBackupSchema).default([]),
  })
  .passthrough();

const correlationPatternBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    canonicalKey: z.string().regex(/^p1:[a-f0-9]{64}$/),
    family: z.string().min(1),
    factorKey: z.string().min(1),
    outcomeKey: z.string().min(1),
    lagDays: z.number().int().min(0),
    sampleSize: z.number().int().positive(),
    effectSize: z.number().finite(),
    pValue: z.number().min(0).max(1),
    qValue: z.number().min(0).max(1).nullable().default(null),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    isCurrent: z.boolean(),
    lastComputedAt: isoDateTime,
    dismissedAt: isoDateTime.nullable().default(null),
    dismissedEvidenceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    dismissedEffectSize: z.number().finite().nullable().default(null),
    dismissedSampleSize: z.number().int().positive().nullable().default(null),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One local day's cumulative curve for one metric.
 *
 * The drain writes this row and deletes the per-sample rows it was folded from
 * in the same transaction, so past the grace window the file is the only copy.
 * `hourlyCumulative` is left unconstrained in length here on purpose: the
 * restore checks it against the slot count it shares with the reader and
 * throws naming the day, which says what is wrong with one row instead of
 * making a whole file unparseable.
 */
const intradayProfileBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: z.enum(MeasurementType),
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hourlyCumulative: z.array(z.number()),
    dayTotal: z.number(),
    sampleCount: z.number().int(),
    // The zone the day was cut on. The reader compares it against the
    // account's current zone and drops the mismatched days, so a restore that
    // dropped this column would make old curves look comparable when their
    // hours mean something else.
    timezone: z.string().min(1),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const healthScoreRecordBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // The zone the day was cut on. An account that moved zones has days of
    // different lengths behind it, and a restore that guessed would make them
    // look comparable.
    timezone: z.string().min(1),
    composite: z.number().int().min(0).max(100),
    // The same closed set the column's CHECK constraint carries. A band the
    // schema let through and the database refused would fail the whole
    // restore transaction on one bad row.
    band: z.enum(["green", "yellow", "red"]),
    scoreVersion: z.number().int(),
    composition: z.array(z.string().min(1)).min(1),
    pillarScores: z.record(z.string(), z.number()),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    configVersion: z.number().int().nullable().default(null),
    configChangedAt: isoDateTime.nullable().default(null),
    computedAt: isoDateTime,
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * v1.39 (C1) — the needs-based setup state. One row per record.
 *
 * The three answer objects are validated loosely on purpose: the closed
 * vocabularies live in `src/lib/onboarding/needs.ts`, and the restore reads
 * every one of them back through the same fail-soft parsers the account
 * payload uses. Duplicating the enums here would give the file a second,
 * quietly divergent opinion about what an answer is, and the failure mode of
 * being stricter here is refusing a whole account's restore over one retired
 * chip.
 */
const onboardingRecordBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    needs: z.record(z.string(), z.unknown()).default({}),
    steps: z.array(z.record(z.string(), z.unknown())).default([]),
    firstResult: z.record(z.string(), z.unknown()).nullable().default(null),
    // The once-only latch on the module derivation. Carried rather than
    // defaulted: a null here would hand the next confirm permission to
    // re-apply the questionnaire over every module decision made since.
    modulesDerivedAt: isoDateTime.nullable().default(null),
    completedAt: isoDateTime.nullable().default(null),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const appSettingsBackupSchema = z
  .object({
    id: z.string().min(1),
    registrationEnabled: z.boolean(),
    mfaRequired: z.boolean(),
    defaultLocale: z.string(),
    telegramGlobal: z.boolean(),
    ntfyGlobal: z.boolean(),
    webPushGlobal: z.boolean(),
    webPushVapidPublicKey: z.string().nullable(),
    webPushVapidPrivateKeyEncrypted: z.string().nullable(),
    webPushVapidSubject: z.string().nullable(),
    apiGlobal: z.boolean(),
    umamiEnabled: z.boolean(),
    umamiScriptUrl: z.string().nullable(),
    umamiWebsiteId: z.string().nullable(),
    glitchtipEnabled: z.boolean(),
    glitchtipDsn: z.string().nullable(),
    glitchtipEnvironment: z.string().nullable(),
    reminderLateMinutes: z.number().int(),
    reminderMissedMinutes: z.number().int(),
    adminAiKeyEncrypted: z.string().nullable(),
    adminAiModel: z.string(),
    adminAiBaseUrl: z.string(),
    adminCodexAccessTokenEncrypted: z.string().nullable(),
    adminCodexRefreshTokenEncrypted: z.string().nullable(),
    adminCodexAccountIdEncrypted: z.string().nullable(),
    adminCodexTokenExpiresAt: isoDateTime.nullable(),
    adminCodexConnectedAt: isoDateTime.nullable(),
    adminCodexConnectionStatus: z.string(),
    adminAiInsightsFeedbackSummary: z.unknown().nullable(),
    defaultUserTimezone: z.string().nullable(),
    assistantEnabled: z.boolean(),
    assistantCoachEnabled: z.boolean(),
    assistantBriefingEnabled: z.boolean(),
    assistantInsightStatusEnabled: z.boolean(),
    assistantCorrelationsEnabled: z.boolean(),
    moduleAvailabilityJson: z.unknown().nullable(),
    documentMaxFileBytes: z.number().int(),
    documentQuotaBytes: z.string().regex(/^\d+$/),
  })
  .passthrough();

/* ── Structured-record disaster-recovery shapes ─────────────────────
 *
 * These shapes serve both the historical portable export and the canonical
 * weekly/off-host disaster-recovery payload. Portable document entries remain
 * metadata-only. Canonical entries additionally carry encrypted BYTEA values
 * as base64 plus the codec/hash fields required to recreate InboundDocument
 * without decrypting or fabricating content.
 */

const labResultBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    panel: z.string().nullable().optional(),
    analyte: z.string().min(1),
    value: z.number().nullable().optional(),
    valueText: z.string().nullable().optional(),
    unit: z.string().min(1),
    referenceLow: z.number().nullable().optional(),
    referenceHigh: z.number().nullable().optional(),
    // Optional so a backup written before these columns existed still
    // restores; absent reads as "this reading had no source window on file".
    sourceReferenceLow: z.number().nullable().optional(),
    sourceReferenceHigh: z.number().nullable().optional(),
    sourceReferenceText: z.string().nullable().optional(),
    takenAt: isoDateTime,
    source: z.string().min(1),
    biomarkerName: z.string().nullable().optional(),
    biomarkerId: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const biomarkerBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    unit: z.string().min(1),
    lowerBound: z.number().nullable().optional(),
    upperBound: z.number().nullable().optional(),
    panel: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
    context: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const illnessSymptomBackupSchema = z
  .object({
    key: z.string().min(1),
    severity: z.number().int().nullable().optional(),
  })
  .passthrough();

const illnessDayLogBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    episodeId: z.string().min(1).optional(),
    date: z.string().min(1),
    functionalImpact: z.number().int().nullable().optional(),
    feverC: z.number().nullable().optional(),
    symptoms: z.array(illnessSymptomBackupSchema).default([]),
    note: z.string().nullable().optional(),
    updatedAt: isoDateTime.optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    tz: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const illnessEpisodeBackupSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(IllnessType),
    lifecycle: z.enum(IllnessLifecycle),
    onsetAt: isoDateTime,
    resolvedAt: isoDateTime.nullable().optional(),
    // Self-referencing flare/exacerbation link, carried as the exported
    // episode's own id — never resolved against another user's rows.
    parentConditionId: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    updatedAt: isoDateTime.optional(),
    dayLogs: z.array(illnessDayLogBackupSchema).default([]),
  })
  .passthrough();

/**
 * A practitioner, an encounter, and the edges between an encounter and the
 * things it produced.
 *
 * `id` is required on both records, unlike the lab result above: a link
 * addresses an encounter and its far side by id and nothing else on either row
 * is unique enough to rebuild the reference from. The ciphertext columns ride
 * verbatim as base64 — a visit note is never decrypted into the file.
 */
const practitionerBackupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    specialty: z.string().nullable().optional(),
    practice: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const encounterBackupSchema = z
  .object({
    id: z.string().min(1),
    occurredAt: isoDateTime,
    status: z.enum(EncounterStatus),
    kind: z.enum(EncounterKind),
    practitionerId: z.string().nullable().optional(),
    reasonEncrypted: base64BytesSchema.nullable().optional(),
    outcomeEncrypted: base64BytesSchema.nullable().optional(),
    // Remapped against the restored reminders (they travel since v1.37.20);
    // dropped to NULL, with the drop named, only when the file lacks the row.
    reminderId: z.string().nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const encounterLinkBackupSchema = z
  .object({
    encounterId: z.string().min(1),
    targetId: z.string().min(1),
    createdAt: isoDateTime,
  })
  .passthrough();

/**
 * One administered dose.
 *
 * `antigenSlug` is a free string here rather than an enum of the catalogue
 * this release ships, deliberately: a slug the catalogue has since dropped
 * must still restore, and the renderer degrades to `vaccineName`. Validating
 * it at the restore boundary would refuse a file the app itself wrote.
 */
const vaccinationBackupSchema = z
  .object({
    id: z.string().min(1),
    occurredAt: isoDateTime,
    antigenSlug: z.string().nullable().optional(),
    vaccineName: z.string().nullable().optional(),
    doseNumber: z.number().int().nullable().optional(),
    seriesDoses: z.number().int().nullable().optional(),
    lotNumber: z.string().nullable().optional(),
    site: z.enum(VaccinationSite).nullable().optional(),
    practitionerId: z.string().nullable().optional(),
    encounterId: z.string().nullable().optional(),
    // Remapped against the restored reminders (they travel since v1.37.20);
    // dropped to NULL, with the drop named, only when the file lacks the row.
    reminderId: z.string().nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const vaccinationLinkBackupSchema = z
  .object({
    vaccinationId: z.string().min(1),
    targetId: z.string().min(1),
    createdAt: isoDateTime,
  })
  .passthrough();

/**
 * One Vorsorge reminder, and one row of its completion ledger (v1.37.20,
 * #223 / iOS #68).
 *
 * `id` is required on both: an encounter, a vaccination record and every
 * ledger row address a reminder by it, and a ledger row is addressed by its
 * own id on re-insert. The enums are exactly the API's own — `origin` and
 * `kind` are the Prisma enums, and the ledger `source` is validated against
 * the engine's closed call-site set rather than accepted as free text, so a
 * file cannot smuggle a value the engine itself would never write.
 */
const measurementReminderBackupSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    measurementType: z.enum(MeasurementType).nullable().optional(),
    intervalDays: z.number().int().nullable().optional(),
    rrule: z.string().nullable().optional(),
    anchorDate: isoDateTime.nullable().optional(),
    endsOn: isoDateTime.nullable().optional(),
    origin: z.enum(ReminderOrigin).optional(),
    notifyHour: z.number().int().min(0).max(23).optional(),
    location: z.string().nullable().optional(),
    // Server-computed and restored verbatim — recomputing on restore would
    // move a due date the person had already been shown.
    nextDueAt: isoDateTime.nullable().optional(),
    lastSatisfiedAt: isoDateTime.nullable().optional(),
    enabled: z.boolean().optional(),
    vaccinationAntigen: z.string().nullable().optional(),
    snoozedUntil: isoDateTime.nullable().optional(),
    lastSkippedAt: isoDateTime.nullable().optional(),
    skipCount: z.number().int().min(0).optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const measurementReminderEventBackupSchema = z
  .object({
    id: z.string().min(1),
    reminderId: z.string().min(1),
    kind: z.enum(MeasurementReminderEventKind),
    occurredAt: isoDateTime,
    onTime: z.boolean(),
    source: z.enum(REMINDER_EVENT_SOURCES),
    createdAt: isoDateTime,
  })
  .passthrough();

/**
 * One personal best.
 *
 * `direction` is required rather than defaulted: it says whether higher or
 * lower wins, the read path orders by it, and a best time defaulted to MAX
 * would present the account's worst time as its record. `sourceMeasurementId`
 * is the provenance pointer the restore resolves, and a real foreign key in the
 * database, whatever `prisma/schema.prisma` says, so the restore nulls what it
 * cannot resolve rather than letting Postgres refuse the whole file.
 */
const personalRecordBackupSchema = z
  .object({
    metricType: z.enum(MeasurementType),
    metricSlot: z.string().nullable().optional(),
    direction: z.enum(PersonalRecordDirection),
    value: z.number(),
    unit: z.string().min(1),
    achievedAt: isoDateTime,
    sourceMeasurementId: z.string().nullable().optional(),
    source: z.enum(MeasurementSource).optional(),
    externalId: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One unlocked badge.
 *
 * `achievementId` is a free string on purpose: it names a definition in the
 * code catalogue, which drifts between the release that wrote the file and the
 * one that reads it, and a row is evidence that a person earned something on a
 * day rather than a claim about what this build ships.
 *
 * `unlockedAt` is REQUIRED, unlike almost every other stamp in this file. It
 * is the field that cannot be recovered from anywhere else, and a file that
 * does not state it must fail rather than restore every badge to today.
 */
const userAchievementBackupSchema = z
  .object({
    achievementId: z.string().min(1),
    unlockedAt: isoDateTime,
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/** `YYYY-MM-DD`, the day key both environment tables are addressed by. */
const environmentDayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Expected a YYYY-MM-DD day key",
});

/**
 * One day's environmental reading.
 *
 * `source` is required: it is the only record that the day resolved somewhere
 * other than the home city, and a defaulted value would re-attribute a trip to
 * home. Every weather column is optional, because the feed is allowed to be partial
 * and a file written before a column existed says nothing about it.
 */
const environmentContextBackupSchema = z
  .object({
    date: environmentDayKey,
    lat: z.number(),
    lon: z.number(),
    locationLabel: z.string(),
    source: z.enum(EnvironmentLocationSource),
    tempMin: z.number().nullable().optional(),
    tempMax: z.number().nullable().optional(),
    tempMean: z.number().nullable().optional(),
    apparentMean: z.number().nullable().optional(),
    sunshineSec: z.number().int().nullable().optional(),
    daylightSec: z.number().int().nullable().optional(),
    precipSum: z.number().nullable().optional(),
    pressureMean: z.number().nullable().optional(),
    pressureDelta: z.number().nullable().optional(),
    humidityMean: z.number().nullable().optional(),
    cloudMean: z.number().nullable().optional(),
    weatherCode: z.number().int().nullable().optional(),
    fetchedAt: isoDateTime.optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One declared stretch spent away from home. Both bounds are day keys rather
 * than instants: the resolver compares them lexicographically against other
 * day keys, and routing one through a `Date` is how a day key loses a day.
 */
const environmentTravelLocationBackupSchema = z
  .object({
    startDate: environmentDayKey,
    endDate: environmentDayKey,
    lat: z.number(),
    lon: z.number(),
    label: z.string(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One Coach turn.
 *
 * `contentEncrypted` and `content` are the two ends of the same contract, so
 * both are optional here and exactly one arrives: a disaster-recovery file
 * carries the ciphertext, a portable file carries the prose. Requiring either
 * would refuse half the valid files; requiring both would refuse all of them.
 * The restore picks whichever it was handed.
 */
const coachMessageBackupSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    contentEncrypted: base64BytesSchema.optional(),
    content: z.string().optional(),
    metricSourceJson: z.string().nullable().optional(),
    providerType: z.string().nullable().optional(),
    promptVersion: z.string().nullable().optional(),
    tokensUsed: z.number().int().nullable().optional(),
    model: z.string().nullable().optional(),
    createdAt: isoDateTime,
  })
  .passthrough();

const coachConversationDocumentBackupSchema = z
  .object({
    documentId: z.string().min(1),
    addedAt: isoDateTime,
  })
  .passthrough();

const coachConversationBackupSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    // NOT optional with a default. The fence is permanent and a file that does
    // not state it is a file that cannot be trusted to re-fence the
    // conversation, so the absence has to be visible rather than defaulted to
    // the permissive value.
    documentScoped: z.boolean(),
    summaryEncrypted: base64BytesSchema.nullable().optional(),
    summary: z.string().nullable().optional(),
    summaryUpdatedAt: isoDateTime.nullable().optional(),
    summaryTurnCount: z.number().int().min(0).optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    messages: z.array(coachMessageBackupSchema).default([]),
    attachments: z.array(coachConversationDocumentBackupSchema).default([]),
  })
  .passthrough();

/**
 * The Coach's memory. `deletedAt` is optional rather than nullable-required:
 * a portable file omits tombstoned rows entirely and never states the field,
 * while a disaster-recovery file always does.
 */
const coachFactBackupSchema = z
  .object({
    id: z.string().min(1),
    factEncrypted: base64BytesSchema.optional(),
    fact: z.string().optional(),
    category: z.string().min(1),
    confidence: z.number().int().min(0).max(100).optional(),
    sourceConversationId: z.string().nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const coachPlanBackupSchema = z
  .object({
    id: z.string().min(1),
    metric: z.string().min(1),
    ifCueEncrypted: base64BytesSchema.optional(),
    ifCue: z.string().optional(),
    thenActionEncrypted: base64BytesSchema.optional(),
    thenAction: z.string().optional(),
    targetEncrypted: base64BytesSchema.nullable().optional(),
    target: z.string().nullable().optional(),
    outcomeEncrypted: base64BytesSchema.nullable().optional(),
    outcome: z.string().nullable().optional(),
    status: z.string().optional(),
    reviewDate: isoDateTime.nullable().optional(),
    sourceConversationId: z.string().nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

const coachReminderBackupSchema = z
  .object({
    id: z.string().min(1),
    noteEncrypted: base64BytesSchema.optional(),
    note: z.string().optional(),
    metric: z.string().nullable().optional(),
    relatedPlanId: z.string().nullable().optional(),
    triggerKind: z.string().optional(),
    dueAt: isoDateTime.nullable().optional(),
    contextCue: z.string().nullable().optional(),
    status: z.string().optional(),
    source: z.string().min(1),
    sourceConversationId: z.string().nullable().optional(),
    lastSurfacedAt: isoDateTime.nullable().optional(),
    surfaceCount: z.number().int().min(0).optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();

/** One document filed against one condition episode. */
const documentConditionLinkBackupSchema = z
  .object({
    documentId: z.string().min(1),
    episodeId: z.string().min(1),
    createdAt: isoDateTime,
  })
  .passthrough();

/**
 * One fact the extraction pass staged against a document.
 *
 * `status`, `confidence` and `needsReview` are REQUIRED rather than defaulted,
 * unlike most optional-looking fields in this file. Each has a schema default
 * that means "nobody has looked at this yet", and the confirm endpoint acts on
 * a PENDING fact by committing it into the structured store — so a file that
 * does not state the review decision must fail to parse rather than have one
 * invented for it and let an already-committed reading be approved twice.
 *
 * `dataEncrypted` / `data` and their provenance siblings are the two ends of
 * the same contract, so all four are optional and exactly one pair arrives: a
 * disaster-recovery file carries the ciphertext, a portable file carries the
 * decrypted JSON.
 */
const extractedFactBackupSchema = z
  .object({
    id: z.string().min(1),
    documentId: z.string().min(1),
    factType: z.enum(ExtractedFactType),
    status: z.enum(ExtractedFactStatus),
    confidence: z.number(),
    needsReview: z.boolean(),
    committedRecordId: z.string().nullable().optional(),
    committedRecordType: z.string().nullable().optional(),
    dataEncrypted: base64BytesSchema.optional(),
    provenanceEncrypted: base64BytesSchema.optional(),
    data: z.json().optional(),
    provenance: z.json().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();

/**
 * A grouping the account created for its own mood factors. `id` is REQUIRED,
 * unlike everywhere else in this file, because a custom tag addresses its
 * category by that id and nothing else can resolve the pairing.
 */
const customMoodTagCategorySchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
    labelKey: z.string().min(1),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    labelEncrypted: z.string().nullable().optional(),
  })
  .passthrough();

/** A tag the account hid, named by key so a seeded tag resolves anywhere. */
const hiddenMoodTagSchema = z
  .object({
    key: z.string().min(1),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * A completed screener administration. `responsesEncrypted` is REQUIRED rather
 * than optional, unlike every other ciphertext field in this file: the column
 * is NOT NULL, so a file that omits it describes a row that cannot be written,
 * and saying so at the schema is better than discovering it inside the
 * transaction that has already wiped the account.
 */
const mentalHealthAssessmentBackupSchema = z
  .object({
    id: z.string().min(1),
    instrument: z.enum(AssessmentInstrument),
    locale: z.string().min(1),
    version: z.string().optional(),
    responsesEncrypted: base64BytesSchema,
    totalScore: z.number().int(),
    severityBand: z.string().min(1),
    item9Flagged: z.boolean().optional(),
    crisisShownAt: isoDateTime.nullable().optional(),
    takenAt: isoDateTime,
    tz: z.string().nullable().optional(),
    source: z.string().optional(),
    externalId: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();

const consentReceiptBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    artefact: z.string().min(1),
    signedAt: isoDateTime,
    revokedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

const allergyBackupSchema = z
  .object({
    id: z.string().min(1),
    substance: z.string().min(1),
    category: z.enum(AllergyCategory),
    type: z.enum(AllergyType),
    severity: z.enum(AllergySeverity).nullable().optional(),
    status: z.enum(AllergyStatus),
    onsetAt: isoDateTime.nullable().optional(),
    reaction: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    reactionEncrypted: base64BytesSchema.nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const familyHistoryBackupSchema = z
  .object({
    id: z.string().min(1),
    relationship: z.enum(FamilyRelationship),
    condition: z.string().min(1),
    ageAtOnset: z.number().int().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const workoutBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    sportType: z.string().min(1),
    startedAt: isoDateTime,
    endedAt: isoDateTime,
    durationSec: z.number().int(),
    totalEnergyKcal: z.number().nullable().optional(),
    totalDistanceM: z.number().nullable().optional(),
    avgHeartRate: z.number().int().nullable().optional(),
    maxHeartRate: z.number().int().nullable().optional(),
    minHeartRate: z.number().int().nullable().optional(),
    stepCount: z.number().int().nullable().optional(),
    elevationM: z.number().nullable().optional(),
    pauseDurationSec: z.number().int().nullable().optional(),
    source: z.enum(MeasurementSource),
    externalId: z.string().nullable().optional(),
    metadata: z.json().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const documentBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(InboundDocumentKind),
    title: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    mimeType: z.string().min(1),
    byteSize: z.number().int(),
    status: z.enum(InboundDocumentStatus),
    reportDate: z.string().nullable().optional(),
    documentDate: z.string().nullable().optional(),
    contentEncrypted: base64BytesSchema.optional(),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    contentCodec: z.string().min(1).optional(),
    providerType: z.string().nullable().optional(),
    errorReason: z.string().nullable().optional(),
    summaryEncrypted: base64BytesSchema.nullable().optional(),
    summaryGeneratedAt: isoDateTime.nullable().optional(),
    summaryState: z.enum(DocumentSummaryState).optional(),
    // Refs #776 — the index-attempt record (canonical DR payloads only).
    // Free string on purpose: a future outcome value must not fail a restore.
    lastIndexAttemptAt: isoDateTime.nullable().optional(),
    lastIndexOutcome: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

/**
 * One ECG strip.
 *
 * `waveformEncrypted` and `waveform` are the two ends of the same contract, so
 * both are optional here and exactly one arrives: a disaster-recovery file
 * carries the ciphertext, a portable file carries the micro-volt samples.
 * Requiring either would refuse half the valid files. `samplingFrequency` and
 * `sampleCount` stay required in both, because without them the samples are a
 * list of numbers with no time axis.
 */
const ecgRecordingBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    source: z.enum(MeasurementSource),
    externalRecordingId: z.string().min(1),
    recordedAt: isoDateTime,
    waveformEncrypted: base64BytesSchema.optional(),
    waveform: z.array(z.number()).optional(),
    samplingFrequency: z.number().int(),
    sampleCount: z.number().int(),
    durationSeconds: z.number().nullable().optional(),
    lead: z.string().nullable().optional(),
    averageHeartRate: z.number().int().nullable().optional(),
    rhythmClassification: z.enum(RhythmClassification).nullable().optional(),
    measurementId: z.string().min(1).nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();

const backupManifestSchema = z
  .object({
    documents: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
    workouts: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
  })
  .passthrough();

/**
 * Wire shape — exactly what the pg-boss worker writes today, plus a
 * `schemaVersion` field that newer writers stamp explicitly. Older blobs
 * without the field default to v1 in `parseBackupPayload`.
 */
export const backupPayloadSchema = z
  .object({
    schemaVersion: z.string().min(1).default(LEGACY_BACKUP_SCHEMA_VERSION),
    exportedAt: isoDateTime,
    userId: z.string().min(1),
    appSettings: appSettingsBackupSchema.nullable().default(null),
    measurements: z.array(measurementSchema).default([]),
    medications: z.array(medicationSchema).default([]),
    intakeEvents: z.array(intakeEventSchema).default([]),
    moodEntries: z.array(moodEntrySchema).default([]),
    // v1.15.0 — cycle-tracking tables. Default to empty arrays / null so a
    // pre-v1.15 backup (no cycle keys) still round-trips unchanged.
    cycleProfile: cycleProfileSchema.nullable().default(null),
    cycles: z.array(cycleSpanSchema).default([]),
    cycleDayLogs: z.array(cycleDayLogSchema).default([]),
    // Defaulted rather than required: files written before this field existed
    // are still valid, and an account with no custom symptoms writes [].
    customSymptoms: z.array(customCycleSymptomSchema).default([]),
    customMoodTagCategories: z.array(customMoodTagCategorySchema).default([]),
    hiddenMoodTags: z.array(hiddenMoodTagSchema).default([]),
    customMoodTags: z.array(customMoodTagSchema).default([]),
    // Structured records default to empty arrays so older backups remain
    // parseable. Canonical DR writers add stable ids and encrypted document
    // fields; portable exports retain the metadata-only subset.
    labResults: z.array(labResultBackupSchema).default([]),
    biomarkers: z.array(biomarkerBackupSchema).default([]),
    illnessEpisodes: z.array(illnessEpisodeBackupSchema).default([]),
    allergies: z.array(allergyBackupSchema).default([]),
    familyHistory: z.array(familyHistoryBackupSchema).default([]),
    workouts: z.array(workoutBackupSchema).default([]),
    documents: z.array(documentBackupSchema).default([]),
    // What a document was filed against, and what was read out of it. Defaulted
    // for the same reason as the sections below: a file written before the
    // vault filing travelled carries no key, and an unsorted vault writes [].
    documentConditionLinks: z
      .array(documentConditionLinkBackupSchema)
      .default([]),
    extractedFacts: z.array(extractedFactBackupSchema).default([]),
    nutrientDays: z.array(nutrientDaySchema).default([]),
    // Durable self-context and user-defined series. Defaulted so files written
    // before either rode the wire still parse; an account with neither writes
    // `null` / `[]`.
    healthProfile: healthProfileBackupSchema.nullable().default(null),
    healthProfileFacts: z.array(healthProfileFactBackupSchema).default([]),
    customMetrics: z.array(customMetricBackupSchema).default([]),
    correlationPatterns: z.array(correlationPatternBackupSchema).default([]),
    // The hourly shape of a cumulative day. Defaulted for the same reason as
    // the pair above: a file written before the table existed carries no key.
    intradayProfiles: z.array(intradayProfileBackupSchema).default([]),
    // The score as it was shown, day by day. Defaulted for the same reason as
    // the sections above: a file written before the table existed carries no
    // key, and an account whose score never resolved writes [].
    healthScoreRecords: z.array(healthScoreRecordBackupSchema).default([]),
    // The needs-based setup answers. Defaulted to null for the same reason as
    // the sections above: a file written before the table existed carries no
    // key, and a record that never entered the flow has no row.
    onboardingRecord: onboardingRecordBackupSchema.nullable().default(null),
    // Visits, the address book behind them, and the three link tables.
    // Defaulted for the same reason as the sections above: a file written
    // before the tables existed carries no key, and an account that has never
    // filed a visit writes [].
    practitioners: z.array(practitionerBackupSchema).default([]),
    encounters: z.array(encounterBackupSchema).default([]),
    encounterDocumentLinks: z.array(encounterLinkBackupSchema).default([]),
    encounterLabLinks: z.array(encounterLinkBackupSchema).default([]),
    encounterConditionLinks: z.array(encounterLinkBackupSchema).default([]),
    // The immunization log and the pages it was transcribed from. Defaulted
    // for the same reason as the sections above: a file written before the
    // tables existed carries no key, and an account with an empty Impfpass
    // writes [].
    vaccinations: z.array(vaccinationBackupSchema).default([]),
    vaccinationDocumentLinks: z.array(vaccinationLinkBackupSchema).default([]),
    // The Vorsorge reminders and their completion ledger (v1.37.20, #223 /
    // iOS #68). Defaulted for the same reason as the sections above: a file
    // written before the reminders travelled carries no key, and an account
    // with none writes [].
    coachConversations: z.array(coachConversationBackupSchema).default([]),
    mentalHealthAssessments: z
      .array(mentalHealthAssessmentBackupSchema)
      .default([]),
    consentReceipts: z.array(consentReceiptBackupSchema).default([]),
    coachFacts: z.array(coachFactBackupSchema).default([]),
    coachPlans: z.array(coachPlanBackupSchema).default([]),
    coachReminders: z.array(coachReminderBackupSchema).default([]),
    measurementReminders: z.array(measurementReminderBackupSchema).default([]),
    measurementReminderEvents: z
      .array(measurementReminderEventBackupSchema)
      .default([]),
    // The bests and the badges. Defaulted for the same reason as the sections
    // above: a file written before they travelled carries no key, and an
    // account that has earned neither writes [].
    personalRecords: z.array(personalRecordBackupSchema).default([]),
    userAchievements: z.array(userAchievementBackupSchema).default([]),
    // The per-day readings and the location periods that explain them. Two
    // keys rather than one because they are two tables, but they are written
    // and restored as a pair: readings whose periods are missing get rewritten
    // to the home location by the next refresh.
    environmentContexts: z.array(environmentContextBackupSchema).default([]),
    environmentTravelLocations: z
      .array(environmentTravelLocationBackupSchema)
      .default([]),
    // The ECG strips. Defaulted for the same reason as the sections above: a
    // file written before the recordings travelled carries no key, and an
    // account whose watch has never taken one writes [].
    ecgRecordings: z.array(ecgRecordingBackupSchema).default([]),
    manifest: backupManifestSchema.nullable().default(null),
    // v1.37.19 (A6-9) — field paths a PORTABLE export could not decrypt
    // (fail-soft nulls). Disclosed in the file so a nulled field is
    // distinguishable from one never written. Empty/absent on DR payloads.
    decryptFailures: z.array(z.string()).default([]),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) return;
    payload.measurements.forEach((measurement, index) => {
      if (!measurement.id) {
        ctx.addIssue({
          code: "custom",
          path: ["measurements", index, "id"],
          message: "Canonical v2 measurements require a stable id",
        });
      }
    });
  });

export type BackupPayload = z.infer<typeof backupPayloadSchema>;

/**
 * Numeric counts of each backed-up record kind. Returned in the
 * upload + restore API responses so the admin sees what they
 * uploaded/restored without having to download the file again.
 */
export interface BackupSummary {
  schemaVersion: string;
  userId: string;
  exportedAt: string;
  measurements: number;
  medications: number;
  intakeEvents: number;
  /** Side effects recorded against a drug, across every medication. */
  medicationSideEffects: number;
  /** Pinned efficacy targets, across every medication. */
  medicationEfficacyTargets: number;
  /** Archived schedule eras, across every medication. */
  medicationScheduleRevisions: number;
  moodEntries: number;
  /** v1.15.0 — observed cycle spans in the backup. */
  cycles: number;
  /** v1.15.0 — cycle day-logs in the backup. */
  cycleDayLogs: number;
  /** Lab results in the backup. */
  labResults: number;
  nutrientDays: number;
  /** User-scoped biomarker catalog entries in the backup. */
  biomarkers: number;
  /** Illness episodes, including flares/exacerbations. */
  illnessEpisodes: number;
  /** Illness day-logs across every episode. */
  illnessDayLogs: number;
  /** Allergy/intolerance records in the backup. */
  allergies: number;
  /** Family-history entries in the backup. */
  familyHistory: number;
  /** Workout summary records in the backup. */
  workouts: number;
  /** Document records (ciphertext included in canonical DR payloads). */
  documents: number;
  /** Which documents were filed against which condition. */
  documentConditionLinks: number;
  /** Facts staged out of a document, with their review decision. */
  extractedFacts: number;
  /** 1 when the account's durable self-context rides the file, 0 otherwise. */
  healthProfile: number;
  /** Effective-dated structured health-profile revisions. */
  healthProfileFactRevisions: number;
  /** Metrics the account defined itself. */
  customMetrics: number;
  /** Readings across every user-defined metric. */
  customMetricEntries: number;
  /** Persisted accepted correlation identities and dismissal decisions. */
  correlationPatterns: number;
  /** Stored day curves for the cumulative metrics, across every metric. */
  intradayProfiles: number;
  /** Local days whose health score was written down as it was shown. */
  healthScoreRecords: number;
  /** 1 when the record's setup answers ride the file, 0 otherwise. */
  onboardingRecords: number;
  /** v1.37.19 (A6-8) — the visit address book. */
  practitioners: number;
  /** v1.37.19 (A6-8) — doctor visits, planned and past. */
  encounters: number;
  /** v1.37.19 (A6-8) — the three encounter link tables, summed. */
  encounterLinks: number;
  /** v1.37.19 (A6-8) — immunization log entries. */
  vaccinations: number;
  /** v1.37.19 (A6-8) — vaccination↔document links. */
  vaccinationLinks: number;
  /** v1.37.20 (#223 / iOS #68) — Vorsorge reminder cadences. */
  measurementReminders: number;
  /** v1.37.20 (#223 / iOS #68) — completion-ledger rows across every reminder. */
  measurementReminderEvents: number;
  /** Coach conversation threads. */
  coachConversations: number;
  /** Coach turns across every thread. */
  coachMessages: number;
  /** Durable facts, agreed plans and things to bring back up. */
  coachFacts: number;
  coachPlans: number;
  coachReminders: number;
  /** Completed screener administrations. Disaster-recovery payloads only. */
  mentalHealthAssessments: number;
  /** Consent records. Disaster-recovery payloads only. */
  consentReceipts: number;
  /** Personal bests across every metric and sport slot. */
  personalRecords: number;
  /** Badges the account has unlocked, each with the day it was earned. */
  userAchievements: number;
  /** Local days with an environmental reading. */
  environmentContexts: number;
  /** Declared stretches spent away from home. */
  environmentTravelLocations: number;
  /** ECG strips, with their rhythm verdict and their trace. */
  ecgRecordings: number;
}

export function summarizeBackup(payload: BackupPayload): BackupSummary {
  return {
    schemaVersion: payload.schemaVersion,
    userId: payload.userId,
    exportedAt: payload.exportedAt,
    measurements: payload.measurements.length,
    medications: payload.medications.length,
    intakeEvents: payload.intakeEvents.length,
    medicationSideEffects: payload.medications.reduce(
      (sum, medication) => sum + medication.sideEffects.length,
      0,
    ),
    medicationEfficacyTargets: payload.medications.reduce(
      (sum, medication) => sum + medication.efficacyTargets.length,
      0,
    ),
    medicationScheduleRevisions: payload.medications.reduce(
      (sum, medication) => sum + medication.scheduleRevisions.length,
      0,
    ),
    moodEntries: payload.moodEntries.length,
    cycles: payload.cycles.length,
    cycleDayLogs: payload.cycleDayLogs.length,
    nutrientDays: payload.nutrientDays.length,
    labResults: payload.labResults.length,
    biomarkers: payload.biomarkers.length,
    illnessEpisodes: payload.illnessEpisodes.length,
    illnessDayLogs: payload.illnessEpisodes.reduce(
      (sum, e) => sum + e.dayLogs.length,
      0,
    ),
    allergies: payload.allergies.length,
    familyHistory: payload.familyHistory.length,
    workouts: payload.workouts.length,
    documents: payload.documents.length,
    // Counted from the release that carries them, so the admin's "what did I
    // just restore" answer never under-counts a filed vault the way it once
    // did for visits.
    documentConditionLinks: payload.documentConditionLinks.length,
    extractedFacts: payload.extractedFacts.length,
    healthProfile: payload.healthProfile ? 1 : 0,
    healthProfileFactRevisions: payload.healthProfileFacts.length,
    customMetrics: payload.customMetrics.length,
    customMetricEntries: payload.customMetrics.reduce(
      (sum, metric) => sum + metric.entries.length,
      0,
    ),
    correlationPatterns: payload.correlationPatterns.length,
    intradayProfiles: payload.intradayProfiles.length,
    healthScoreRecords: payload.healthScoreRecords.length,
    onboardingRecords: payload.onboardingRecord ? 1 : 0,
    // v1.37.19 (A6-8) — the sections restored since 08-01 were written and
    // restored but absent from this report, so the admin's "what did I just
    // restore" answer silently under-counted a file that carried visits or
    // an Impfpass.
    practitioners: payload.practitioners.length,
    encounters: payload.encounters.length,
    encounterLinks:
      payload.encounterDocumentLinks.length +
      payload.encounterLabLinks.length +
      payload.encounterConditionLinks.length,
    vaccinations: payload.vaccinations.length,
    vaccinationLinks: payload.vaccinationDocumentLinks.length,
    // v1.37.20 (#223 / iOS #68) — counted from the release that carries them,
    // so the admin's "what did I just restore" answer never under-counts a
    // file with reminders the way it once did for visits.
    measurementReminders: payload.measurementReminders.length,
    measurementReminderEvents: payload.measurementReminderEvents.length,
    coachConversations: payload.coachConversations.length,
    coachMessages: payload.coachConversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0,
    ),
    coachFacts: payload.coachFacts.length,
    coachPlans: payload.coachPlans.length,
    coachReminders: payload.coachReminders.length,
    mentalHealthAssessments: payload.mentalHealthAssessments.length,
    consentReceipts: payload.consentReceipts.length,
    // Counted from the release that carries them, so the admin's "what did I
    // just restore" answer never under-counts a file with bests, badges or an
    // environmental history the way it once did for visits.
    personalRecords: payload.personalRecords.length,
    userAchievements: payload.userAchievements.length,
    environmentContexts: payload.environmentContexts.length,
    environmentTravelLocations: payload.environmentTravelLocations.length,
    ecgRecordings: payload.ecgRecordings.length,
  };
}

/**
 * Parse a JSON blob (string or already-parsed object) against
 * `backupPayloadSchema`, returning a typed payload. Throws ZodError on
 * mismatch — the admin route catches it and turns it into a 422 with a
 * field-level error list.
 *
 * Accepts both forms because:
 *   - the upload route hands us the parsed object after `await req.text()`
 *   - the restore route reads `DataBackup.data` (decrypted) which is
 *     always a JSON string straight from the worker.
 */
export function parseBackupPayload(input: string | unknown): BackupPayload {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  return backupPayloadSchema.parse(raw);
}

/**
 * The schemaVersion the system understands today. Used by the upload
 * route to reject inbound files written by a *future* HealthLog instance
 * — restoring them under the current code might silently drop data the
 * new shape carried.
 */
export function isCompatibleSchemaVersion(version: string): boolean {
  return (
    version === LEGACY_BACKUP_SCHEMA_VERSION ||
    version === BACKUP_SCHEMA_VERSION
  );
}
