import { annotate } from "@/lib/logging/context";
import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";
import { buildCoachSourceSnapshot } from "@/lib/ai/coach/source-snapshot";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getMetricSeriesArgsSchema } from "../definitions";
import {
  COACH_SOURCE_SNAPSHOT_KEY,
  METRIC_SERIES_EXCLUDED_SOURCES,
} from "../source-keys";
import { subjectForTool } from "../availability";
import {
  badArgs,
  emptyRead,
  limitWindow,
  pickSection,
  readToolSnapshot,
} from "./shared";
import type { CoachToolResult } from "./types";

export async function getMetricSeries(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
  sourceSnapshot: boolean,
): Promise<CoachToolResult> {
  const parsed = getMetricSeriesArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_metric_series", parsed.error);
  const { metric, window } = parsed.data;

  // Glucose / workouts / compliance have dedicated tools (or are deferred);
  // refuse to answer them here so the model is pointed at the right tool
  // rather than getting a fabricated-shape miss.
  if (METRIC_SERIES_EXCLUDED_SOURCES.has(metric)) {
    return {
      present: false,
      reason:
        metric === "glucose"
          ? "use_get_glucose_panel"
          : metric === "compliance"
            ? "use_get_medication_compliance"
            : "unsupported_metric",
    };
  }

  const sectionKey = COACH_SOURCE_SNAPSHOT_KEY[metric];
  if (!sectionKey) {
    return { present: false, reason: "unsupported_metric" };
  }

  // An MCP read needs one section and nothing else, so it is built from that
  // source's own rows: the same section, without the context blocks a Coach
  // turn carries. See `source-snapshot.ts`. Only MCP asks for it, and MCP
  // reads without the Coach's lookback limit, so it takes no reach.
  const snapshot = sourceSnapshot
    ? await buildCoachSourceSnapshot(userId, metric, window ?? fallbackWindow)
    : await readToolSnapshot(
        userId,
        [metric],
        [sectionKey],
        window,
        fallbackWindow,
        sharedScope,
        reach,
      );
  const section = pickSection(snapshot.sections, sectionKey);
  if (section === undefined) {
    return emptyRead(
      userId,
      metric,
      subjectForTool("get_metric_series", metric),
      limitWindow(window ?? fallbackWindow, reach),
      reach,
    );
  }
  if (sourceSnapshot) {
    // MCP: the section exactly as it always was, without the figure check
    // below: an MCP client reads `present` by its own contract (absence is
    // "not recorded"), and its output stays byte for byte what it was.
    return {
      present: true,
      data: { metric, section },
      grounding: snapshot.referenceGrounding ?? undefined,
    };
  }
  // A block without a single figure (a bare unit, an `omitted` marker) is
  // not an answer: "present" with nothing in it is what the model then
  // repeats to the person. Say the read failed instead.
  if (!carriesFigures(section)) {
    annotate({
      action: { name: "coach.tool.section_without_values" },
      meta: { tool: "get_metric_series", metric },
    });
    return { present: false, reason: "retrieval_failed" };
  }
  // Outside MCP the read is a Coach snapshot, which counts what it read.
  const counts = (snapshot as Partial<CoachSnapshotResult>).provenance
    ?.counts as Record<string, number | undefined> | undefined;
  const readings = counts?.[metric];
  const effectiveWindow = limitWindow(window ?? fallbackWindow, reach);
  const condensed = isRecord(section) && Array.isArray(section.condensed);
  const long = effectiveWindow === "allTime" || effectiveWindow === "lastYear";
  return {
    present: true,
    data: {
      metric,
      section,
      ...(typeof readings === "number" ? { readings } : {}),
      ...(long || condensed ? { coverage: SERIES_COVERAGE_NOTE } : {}),
    },
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

/**
 * What a long or condensed series read carries, and where the rest is. Rides
 * the result so the model switches to the table tool on its own instead of
 * asking the person whether it should.
 */
const SERIES_COVERAGE_NOTE =
  "Daily values for the newest 14 days, weekly means before that, back at most 12 months; " +
  "timeline.coarse (when present) adds monthly and yearly means for older history. " +
  "A 'condensed' list names what was cut to fit. A 'summary', when present, is taken from the series' daily values over the whole read ('from' to 'to', 'days'): " +
  "the first and last day, the lowest and highest day, the mean of the days, and 'change' = 'latestWeekMean' minus 'firstWeekMean' (the latest 7 calendar days against the first 7). " +
  "For the full history or a finer table, call get_metric_table yourself in this answer (window allTime, granularity month or week); do not ask the person first.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fields that describe a block rather than measure anything: the freshness
 * stamp (`asOf.daysAgo` is a number, but no reading), and the scope echo. A
 * block trimmed to `{ unit, asOf }` holds no figure.
 */
const METADATA_FIELDS: ReadonlySet<string> = new Set(["asOf", "scope"]);

/** Whether a payload holds at least one finite measured number anywhere. */
function carriesFigures(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(carriesFigures);
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, child]) => !METADATA_FIELDS.has(key) && carriesFigures(child),
    );
  }
  return false;
}
