import { z } from "zod/v4";

import { validateEntryInstant } from "@/lib/validations/entry-instant";
import { isoDateTime } from "@/lib/validations/datetime";

import { SEIZURE_ILAE_TYPES, type SeizureIlaeType } from "./ilae";
import type {
  AlertThreshold,
  ClusterEpisode,
  ClusterRule,
  DurationFlags,
  SeizureFreeSummary,
  MonthlyTypeRow,
} from "./derive";

/**
 * The seizure diary (#1368): client-safe vocabularies, wire types and request
 * schemas. Server-only helpers (text crypto, row mappers, the rescue write)
 * live in `./server.ts`, so the quick log can import this file without
 * pulling `node:crypto` into the browser bundle.
 */

export const SEIZURE_ONSET_PRECISIONS = [
  "EXACT",
  "APPROX",
  "UNKNOWN_TIME",
] as const;
export const SEIZURE_DURATION_SOURCES = [
  "TIMED",
  "ESTIMATED",
  "UNKNOWN",
] as const;
export const SEIZURE_CERTAINTIES = ["CONFIRMED", "SUSPECTED"] as const;
export const SEIZURE_SLEEP_STATES = [
  "AWAKE",
  "ASLEEP",
  "ON_WAKING",
  "UNKNOWN",
] as const;
export const SEIZURE_OBSERVATIONS = ["YES", "NO", "UNKNOWN"] as const;
export const SEIZURE_FUNCTION_STATES = [
  "PRESERVED",
  "IMPAIRED",
  "UNKNOWN",
] as const;
export const SEIZURE_SEMIOLOGY = [
  "AURA",
  "BEHAVIOUR_ARREST",
  "STARING",
  "AUTOMATISMS",
  "TONIC",
  "CLONIC",
  "MYOCLONIC",
  "ATONIC_DROP",
  "SPASMS",
  "HEAD_EYE_VERSION",
  "VOCALISATION",
  "CYANOSIS",
  "DROOLING",
  "BREATHING_CHANGE",
] as const;
export const SEIZURE_TRIGGERS = [
  "MISSED_DOSE",
  "SLEEP_DEPRIVATION",
  "FEVER",
  "ILLNESS",
  "MENSTRUATION",
  "ALCOHOL",
  "FLASHING_LIGHTS",
  "STRESS",
  "OTHER",
  "NONE_IDENTIFIED",
] as const;
export const SEIZURE_POSTICTAL = [
  "SLEEP",
  "CONFUSION",
  "HEADACHE",
  "WEAKNESS_TODD",
  "SPEECH",
  "AGITATION",
  "OTHER",
] as const;
export const SEIZURE_INJURIES = [
  "NONE",
  "TONGUE_BITE",
  "HEAD",
  "FALL_OTHER",
  "BURN",
  "FRACTURE",
  "OTHER",
] as const;
export const SEIZURE_EMERGENCIES = [
  "NONE",
  "EMS_CALLED",
  "ED_VISIT",
  "ADMITTED",
] as const;
export const SEIZURE_OBSERVER_ROLES = [
  "SELF",
  "PARENT",
  "PARTNER",
  "FAMILY",
  "CARER",
  "TEACHER",
  "CLINICIAN",
  "PARAMEDIC",
  "OTHER",
] as const;
export const SEIZURE_EVENT_SOURCES = ["MANUAL", "DEVICE_ALERT"] as const;
export const SEIZURE_RESCUE_ROUTES = [
  "BUCCAL",
  "INTRANASAL",
  "RECTAL",
  "ORAL",
  "SUBLINGUAL",
  "IM",
  "IV_BY_EMS",
] as const;
export const SEIZURE_RESCUE_EFFECTS = [
  "STOPPED",
  "REDUCED",
  "NO_EFFECT",
  "UNKNOWN",
] as const;

export type SeizureOnsetPrecision = (typeof SEIZURE_ONSET_PRECISIONS)[number];
export type SeizureDurationSource = (typeof SEIZURE_DURATION_SOURCES)[number];
export type SeizureCertainty = (typeof SEIZURE_CERTAINTIES)[number];
export type SeizureSleepState = (typeof SEIZURE_SLEEP_STATES)[number];
export type SeizureObservation = (typeof SEIZURE_OBSERVATIONS)[number];
export type SeizureFunctionState = (typeof SEIZURE_FUNCTION_STATES)[number];
export type SeizureSemiology = (typeof SEIZURE_SEMIOLOGY)[number];
export type SeizureTrigger = (typeof SEIZURE_TRIGGERS)[number];
export type SeizurePostictal = (typeof SEIZURE_POSTICTAL)[number];
export type SeizureInjury = (typeof SEIZURE_INJURIES)[number];
export type SeizureEmergency = (typeof SEIZURE_EMERGENCIES)[number];
export type SeizureObserverRole = (typeof SEIZURE_OBSERVER_ROLES)[number];
export type SeizureEventSource = (typeof SEIZURE_EVENT_SOURCES)[number];
export type SeizureRescueRoute = (typeof SEIZURE_RESCUE_ROUTES)[number];
export type SeizureRescueEffect = (typeof SEIZURE_RESCUE_EFFECTS)[number];

/** Active (not archived) seizure types per record. */
export const MAX_ACTIVE_SEIZURE_TYPES = 12;

/** Upper bound on events in one diary read. */
export const MAX_SEIZURE_EVENTS_PAGE = 2000;

/** The diary's default look-back when no period is asked for. */
export const DEFAULT_DIARY_DAYS = 90;

/** Longest period one diary read covers. */
export const MAX_DIARY_DAYS = 3 * 366;

/** Free-text bounds. */
export const SEIZURE_LABEL_MAX = 40;
export const SEIZURE_PLAN_MAX = 2000;
export const SEIZURE_NOTE_MAX = 1000;

/* ─── Wire types ─────────────────────────────────────────────────────────── */

export interface SeizureTypeDTO {
  id: string;
  /** Decrypted; null only when the stored label cannot be read. */
  label: string | null;
  ilaeType: SeizureIlaeType;
  usualDurationSec: number | null;
  rescuePlan: string | null;
  rescueMedicationId: string | null;
  /** The linked medication's current name, for display. */
  rescueMedicationName: string | null;
  rescueDoseAmount: number | null;
  rescueDoseUnit: string | null;
  rescueRoute: SeizureRescueRoute | null;
  sortOrder: number;
  archived: boolean;
  /** When the quick-log timer shows this type's plan (server-resolved). */
  alert: AlertThreshold;
}

export interface SeizureRescueDoseDTO {
  id: string;
  eventId: string;
  medicationId: string | null;
  medicationName: string;
  doseAmount: number | null;
  doseUnit: string | null;
  route: SeizureRescueRoute | null;
  givenAt: string;
  givenBy: SeizureObserverRole | null;
  effect: SeizureRescueEffect;
  seizureEndedAt: string | null;
  /** The intake written on the medication, while it exists. */
  intakeEventId: string | null;
}

export interface SeizureEventDTO {
  id: string;
  typeProfileId: string | null;
  /** The per-event override, or null for the type's own. */
  ilaeType: SeizureIlaeType | null;
  /** The override, else the type's, else null. */
  effectiveIlaeType: SeizureIlaeType | null;
  onsetAt: string;
  onsetPrecision: SeizureOnsetPrecision;
  durationSec: number | null;
  durationSource: SeizureDurationSource;
  count: number;
  certainty: SeizureCertainty;
  sleepState: SeizureSleepState;
  observableManifestations: SeizureObservation | null;
  responsiveness: SeizureFunctionState | null;
  recall: SeizureFunctionState | null;
  semiology: SeizureSemiology[];
  semiologyNote: string | null;
  aura: string | null;
  triggers: SeizureTrigger[];
  postictalMinutes: number | null;
  postictal: SeizurePostictal[];
  injuries: SeizureInjury[];
  incontinence: boolean | null;
  emergency: SeizureEmergency;
  witnessed: boolean | null;
  witnessRole: SeizureObserverRole | null;
  witnessNote: string | null;
  /**
   * Who logged it, relative to the record: the person themselves, someone
   * acting on the record (a guardian, a carer), or not known.
   */
  loggedBy: "owner" | "delegate" | "unknown";
  /** True when the viewer is the one who logged it. */
  loggedByViewer: boolean;
  source: SeizureEventSource;
  note: string | null;
  rescueDoses: SeizureRescueDoseDTO[];
  flags: DurationFlags;
  createdAt: string;
  updatedAt: string;
}

export interface SeizureSettingsDTO {
  rule: ClusterRule;
  /** NICE NG217's 3-in-24-hours, shown beside the record's own rule. */
  niceRule: ClusterRule;
}

export interface SeizureDiarySummaryDTO {
  from: string;
  to: string;
  days: number;
  /** Seizures in the period (each row weighted by its count), confirmed only. */
  seizures: number;
  /** Suspected seizures, listed apart. */
  suspected: number;
  seizureDays: number;
  seizureFreeDays: number;
  /** Seizures per 28 days over the period. */
  per28Days: number;
  convulsive: number;
  fromSleep: number;
  rescueDoses: number;
  emergencies: { emsCalled: number; edVisits: number; admissions: number };
  streak: SeizureFreeSummary;
  clusters: ClusterEpisode[];
  niceClusterCount: number;
  monthly: { months: string[]; rows: MonthlyTypeRow[]; total: MonthlyTypeRow };
}

export interface SeizureDiaryDTO {
  types: SeizureTypeDTO[];
  settings: SeizureSettingsDTO;
  events: SeizureEventDTO[];
  summary: SeizureDiarySummaryDTO;
  /** True when the period held more events than one read returns. */
  truncated: boolean;
}

/* ─── Request schemas ────────────────────────────────────────────────────── */

const idSchema = z.string().min(1).max(40);
const ilaeTypeSchema = z.enum(SEIZURE_ILAE_TYPES);

const labelSchema = z
  .string()
  .trim()
  .min(1, "Label must not be empty")
  .max(SEIZURE_LABEL_MAX);

/** Absent leaves a field alone; null or an empty string clears it. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === "" ? null : v));

const durationSchema = z.number().int().min(0).max(86_400);
const doseAmountSchema = z.number().positive().max(100_000);
const doseUnitSchema = z.string().trim().min(1).max(20);

const instantSchema = validateEntryInstant(
  isoDateTime()
    .transform((s) => new Date(s))
    .pipe(z.date()),
);

export const seizureTypeCreateSchema = z.object({
  label: labelSchema,
  ilaeType: ilaeTypeSchema,
  usualDurationSec: z.number().int().min(1).max(86_400).nullish(),
  rescuePlan: optionalText(SEIZURE_PLAN_MAX),
  rescueMedicationId: idSchema.nullish(),
  rescueDoseAmount: doseAmountSchema.nullish(),
  rescueDoseUnit: doseUnitSchema.nullish(),
  rescueRoute: z.enum(SEIZURE_RESCUE_ROUTES).nullish(),
});

export const seizureTypeUpdateSchema = seizureTypeCreateSchema
  .partial()
  .extend({
    archived: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "At least one field is required",
  );

export const seizureRescueDoseCreateSchema = z.object({
  /** An as-needed medication of the record. Omit for a dose given by EMS. */
  medicationId: idSchema.nullish(),
  /** Required when no medication is linked; ignored when one is. */
  medicationName: z.string().trim().min(1).max(120).nullish(),
  doseAmount: doseAmountSchema.nullish(),
  doseUnit: doseUnitSchema.nullish(),
  route: z.enum(SEIZURE_RESCUE_ROUTES).nullish(),
  givenAt: instantSchema,
  givenBy: z.enum(SEIZURE_OBSERVER_ROLES).nullish(),
  effect: z.enum(SEIZURE_RESCUE_EFFECTS).optional(),
  seizureEndedAt: instantSchema.nullish(),
});

export const seizureRescueDoseUpdateSchema = z
  .object({
    effect: z.enum(SEIZURE_RESCUE_EFFECTS).optional(),
    seizureEndedAt: instantSchema.nullish(),
    givenBy: z.enum(SEIZURE_OBSERVER_ROLES).nullish(),
    route: z.enum(SEIZURE_RESCUE_ROUTES).nullish(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "At least one field is required",
  );

const eventFields = {
  typeProfileId: idSchema.nullish(),
  ilaeType: ilaeTypeSchema.nullish(),
  onsetAt: instantSchema,
  onsetPrecision: z.enum(SEIZURE_ONSET_PRECISIONS).optional(),
  durationSec: durationSchema.nullish(),
  durationSource: z.enum(SEIZURE_DURATION_SOURCES).optional(),
  count: z.number().int().min(1).max(500).optional(),
  certainty: z.enum(SEIZURE_CERTAINTIES).optional(),
  sleepState: z.enum(SEIZURE_SLEEP_STATES).optional(),
  observableManifestations: z.enum(SEIZURE_OBSERVATIONS).nullish(),
  responsiveness: z.enum(SEIZURE_FUNCTION_STATES).nullish(),
  recall: z.enum(SEIZURE_FUNCTION_STATES).nullish(),
  semiology: z.array(z.enum(SEIZURE_SEMIOLOGY)).max(14).optional(),
  semiologyNote: optionalText(SEIZURE_NOTE_MAX),
  aura: optionalText(SEIZURE_NOTE_MAX),
  triggers: z.array(z.enum(SEIZURE_TRIGGERS)).max(10).optional(),
  postictalMinutes: z.number().int().min(0).max(10_080).nullish(),
  postictal: z.array(z.enum(SEIZURE_POSTICTAL)).max(7).optional(),
  injuries: z.array(z.enum(SEIZURE_INJURIES)).max(7).optional(),
  incontinence: z.boolean().nullish(),
  emergency: z.enum(SEIZURE_EMERGENCIES).optional(),
  witnessed: z.boolean().nullish(),
  witnessRole: z.enum(SEIZURE_OBSERVER_ROLES).nullish(),
  witnessNote: optionalText(SEIZURE_NOTE_MAX),
  source: z.enum(SEIZURE_EVENT_SOURCES).optional(),
  note: optionalText(SEIZURE_NOTE_MAX),
};

/**
 * A duration and its source agree: UNKNOWN carries no duration, and an
 * explicitly cleared duration cannot claim to be timed or estimated.
 */
function durationConsistent(v: {
  durationSec?: number | null;
  durationSource?: SeizureDurationSource;
}): boolean {
  if (v.durationSource === "UNKNOWN") return v.durationSec == null;
  if (v.durationSec === null && v.durationSource !== undefined) return false;
  return true;
}

/** On a new seizure an absent duration is no duration. */
function createDurationConsistent(v: {
  durationSec?: number | null;
  durationSource?: SeizureDurationSource;
}): boolean {
  if (v.durationSec == null) {
    return v.durationSource === undefined || v.durationSource === "UNKNOWN";
  }
  return durationConsistent(v);
}

export const seizureEventCreateSchema = z
  .object({
    ...eventFields,
    /** Doses given during this seizure, written with it (the quick log). */
    rescueDoses: z.array(seizureRescueDoseCreateSchema).max(5).optional(),
  })
  .refine(createDurationConsistent, {
    message: "A duration of unknown source must be empty",
    path: ["durationSec"],
  });

export const seizureEventUpdateSchema = z
  .object({ ...eventFields, onsetAt: instantSchema.optional() })
  .partial()
  .refine(durationConsistent, {
    message: "A duration of unknown source must be empty",
    path: ["durationSec"],
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "At least one field is required",
  );

export const seizureSettingsUpdateSchema = z.object({
  clusterCount: z.number().int().min(2).max(20),
  clusterWindowHours: z.number().int().min(1).max(168),
});

export const seizureDiaryQuerySchema = z
  .object({
    from: isoDateTime().optional(),
    to: isoDateTime().optional(),
  })
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), {
    message: "`from` must not be after `to`",
    path: ["from"],
  })
  .refine(
    (v) =>
      !v.from ||
      !v.to ||
      Date.parse(v.to) - Date.parse(v.from) <= MAX_DIARY_DAYS * 86_400_000,
    { message: "The period is too long", path: ["to"] },
  );
