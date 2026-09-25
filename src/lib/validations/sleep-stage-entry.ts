/**
 * One sleep-stage segment, named rather than coded, for `POST /api/measurements`.
 *
 * Until v1.39.1 a stage could only arrive through the batch route, in the
 * HealthKit dialect: `hkIdentifier: HKCategoryTypeIdentifierSleepAnalysis`, a
 * `sleepStage` codepoint 0..5 whose meaning is Apple's, and a value the client
 * had to work out in minutes. A bridge such as Tasker or Home Assistant knows
 * none of that. This shape lets it say what it has: the stage by name, and the
 * segment either as its start and end or as its end and length.
 *
 * The row that lands is the row the batch route would have written for the
 * same segment: `SLEEP_DURATION`, value in minutes, `measuredAt` at the
 * segment's END (Apple's convention, which every sleep reader assumes), the
 * stage in `sleepStage`. Dedupe is the batch route's too: the
 * `(type, source, externalId)` identity and the
 * `(type, measuredAt, source, sleepStage)` identity, reconciled in one step.
 */
import { z } from "zod/v4";

import { validateEntryInstant } from "./entry-instant";
import { assertStableExternalId } from "@/lib/validations/external-id";
import {
  validateMeasurementRange,
  writableMeasurementSourceEnum,
} from "./measurement";

/** The stage names the `SleepStage` column stores, as a caller writes them. */
export const SLEEP_STAGE_NAMES = [
  "IN_BED",
  "ASLEEP",
  "AWAKE",
  "CORE",
  "DEEP",
  "REM",
] as const;

export type SleepStageName = (typeof SLEEP_STAGE_NAMES)[number];

/** A difference of up to a minute between `value` and the dates is rounding. */
const VALUE_TOLERANCE_MINUTES = 1;

const instant = () =>
  validateEntryInstant(
    z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  );

export const sleepStageEntrySchema = z
  .object({
    type: z.literal("SLEEP_DURATION"),
    sleepStage: z.enum(SLEEP_STAGE_NAMES),
    startDate: instant().optional(),
    endDate: instant().optional(),
    /** The segment's END, when it is sent as an end and a length. */
    measuredAt: instant().optional(),
    /** Minutes. Required with `measuredAt`; optional with start and end. */
    value: z.number().finite().optional(),
    externalId: z.string().min(1).max(120).optional(),
    source: writableMeasurementSourceEnum.optional().default("MANUAL"),
    deviceType: z.string().min(1).max(32).nullable().optional(),
  })
  .superRefine((entry, ctx) => {
    assertStableExternalId(entry, ctx);

    const hasDates =
      entry.startDate !== undefined || entry.endDate !== undefined;
    const hasEndAndLength = entry.measuredAt !== undefined;
    if (hasDates && hasEndAndLength) {
      ctx.addIssue({
        code: "custom",
        path: ["measuredAt"],
        message:
          "Send the segment either as startDate and endDate, or as measuredAt (its end) and value (its length in minutes), not both",
      });
      return;
    }
    if (hasDates) {
      if (entry.startDate === undefined || entry.endDate === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [entry.startDate === undefined ? "startDate" : "endDate"],
          message: "startDate and endDate are sent together",
        });
        return;
      }
      if (entry.endDate < entry.startDate) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "endDate must not be before startDate",
        });
        return;
      }
      const minutes =
        (entry.endDate.getTime() - entry.startDate.getTime()) / 60_000;
      if (
        entry.value !== undefined &&
        Math.abs(entry.value - minutes) > VALUE_TOLERANCE_MINUTES
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message:
            "value disagrees with startDate and endDate; send the dates alone, or a value that matches them",
        });
        return;
      }
      if (validateMeasurementRange("SLEEP_DURATION", minutes) !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "A sleep segment lasts between 0 and 1440 minutes",
        });
      }
      return;
    }
    if (hasEndAndLength) {
      if (entry.value === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message:
            "value (the segment's length in minutes) is required with measuredAt",
        });
        return;
      }
      if (validateMeasurementRange("SLEEP_DURATION", entry.value) !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "A sleep segment lasts between 0 and 1440 minutes",
        });
      }
      return;
    }
    ctx.addIssue({
      code: "custom",
      path: ["startDate"],
      message:
        "Send the segment as startDate and endDate, or as measuredAt (its end) and value (its length in minutes)",
    });
  });

export type SleepStageEntry = z.infer<typeof sleepStageEntrySchema>;

/** A parsed entry, reduced to the segment it describes. */
export interface SleepStageSegment {
  stage: SleepStageName;
  start: Date;
  end: Date;
  minutes: number;
  /**
   * The caller's id, or one derived from the stage and the two instants, so a
   * bridge that sends no id still re-posts onto the same row.
   */
  externalId: string;
}

/**
 * The id a segment gets when the caller sends none. The stage and both
 * instants, so the same segment sent twice is one row, and a segment whose
 * start was corrected keeps its end (and so its natural identity) and is
 * updated rather than duplicated.
 */
export function derivedSleepStageExternalId(
  stage: SleepStageName,
  start: Date,
  end: Date,
): string {
  return `sleep-stage:${stage}:${start.toISOString()}/${end.toISOString()}`;
}

export function toSleepStageSegment(entry: SleepStageEntry): SleepStageSegment {
  let start: Date;
  let end: Date;
  let minutes: number;
  if (entry.startDate && entry.endDate) {
    start = entry.startDate;
    end = entry.endDate;
    minutes = (end.getTime() - start.getTime()) / 60_000;
  } else {
    // The refinement guarantees the end-and-length form here.
    end = entry.measuredAt!;
    minutes = entry.value!;
    start = new Date(end.getTime() - Math.round(minutes * 60_000));
  }
  return {
    stage: entry.sleepStage,
    start,
    end,
    minutes,
    externalId:
      entry.externalId ??
      derivedSleepStageExternalId(entry.sleepStage, start, end),
  };
}

/**
 * Whether a single-object body asks for the named-stage form. Only a string
 * `sleepStage` does. The plain create schema never read the field, so a body
 * that carried one before was stored without its stage; it is now stored with
 * it, or refused with the reason.
 */
export function isNamedSleepStageBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as { sleepStage?: unknown }).sleepStage === "string"
  );
}
