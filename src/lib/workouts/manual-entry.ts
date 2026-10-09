/**
 * A workout entered by hand: the form's draft, its validation, and the one
 * batch entry it becomes.
 *
 * HealthLog records workouts; it does not plan them. So the hand-entered
 * shape is the session as a health record sees it and nothing more: what,
 * when, how long, and optionally how far and how much energy. No sets, no
 * exercises, no heart rate typed in from memory.
 *
 * The entry is written through `POST /api/workouts/batch`, the same route the
 * phone syncs through, as `source: "MANUAL"` with an `externalId` minted once
 * per opened form. That id is what makes a double submit (a second tap, a
 * retried request) a `duplicate` instead of a second row: the route's
 * `(userId, source, externalId)` key catches it.
 *
 * Pure, no React and no fetch, so the rules are pinned without a browser.
 * Error values are i18n keys; the form translates them.
 */
import { z } from "zod/v4";

import {
  applyDisplayTransform,
  getQuantityTransform,
  invertDisplayTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";
import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import {
  workoutSportTypeEnum,
  type WorkoutSportType,
} from "@/lib/validations/workout";
import { randomId } from "@/lib/random-id";
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";

/** One session is at most a day long. */
export const MANUAL_WORKOUT_MAX_DURATION_SEC = 24 * 60 * 60;
/** The batch schema's own ceiling: 1000 km. */
export const MANUAL_WORKOUT_MAX_DISTANCE_M = 1_000_000;
/** A day of hard endurance work stays well under this. */
export const MANUAL_WORKOUT_MAX_ENERGY_KCAL = 20_000;
/**
 * Slack on "not in the future". The form's default start is the minute the
 * sheet opened, and the clock keeps moving while the person types.
 */
const FUTURE_TOLERANCE_MS = 60_000;

export interface ManualWorkoutDraft {
  /** Empty until the person picks one. */
  sportType: WorkoutSportType | "";
  /** Wall clock in the profile timezone, `yyyy-MM-ddTHH:mm`. */
  start: string;
  hours: string;
  minutes: string;
  /** In the reader's unit (km or mi). Empty means not recorded. */
  distance: string;
  /** Kilocalories. Empty means not recorded. */
  energyKcal: string;
}

export type ManualWorkoutField =
  "sportType" | "start" | "duration" | "distance" | "energyKcal";

/**
 * The columns of a hand-entered workout the form has no field for. The batch
 * route's overwrite of a `manual:` row replaces EVERY overwritable column,
 * nulling the ones a re-post leaves out, so an edit sends these back exactly
 * as stored. A MANUAL row can carry them when a client other than this form
 * wrote it (a phone shortcut posting heart rate or steps).
 */
export interface ManualWorkoutCarried {
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  stepCount?: number;
  elevationM?: number;
  pauseDurationSec?: number;
}

/** The one entry of the `POST /api/workouts/batch` body this form sends. */
export interface ManualWorkoutEntry extends ManualWorkoutCarried {
  sportType: WorkoutSportType;
  startedAt: string;
  endedAt: string;
  source: "MANUAL";
  externalId: string;
  totalDistanceM?: number;
  totalEnergyKcal?: number;
}

/**
 * The stored row an edit starts from (#1162): the draft it was shown as, and
 * the stored values behind it. A field whose text the person left as shown
 * sends the stored value, not the value re-parsed from that text, so opening
 * and saving an edit never moves a start by its seconds or a distance by the
 * rounding of its display (5 000 m shown as 3.11 mi would come back as
 * 5 005.1 m).
 */
export interface ManualWorkoutOriginal {
  draft: ManualWorkoutDraft;
  startedAt: string;
  endedAt: string;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
  carried: ManualWorkoutCarried;
}

export interface ManualWorkoutContext {
  /** The profile timezone the start is read in. */
  timezone: string;
  unitPreference: UnitPreference;
  /** The id this form instance sends with every submit. */
  externalId: string;
  now: Date;
  /** Set when the form edits a stored workout rather than logging one. */
  original?: ManualWorkoutOriginal;
}

export type ManualWorkoutResult =
  | { ok: true; entry: ManualWorkoutEntry }
  | { ok: false; errors: Partial<Record<ManualWorkoutField, string>> };

const ERR = "insights.workouts.manual.errors";

/**
 * Whether "Log workout" is offered: in one's own record, with the workouts
 * module on.
 *
 * Own record only because the route behind it is: the batch ingest resolves
 * the caller (`requireAuth`), and a delegate acting on somebody else's record
 * would be refused, so no section of a grant can admit it. The module half is
 * the `capture:workout` surface; an absent module map (the account still
 * loading) offers it, the gate's default-on contract.
 *
 * The workouts page asks this; the dashboard add menu and the capture picker
 * ask `visibleCaptureKinds`, which applies the same two terms to the
 * `workout` kind.
 */
export function canLogWorkout(
  caps: { inSharedRecord: boolean },
  modules?: SurfaceModuleMap | null,
): boolean {
  return !caps.inSharedRecord && isSurfaceVisible("capture:workout", modules);
}

/**
 * Whether a workout can be edited from its detail page (#1162): one entered
 * by hand through the form, in one's own record. The edit is a re-post of the
 * row's own `manual:` id through `POST /api/workouts/batch`, which the route
 * treats as an overwrite of that row and of nothing else, so a MANUAL row
 * without such an id (none is expected; the form has always minted one) can
 * still be deleted but not edited.
 */
export function canEditWorkout(
  workout: { source: string; externalId: string | null },
  caps: { inSharedRecord: boolean },
): boolean {
  return (
    workout.source === "MANUAL" &&
    typeof workout.externalId === "string" &&
    workout.externalId.startsWith("manual:") &&
    !caps.inSharedRecord
  );
}

/** The stored workout an edit opens from, in the detail read's field names. */
export interface StoredManualWorkout {
  sportType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  distanceM: number | null;
  activeEnergyKcal: number | null;
  minHr: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  /** The row's own heart rate, before any twin filled it in. */
  storedAvgHr: number | null;
  storedMaxHr: number | null;
}

/**
 * The draft a stored workout is shown as, and the stored values behind it.
 * The start reads in the profile timezone to the minute, the duration in
 * whole minutes, the distance in the reader's unit at its display precision.
 */
export function manualWorkoutOriginalFromRow(
  row: StoredManualWorkout,
  opts: { timezone: string; unitPreference: UnitPreference },
): ManualWorkoutOriginal {
  const sport = workoutSportTypeEnum.safeParse(row.sportType);
  const totalMinutes = Math.max(0, Math.round(row.durationSec / 60));
  const distance =
    row.distanceM === null
      ? ""
      : String(
          applyDisplayTransform(
            row.distanceM,
            getQuantityTransform("distance", opts.unitPreference),
          ),
        );
  const carried: ManualWorkoutCarried = {};
  if (row.storedAvgHr !== null) carried.avgHeartRate = row.storedAvgHr;
  if (row.storedMaxHr !== null) carried.maxHeartRate = row.storedMaxHr;
  if (row.minHr !== null) carried.minHeartRate = row.minHr;
  if (row.stepCount !== null) carried.stepCount = row.stepCount;
  if (row.elevationM !== null) carried.elevationM = row.elevationM;
  if (row.pauseDurationSec !== null) {
    carried.pauseDurationSec = row.pauseDurationSec;
  }
  return {
    draft: {
      sportType: sport.success ? sport.data : "",
      start: wallClockNow(new Date(row.startedAt), opts.timezone),
      hours: String(Math.floor(totalMinutes / 60)),
      minutes: String(totalMinutes % 60),
      distance,
      energyKcal:
        row.activeEnergyKcal === null ? "" : String(row.activeEnergyKcal),
    },
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: new Date(row.endedAt).toISOString(),
    totalDistanceM: row.distanceM,
    totalEnergyKcal: row.activeEnergyKcal,
    carried,
  };
}

/** A fresh id for one opened form. The prefix says where the row came from. */
export function newManualWorkoutExternalId(): string {
  return `manual:${randomId()}`;
}

/** `now` as the wall clock the start field shows, `yyyy-MM-ddTHH:mm`. */
export function wallClockNow(now: Date, timezone: string): string {
  const p = wallClockInTz(now, timezone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function emptyManualWorkoutDraft(): ManualWorkoutDraft {
  return {
    sportType: "",
    // Blank on purpose (#1085): a blank start means "it just ended", so the
    // workout is saved as starting `duration` before now.
    start: "",
    hours: "",
    minutes: "",
    distance: "",
    energyKcal: "",
  };
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function startToUtc(start: string, timezone: string): Date | null {
  const m = WALL_CLOCK.exec(start);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;
  const at = zonedWallClockToUtc({ year, month, day, hour, minute }, timezone);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * A typed number, or `null` for an empty field, or `NaN` for garbage.
 * Accepts a decimal comma, which is what half the locales type.
 */
function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+([.,]\d+)?$/.test(trimmed)) return Number.NaN;
  return Number(trimmed.replace(",", "."));
}

function parseWhole(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

/**
 * The draft, checked. Built per call because "not in the future" and the
 * unit conversion depend on the context.
 */
function manualWorkoutSchema(ctx: ManualWorkoutContext) {
  return z
    .object({
      sportType: z.string(),
      start: z.string(),
      hours: z.string(),
      minutes: z.string(),
      distance: z.string(),
      energyKcal: z.string(),
    })
    .superRefine((d, issue) => {
      if (!workoutSportTypeEnum.safeParse(d.sportType).success) {
        issue.addIssue({
          code: "custom",
          path: ["sportType"],
          message: `${ERR}.sportRequired`,
        });
      }

      const startBlank = d.start.trim() === "";
      const startedAt = startBlank ? null : startToUtc(d.start, ctx.timezone);
      if (!startBlank && startedAt === null) {
        issue.addIssue({
          code: "custom",
          path: ["start"],
          message: `${ERR}.startRequired`,
        });
      } else if (
        startedAt !== null &&
        startedAt.getTime() > ctx.now.getTime() + FUTURE_TOLERANCE_MS
      ) {
        issue.addIssue({
          code: "custom",
          path: ["start"],
          message: `${ERR}.startInFuture`,
        });
      }

      const hours = parseWhole(d.hours);
      const minutes = parseWhole(d.minutes);
      if (
        Number.isNaN(hours) ||
        Number.isNaN(minutes) ||
        (minutes !== null && minutes > 59)
      ) {
        issue.addIssue({
          code: "custom",
          path: ["duration"],
          message: `${ERR}.durationInvalid`,
        });
      } else {
        const sec = ((hours ?? 0) * 60 + (minutes ?? 0)) * 60;
        if (sec <= 0) {
          issue.addIssue({
            code: "custom",
            path: ["duration"],
            message: `${ERR}.durationRequired`,
          });
        } else if (sec > MANUAL_WORKOUT_MAX_DURATION_SEC) {
          issue.addIssue({
            code: "custom",
            path: ["duration"],
            message: `${ERR}.durationTooLong`,
          });
        } else if (
          // Only a start the person entered can push the end past now; a
          // blank start is read as "now minus the duration".
          startedAt !== null &&
          startedAt.getTime() + sec * 1000 >
            ctx.now.getTime() + FUTURE_TOLERANCE_MS
        ) {
          issue.addIssue({
            code: "custom",
            path: ["duration"],
            message: `${ERR}.endInFuture`,
          });
        }
      }

      const distance = parseDecimal(d.distance);
      if (
        distance !== null &&
        (Number.isNaN(distance) ||
          toMetres(distance, ctx.unitPreference) >
            MANUAL_WORKOUT_MAX_DISTANCE_M)
      ) {
        issue.addIssue({
          code: "custom",
          path: ["distance"],
          message: `${ERR}.distanceInvalid`,
        });
      }

      const energy = parseDecimal(d.energyKcal);
      if (
        energy !== null &&
        (Number.isNaN(energy) || energy > MANUAL_WORKOUT_MAX_ENERGY_KCAL)
      ) {
        issue.addIssue({
          code: "custom",
          path: ["energyKcal"],
          message: `${ERR}.energyInvalid`,
        });
      }
    });
}

/** A distance in the reader's unit, in metres to a tenth. */
function toMetres(display: number, preference: UnitPreference): number {
  const metres = invertDisplayTransform(
    display,
    getQuantityTransform("distance", preference),
  );
  return Math.round(metres * 10) / 10;
}

/**
 * Validate the draft and build the batch entry from it, field by field.
 * Returns the first error per field when it does not validate.
 */
export function buildManualWorkoutEntry(
  draft: ManualWorkoutDraft,
  ctx: ManualWorkoutContext,
): ManualWorkoutResult {
  const parsed = manualWorkoutSchema(ctx).safeParse(draft);
  if (!parsed.success) {
    const errors: Partial<Record<ManualWorkoutField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as ManualWorkoutField;
      errors[field] ??= issue.message;
    }
    return { ok: false, errors };
  }

  // Every branch below was proven by the schema above.
  const original = ctx.original;
  const durationSec =
    ((parseWhole(draft.hours) ?? 0) * 60 + (parseWhole(draft.minutes) ?? 0)) *
    60;
  // An edit whose start and duration read as shown keeps the stored instants
  // to the second; changing either re-derives both from the fields.
  const timesAsShown =
    original !== undefined &&
    draft.start === original.draft.start &&
    draft.hours === original.draft.hours &&
    draft.minutes === original.draft.minutes;
  const startedAt = timesAsShown
    ? new Date(original.startedAt)
    : draft.start.trim() === ""
      ? new Date(ctx.now.getTime() - durationSec * 1000)
      : startToUtc(draft.start, ctx.timezone)!;
  const endedAt = timesAsShown
    ? new Date(original.endedAt)
    : new Date(startedAt.getTime() + durationSec * 1000);
  const distance = parseDecimal(draft.distance);
  const energy = parseDecimal(draft.energyKcal);

  const entry: ManualWorkoutEntry = {
    sportType: draft.sportType as WorkoutSportType,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    source: "MANUAL",
    externalId: ctx.externalId,
    // Everything the form has no field for goes back as stored, because the
    // overwrite nulls whatever a re-post leaves out.
    ...(original?.carried ?? {}),
  };
  if (original && draft.distance === original.draft.distance) {
    if (original.totalDistanceM !== null) {
      entry.totalDistanceM = original.totalDistanceM;
    }
  } else if (distance !== null) {
    entry.totalDistanceM = toMetres(distance, ctx.unitPreference);
  }
  if (original && draft.energyKcal === original.draft.energyKcal) {
    if (original.totalEnergyKcal !== null) {
      entry.totalEnergyKcal = original.totalEnergyKcal;
    }
  } else if (energy !== null) {
    entry.totalEnergyKcal = energy;
  }
  return { ok: true, entry };
}
