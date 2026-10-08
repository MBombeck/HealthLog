/**
 * `get_day` for the Coach and the MCP endpoint (v1.42, #613).
 *
 * The day the person sees, through the same loader, projected for a model:
 * life events and notes never leave (`model-projection.ts`), and a section of
 * a switched-off module is named as such rather than read. Life events are
 * not even loaded on this path: the sections the projection would drop are
 * taken out of the access set before the loader runs, so their rows are
 * neither read nor decrypted for a model's request.
 *
 * Read on the person's own record only: both callers act for the owner.
 *
 * The Coach also hands in the person's Coach exclusions (`loadExcluded`, the
 * same set `coachExclusions` builds for every other Coach read). Each token
 * maps to the day sections and measurement types it covers
 * ({@link DAY_EXCLUSIONS_BY_TOKEN}); the sections are taken out before the
 * loader runs and the types are dropped from the projection, so a metric the
 * person keeps from the Coach does not come back through the day.
 * `coach-day-exclusions-guard.test.ts` holds every token to its map.
 */
import {
  MODEL_EXCLUDED_DAY_SECTIONS,
  type DaySectionKey,
} from "@/lib/day/contract";
import { loadDay } from "@/lib/day/load-day";
import {
  projectDayForModel,
  type ModelDay,
  type ModelDayExclusions,
} from "@/lib/day/model-projection";
import { resolveDayAccess } from "@/lib/day/sections";
import {
  reachFloor,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import type { CoachScopeSource } from "@/lib/ai/coach/types";
import type { CoachExcludeMetric } from "@/lib/validations/coach-prefs";
import { userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export type DayToolResult =
  | { present: true; data: ModelDay }
  | {
      present: false;
      reason: "no_data" | "outside_window" | "outside_reach";
    };

const EXCLUDED: ReadonlySet<DaySectionKey> = new Set<DaySectionKey>(
  MODEL_EXCLUDED_DAY_SECTIONS,
);

/**
 * The day sections each Coach exclusion token covers, beyond the measurement
 * types `COACH_SOURCE_MEASUREMENT_TYPES` already names for it. A token whose
 * data the day does not hold maps to nothing, with the reason beside it.
 * Typed as a full record, so a new token does not compile without an entry.
 */
export const DAY_EXCLUSIONS_BY_TOKEN: Readonly<
  Record<CoachExcludeMetric, readonly DaySectionKey[]>
> = {
  bp: [],
  weight: [],
  pulse: [],
  // A mood entry and a mental-health screener are both the person's mood.
  mood: ["mood", "assessments"],
  // Intakes are what compliance is computed from.
  compliance: ["medications"],
  hrv: [],
  sleep: ["sleep"],
  resting_hr: [],
  steps: [],
  medications: ["medications"],
  // Height, age and gender are not part of a day.
  anthropometrics: [],
};

/**
 * Further sections for the sources a switched-off module adds to the
 * exclusions (`coachExclusions`). The module's own sections are already
 * absent through the module gate; this keeps the two in step.
 */
const DAY_SECTIONS_BY_SOURCE: Partial<
  Record<CoachScopeSource, readonly DaySectionKey[]>
> = {
  workouts: ["workouts"],
};

/** Every sleep-night measurement, not only the duration the snapshot reads. */
const SLEEP_TYPE_PREFIX = "SLEEP_";

/** The sections and measurement types a set of Coach exclusions covers. */
export function dayExclusionsFor(
  excluded: ReadonlySet<string>,
  allTypes: readonly string[] = [],
): ModelDayExclusions {
  const sections = new Set<DaySectionKey>();
  const types = new Set<string>();
  for (const token of excluded) {
    for (const section of DAY_EXCLUSIONS_BY_TOKEN[
      token as CoachExcludeMetric
    ] ?? []) {
      sections.add(section);
    }
    for (const section of DAY_SECTIONS_BY_SOURCE[token as CoachScopeSource] ??
      []) {
      sections.add(section);
    }
    for (const type of COACH_SOURCE_MEASUREMENT_TYPES[
      token as CoachScopeSource
    ] ?? []) {
      types.add(type);
    }
    if (token === "sleep") {
      for (const type of allTypes) {
        if (type.startsWith(SLEEP_TYPE_PREFIX)) types.add(type);
      }
    }
  }
  return { sections, types };
}

export async function readDayForTool(args: {
  userId: string;
  date: string;
  reach: CoachHistoryReach;
  now?: Date;
  /** Wraps a free-text leaf (a title) for the reader; identity by default. */
  text?: (value: string) => string;
  /**
   * Reads the person's Coach exclusions; the MCP endpoint passes none. Called
   * only once the day is inside the window and the lookback limit.
   */
  loadExcluded?: () => Promise<ReadonlySet<string>>;
}): Promise<DayToolResult> {
  const now = args.now ?? new Date();
  const tz = await resolveUserTimezone(args.userId);
  if (args.date > userDayKey(now, tz)) {
    return { present: false, reason: "outside_window" };
  }
  // A day that ended before the lookback limit is refused before anything
  // is read; a day inside it reads its comparisons no further back.
  const floor = reachFloor(args.reach, now);
  const { dayEnd } = localDayWindow(args.date, tz);
  if (floor !== null && dayEnd <= floor) {
    return { present: false, reason: "outside_reach" };
  }

  const access = await resolveDayAccess({
    recordId: args.userId,
    domainVisible: () => true,
    owner: true,
  });
  const excluded = args.loadExcluded
    ? await args.loadExcluded()
    : new Set<string>();
  const sections = dayExclusionsFor(excluded).sections;
  const readable = new Set(
    [...access.readable].filter(
      (section) => !EXCLUDED.has(section) && !sections.has(section),
    ),
  );
  const day = await loadDay({
    recordId: args.userId,
    day: args.date,
    access: { ...access, readable },
    tz,
    floor,
  });
  const data = projectDayForModel(
    day,
    access.moduleOff,
    args.text,
    dayExclusionsFor(
      excluded,
      day.values.map((value) => value.type),
    ),
  );
  if (
    data.values.length === 0 &&
    data.events.length === 0 &&
    data.running.length === 0
  ) {
    return { present: false, reason: "no_data" };
  }
  return { present: true, data };
}
