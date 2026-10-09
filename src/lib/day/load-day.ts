/**
 * `loadDay`: one local day across the record, for every reader (v1.42, #613).
 *
 * The web view, the native client, the Coach and the MCP endpoint all read a
 * day through this function, so they cannot disagree about what a Tuesday
 * held. The readings come live from `measurements` inside the local window
 * (never from the rollups, which cut at UTC), the record sections from their
 * own tables, each bounded to the day and indexed on its time field, and all
 * of them in parallel.
 *
 * What the caller may see is decided before anything is read
 * (`DayAccess`): a section of a switched-off module is not read and not
 * mentioned, a section the grant does not cover is not read and is named
 * once in `sections`. Nothing here writes, and nothing here talks to a model;
 * `model-projection.ts` is the one way a day leaves for one.
 */
import type { MeasurementType } from "@/generated/prisma/enums";

import type { DayEvent, DayResponse, DayRunningItem } from "@/lib/day/contract";
import { loadNotableRange } from "@/lib/day/notable";
import {
  RECORD_SECTION_READERS,
  type DayFrame,
  type SectionPart,
} from "@/lib/day/records";
import { DAY_SCORE_MEASUREMENT_TYPES, readDayScores } from "@/lib/day/scores";
import { measurementTypeVisible, type DayAccess } from "@/lib/day/sections";
import { readDayBands, shapeDayValues } from "@/lib/day/values";
import {
  resolveDayReadings,
  type DayReadings,
} from "@/lib/mood/linked-context";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { localDayWindow } from "@/lib/tz/local-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";

const NO_READINGS: DayReadings = {
  rowsByType: new Map(),
  night: null,
  nightSource: null,
};

/** Date-only entries first, then by time; ties keep the section order. */
function byTime(a: DayEvent, b: DayEvent): number {
  if (a.at === b.at) return 0;
  if (a.at === null) return -1;
  if (b.at === null) return 1;
  return a.at.localeCompare(b.at);
}

/** Oldest start first; an item without a start date follows the dated ones. */
function bySince(a: DayRunningItem, b: DayRunningItem): number {
  if (a.since !== b.since) {
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    return a.since.localeCompare(b.since);
  }
  return a.title.localeCompare(b.title);
}

export interface LoadDayArgs {
  /** The record's user id (the resolved user, never the actor). */
  recordId: string;
  day: string;
  access: DayAccess;
  /** The record's zone; resolved when absent. */
  tz?: string;
  /** The earliest instant a comparison may read (a lookback limit). */
  floor?: Date | null;
}

export async function loadDay(args: LoadDayArgs): Promise<DayResponse> {
  const { recordId, day, access } = args;
  const tz = args.tz ?? (await resolveUserTimezone(recordId));
  const { dayStart, dayEnd } = localDayWindow(day, tz);
  const valuesReadable = access.readable.has("values");
  const sleepReadable = access.readable.has("sleep");
  const scoresReadable = access.readable.has("scores");

  const typeVisible = (type: MeasurementType): boolean => {
    if (!measurementTypeVisible(type, access.modules)) return false;
    // A stored score is shown with the scores, on the day it describes.
    if (scoresReadable && DAY_SCORE_MEASUREMENT_TYPES.has(type)) return false;
    return type === "SLEEP_DURATION" ? sleepReadable : valuesReadable;
  };

  const frame: DayFrame = {
    userId: recordId,
    day,
    tz,
    dayStart,
    dayEnd,
    documentsReadable: access.readable.has("documents"),
  };

  const priority =
    valuesReadable || sleepReadable || scoresReadable
      ? await loadUserSourcePriority(recordId)
      : null;

  const recordSections = [...access.readable].filter(
    (section) => RECORD_SECTION_READERS[section] !== undefined,
  );
  const [readings, parts, scores] = await Promise.all([
    valuesReadable || sleepReadable
      ? resolveDayReadings(
          recordId,
          day,
          tz,
          { dayStart, dayEnd },
          typeVisible,
          priority,
        )
      : Promise.resolve(NO_READINGS),
    Promise.all(
      recordSections.map((section) =>
        (
          RECORD_SECTION_READERS[section] as (
            frame: DayFrame,
          ) => Promise<SectionPart>
        )(frame),
      ),
    ),
    scoresReadable
      ? readDayScores({
          userId: recordId,
          day,
          tz,
          modules: access.modules,
          priorityJson: priority,
          floor: args.floor ?? null,
        })
      : Promise.resolve([]),
  ]);

  const presentTypes = [...readings.rowsByType.keys()];
  const [bands, notable] =
    presentTypes.length === 0
      ? [new Map(), []]
      : await Promise.all([
          readDayBands({
            userId: recordId,
            day,
            tz,
            types: presentTypes,
            priorityJson: priority,
            floor: args.floor ?? null,
          }),
          loadNotableRange({
            userId: recordId,
            from: day,
            to: day,
            tz,
            priorityJson: priority,
            typeVisible,
            gaps: false,
            extremeTypes: presentTypes,
            firstValueTypes: presentTypes,
            floor: args.floor ?? null,
          }),
        ]);

  const values = shapeDayValues(readings, bands, sleepReadable, tz);
  const running = parts.flatMap((p) => p.running).sort(bySince);
  const events = parts.flatMap((p) => p.events).sort(byTime);

  const sections: DayResponse["sections"] = {};
  for (const section of access.notShared) {
    sections[section] = { available: false, reason: "not_shared" };
  }

  return {
    date: day,
    tz,
    counts: { values: values.length, entries: events.length },
    running,
    values,
    events,
    notable: notable.map(({ kind, type, params }) => ({ kind, type, params })),
    scores,
    sections,
  };
}
