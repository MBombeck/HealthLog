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

/** The one entry of the `POST /api/workouts/batch` body this form sends. */
export interface ManualWorkoutEntry {
  sportType: WorkoutSportType;
  startedAt: string;
  endedAt: string;
  source: "MANUAL";
  externalId: string;
  totalDistanceM?: number;
  totalEnergyKcal?: number;
}

export interface ManualWorkoutContext {
  /** The profile timezone the start is read in. */
  timezone: string;
  unitPreference: UnitPreference;
  /** The id this form instance sends with every submit. */
  externalId: string;
  now: Date;
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
  const durationSec =
    ((parseWhole(draft.hours) ?? 0) * 60 + (parseWhole(draft.minutes) ?? 0)) *
    60;
  const startedAt =
    draft.start.trim() === ""
      ? new Date(ctx.now.getTime() - durationSec * 1000)
      : startToUtc(draft.start, ctx.timezone)!;
  const distance = parseDecimal(draft.distance);
  const energy = parseDecimal(draft.energyKcal);

  const entry: ManualWorkoutEntry = {
    sportType: draft.sportType as WorkoutSportType,
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + durationSec * 1000).toISOString(),
    source: "MANUAL",
    externalId: ctx.externalId,
  };
  if (distance !== null) {
    entry.totalDistanceM = toMetres(distance, ctx.unitPreference);
  }
  if (energy !== null) entry.totalEnergyKcal = energy;
  return { ok: true, entry };
}
