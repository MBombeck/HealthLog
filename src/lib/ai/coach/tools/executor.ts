/**
 * v1.20.0 (F1) — Coach retrieval tool executor.
 *
 * Dispatches a single tool call from the model: validates the raw JSON
 * arguments against the tool's Zod schema, runs the existing
 * server-authoritative snapshot builder scoped to just the requested domain,
 * and slices the matching section(s) out of the structured result.
 *
 * GROUNDING CONTRACTS (the hallucination audit hammers these):
 *   - Every tool returns a structured `{ present: boolean }`. When the domain
 *     carries no data — or the user opted out of the owning module — the result
 *     is `{ present: false, reason }`. It NEVER throws and NEVER returns an
 *     ambiguous `[]`, so the model can always tell "no data" from "data".
 *   - An empty WINDOW read is never reported as absence on its own. Every
 *     `present: false` that comes from a missing snapshot section routes through
 *     `resolveEmptyRead`, which probes whether the record holds rows outside the
 *     window and returns `outside_window` (with the range + a bounded aggregate)
 *     rather than `no_data`. One reason code for "never recorded" and "recorded,
 *     outside the window I searched" is what made the Coach deny data the app
 *     was displaying on the next screen.
 *   - Module / cycle gates are enforced AT THE BUILDER (`buildCoachSnapshot`
 *     applies `MODULE_EXCLUDED_SOURCES` + the cycle gate before any row is
 *     read), so an opted-out domain is structurally unfetchable here — the
 *     section simply never appears and the executor reports `present: false`.
 *   - `userId` is the session-narrowed id passed by the route, never a tool
 *     argument. Tools are read-only (snapshot reads only), so there is no
 *     mutation or egress surface.
 *
 * The builder result is memoised by the 60s snapshot LRU keyed on
 * `(userId, window, sources)`.
 *
 * v1.21.0 (D5-1) — ONE snapshot per turn. The route hands every tool the SAME
 * `sharedScope` it built the DATA INVENTORY against (the full source set + the
 * conversation window). A full-source build already contains every section, so
 * each tool reads under that shared scope key and slices its own section out —
 * landing the 60s LRU hit the inventory primed rather than rebuilding a
 * distinct single-source snapshot per tool (the D5-1 N-builds-per-turn cost).
 * A tool that overrides the window to something OTHER than the shared window
 * still gets a correct, distinct build (the rare case); the common path
 * collapses to one build.
 */
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { resolveModuleMap } from "@/lib/modules/gate";
import {
  buildCoachSnapshot,
  type CoachSnapshotResult,
} from "@/lib/ai/coach/snapshot";
import { buildCoachSourceSnapshot } from "@/lib/ai/coach/source-snapshot";
import { admitCoachSources, coachExclusions } from "@/lib/ai/coach/scope-gate";
import type { CoachPrefs } from "@/lib/validations/coach-prefs";
import { readMessageResults } from "@/lib/ai/coach/persistence";
import type {
  CoachResultPeriod,
  CoachResultTable,
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
  CoachStepDomain,
} from "@/lib/ai/coach/types";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import {
  METRIC_TABLE_EXCLUDED_SOURCES,
  compareWithCurrent,
  readMetricTable,
  resolveTableRange,
  summariseTable,
} from "@/lib/ai/coach/results/metric-table-tool";
import {
  projectCompliance,
  projectLabs,
  projectWorkouts,
} from "@/lib/ai/coach/results/projections";
import {
  formatPriorResultRef,
  resolvePriorResultRef,
  type PriorResultTurn,
  type ResultRefAllocator,
} from "@/lib/ai/coach/results/refs";
import { isCoachDomainWithheld } from "@/lib/ai/coach/results/domain-module";
import {
  COACH_RESULT_COLUMN_KEYS,
  COACH_RESULT_TITLE_KEYS,
  COACH_RESULT_UI_KEYS,
  coachDomainLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import {
  buildDistributionTable,
  deriveChartSpec,
} from "@/lib/ai/coach/results/chart-spec";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveIntlLocale } from "@/lib/format-locale";
import { DEFAULT_WINDOW } from "@/lib/ai/coach/snapshot-cache";
import {
  getMetricSeriesArgsSchema,
  getGlucosePanelArgsSchema,
  getSleepArgsSchema,
  getMedicationComplianceArgsSchema,
  getLabsArgsSchema,
  getIllnessRecoveryArgsSchema,
  getWorkoutsArgsSchema,
  getCycleArgsSchema,
  getCorrelationsArgsSchema,
  getMetricTableArgsSchema,
  isCoachToolName,
  showResultArgsSchema,
  SHOW_RESULT_TOOL_NAME,
  type CoachToolName,
} from "./definitions";
import {
  COACH_SOURCE_SNAPSHOT_KEY,
  METRIC_SERIES_EXCLUDED_SOURCES,
} from "./source-keys";
import { readCoachCorrelations } from "./correlations-read";
import { resolveLocaleForUser } from "@/lib/i18n/user-locale";
import {
  resolveEmptyRead,
  subjectForTool,
  type CoachAvailabilitySubject,
  type CoachDomainAvailability,
} from "./availability";
import { buildIllnessScores } from "@/lib/ai/coach/illness-snapshot";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import {
  UNBOUNDED_REACH,
  clampWindow,
  exceedsReach,
  isBounded,
  withinReach,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import {
  OUTSIDE_REACH_REASON,
  cycleRecorded,
  illnessBeyondReach,
} from "./availability";

/** A read-only structured tool result. Serialised to a `role:"tool"` turn. */
export interface CoachToolResult {
  present: boolean;
  /** Short machine reason on a `present: false` result (no PII). */
  reason?: string;
  /** The domain payload on a `present: true` result (the snapshot section). */
  data?: unknown;
  /**
   * Optional citation-coupled reference grounding for the fetched metric —
   * published population bands + the user's placement, general guidance only.
   */
  grounding?: string;
  /** The window an empty read searched, so a miss describes its own scope. */
  searchedWindow?: string;
  /**
   * On a `present: false` result whose reason is `outside_window` /
   * `unavailable_in_scope`: what the record holds for this domain over its whole
   * history — count, date range, and a bounded per-series aggregate. These are
   * server-computed figures the model MAY cite; they ride the authoritative set
   * for the prose number-verifier exactly like a present result's payload.
   */
  available?: CoachDomainAvailability;
  /**
   * v1.39.4 — the name of the table this call produced (`r1`..`r6`), so the
   * model can mark the prose that relies on it with `result:rN`. Only in a
   * chat turn; absent when no table was made.
   */
  resultRef?: string;
  /**
   * v1.39.4 — the full table, for the person. NEVER serialised to the model:
   * the loop strips it before the tool-result turn, and the model reads the
   * compact summary in `data` instead. Only in a chat turn.
   */
  table?: CoachResultTable;
}

/**
 * v1.39.4 — what a chat turn hands the executor so a call can produce a
 * table and name it, and `show_result` can find an earlier one. Absent on
 * every other caller (MCP), which then gets the plain result.
 */
export interface CoachToolTurnContext {
  /** The conversation the turn belongs to, already narrowed to its owner. */
  conversationId: string;
  locale: Locale;
  /** The earlier tables of THIS conversation, as the context named them. */
  priorResults: ReadonlyArray<PriorResultTurn>;
  refs: ResultRefAllocator;
  now?: Date;
}

/** What the route persists onto provenance: which tools ran, did data exist. */
export interface CoachToolTrace {
  name: string;
  present: boolean;
  /**
   * v1.39.4 — the call's arguments as their schema validated them; absent
   * when they did not validate. Turn-internal (steps, method, chips): never
   * persisted, the provenance keeps `{ name, present }` only.
   */
  args?: Record<string, unknown>;
}

function pickSection(
  sections: Record<string, unknown>,
  key: string,
): unknown | undefined {
  const value = sections[key];
  if (value === undefined || value === null) return undefined;
  return value;
}

/**
 * A tool's window under the lookback limit: whatever the call asks for, it
 * reads no further back than the limit. `undefined` stays undefined (the
 * builder default, 30 days, is inside every limit but the 7-day one, and the
 * builder clamps that itself).
 */
function limitWindow(
  window: CoachScopeWindow | undefined,
  reach: CoachHistoryReach,
): CoachScopeWindow | undefined {
  return window === undefined ? undefined : clampWindow(window, reach);
}

/**
 * Resolve the scope a tool reads its snapshot under.
 *
 * v1.21.0 (D5-1) — when the route handed us a `sharedScope` (the full-source
 * inventory build for this turn) AND the tool's effective window matches the
 * shared window, read under the SHARED scope key so the per-tool read lands the
 * 60s LRU hit the inventory already primed (the section it needs is present in
 * the full-source build). Otherwise — no shared scope, or a window override —
 * fall back to the tight per-source scope (a correct, distinct build).
 *
 * The window default chain is unchanged: `args.window` wins, else the
 * conversation's `fallbackWindow`, else the builder default.
 */
function scopeFor(
  sources: CoachScope["sources"],
  window: CoachScopeWindow | undefined,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): CoachScope {
  const effectiveWindow = limitWindow(window ?? fallbackWindow, reach);
  if (sharedScope && sharedScope.window === effectiveWindow) {
    // Same window as the inventory's full-source build → reuse its cache entry.
    return sharedScope;
  }
  return {
    sources,
    window: effectiveWindow,
  };
}

/**
 * The snapshot a tool slices its block(s) out of.
 *
 * Reads under `scopeFor` first, which lands on the turn's shared full-source
 * build when the windows match. That build is cut to the prompt budget for a
 * prompt this read never sends: on an account with many synced series the
 * budget pass collapses whole blocks to an `{ omitted }` marker, and slicing
 * the marker out answered `present: true` with no figure in it. So when a
 * block this read needs was cut there, it is read again from its own sources
 * at the same window, where it is the block that was asked for.
 */
async function readToolSnapshot(
  userId: string,
  sources: CoachScope["sources"],
  sectionKeys: ReadonlyArray<string>,
  window: CoachScopeWindow | undefined,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
) {
  const scope = scopeFor(sources, window, fallbackWindow, sharedScope, reach);
  if (scope !== sharedScope) {
    return buildCoachSnapshot(userId, scope, {
      reach,
      condenseRequested: true,
    });
  }
  const snapshot = await buildCoachSnapshot(userId, scope, { reach });
  const cut = sectionKeys.filter((key) =>
    snapshot.degradedBlocks?.includes(key),
  );
  if (cut.length === 0) return snapshot;
  annotate({
    action: { name: "coach.tool.shared_block_cut" },
    meta: { blocks: cut, window: scope.window ?? DEFAULT_WINDOW },
  });
  return buildCoachSnapshot(
    userId,
    { sources, window: scope.window },
    { reach, condenseRequested: true },
  );
}

/**
 * Execute one tool call. `rawArguments` is the model's raw JSON-string
 * arguments (parsed + validated here, never trusted blindly). Returns a
 * grounded `CoachToolResult` — a validation failure or unknown tool resolves
 * to `{ present: false }`, never a throw, so a single bad call can't break the
 * turn.
 */
export async function executeCoachTool(args: {
  userId: string;
  name: string;
  rawArguments: string;
  /** The conversation's effective window, used when a call omits `window`. */
  fallbackWindow?: CoachScopeWindow;
  /**
   * v1.21.0 (D5-1) — the turn's shared full-source snapshot scope (the same one
   * the DATA INVENTORY was built against). When present and the tool's window
   * matches, the tool reads under this scope key so it lands the inventory's
   * already-built cache entry instead of rebuilding a single-source snapshot.
   */
  sharedScope?: CoachScope;
  /**
   * Build a single-metric read from that source's own rows
   * (`source-snapshot.ts`) rather than from a Coach snapshot. Set by the MCP
   * surface, whose reads have no turn snapshot to land on and keep only the
   * one section; the section is the same either way.
   */
  sourceSnapshot?: boolean;
  /** v1.39.4 — the chat turn, when the call runs inside one. */
  turn?: CoachToolTurnContext;
  /**
   * How far back the call may read: the person's Coach lookback limit. Every
   * read below is clamped to it. Absent is no limit, which is what an MCP
   * client gets: it reads with its own window arguments, and the Coach
   * setting governs the Coach.
   */
  reach?: CoachHistoryReach;
}): Promise<CoachToolResult> {
  const {
    userId,
    name,
    rawArguments,
    fallbackWindow,
    sharedScope,
    sourceSnapshot = false,
    turn,
  } = args;
  const reach = args.reach ?? UNBOUNDED_REACH;

  if (!isCoachToolName(name) && name !== SHOW_RESULT_TOOL_NAME) {
    annotate({
      action: { name: "coach.tool.unknown" },
      meta: { tool: name.slice(0, 48) },
    });
    return { present: false, reason: "unknown_tool" };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    annotate({
      action: { name: "coach.tool.bad_arguments" },
      meta: { tool: name, reason: "invalid_json" },
    });
    return { present: false, reason: "invalid_arguments" };
  }

  try {
    const result =
      name === SHOW_RESULT_TOOL_NAME
        ? await showResult(userId, parsedArgs, sharedScope, turn, reach)
        : await dispatch(
            name as CoachToolName,
            userId,
            parsedArgs,
            fallbackWindow,
            sharedScope,
            turn,
            reach,
            sourceSnapshot,
          );
    annotate({
      action: { name: "coach.tool.executed" },
      meta: { tool: name, present: result.present },
    });
    return result;
  } catch (err) {
    // A read failure must degrade to a grounded "no data" rather than break
    // the loop — the model then says it could not retrieve the metric.
    annotate({
      action: { name: "coach.tool.error" },
      meta: {
        tool: name,
        reason: err instanceof Error ? err.name : "unknown",
      },
    });
    return { present: false, reason: "retrieval_failed" };
  }
}

async function dispatch(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
  sourceSnapshot: boolean,
): Promise<CoachToolResult> {
  const result = await dispatchRead(
    name,
    userId,
    rawArgs,
    fallbackWindow,
    sharedScope,
    turn,
    reach,
    sourceSnapshot,
  );
  if (!turn || !result.present || result.table) return result;
  return withProjectedTable(
    name,
    userId,
    rawArgs,
    fallbackWindow,
    result,
    turn,
    reach,
  );
}

async function dispatchRead(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
  sourceSnapshot: boolean,
): Promise<CoachToolResult> {
  // Every branch takes the lookback limit; `coach-history-reach-guard.test.ts`
  // fails when one does not.
  switch (name) {
    case "get_metric_series":
      return getMetricSeries(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        reach,
        sourceSnapshot,
      );
    case "get_glucose_panel":
      return getGlucosePanel(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        reach,
      );
    case "get_sleep":
      return getSleep(userId, rawArgs, fallbackWindow, sharedScope, reach);
    case "get_medication_compliance":
      return getMedicationCompliance(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        reach,
      );
    case "get_labs":
      return getLabs(userId, rawArgs, fallbackWindow, sharedScope, reach);
    case "get_illness_recovery":
      return getIllnessRecovery(userId, fallbackWindow, sharedScope, reach);
    case "get_workouts":
      return getWorkouts(userId, rawArgs, fallbackWindow, sharedScope, reach);
    case "get_cycle":
      return getCycle(userId, rawArgs, sharedScope, reach);
    case "get_correlations":
      return getCorrelations(userId, rawArgs, reach);
    case "get_metric_table":
      return getMetricTable(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        turn,
        reach,
      );
  }
}

function badArgs(name: string, error: z.ZodError): CoachToolResult {
  annotate({
    action: { name: "coach.tool.bad_arguments" },
    meta: { tool: name, reason: "schema", issues: error.issues.length },
  });
  return { present: false, reason: "invalid_arguments" };
}

/**
 * The one exit for "the window read produced no section". Never returns a bare
 * `no_data` without the probe having confirmed the record is empty — see
 * `availability.ts` for the four states it can resolve to.
 */
function emptyRead(
  userId: string,
  domain: string,
  subject: CoachAvailabilitySubject | null,
  searchedWindow: CoachScopeWindow | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  return resolveEmptyRead({ userId, domain, subject, searchedWindow, reach });
}

async function getMetricSeries(
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
  "A 'condensed' list names what was cut to fit, and 'summary' holds first, last, min, max, mean and change over every point. " +
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

async function getGlucosePanel(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getGlucosePanelArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_glucose_panel", parsed.error);
  const snapshot = await readToolSnapshot(
    userId,
    ["glucose"],
    ["glucose"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const section = pickSection(snapshot.sections, "glucose");
  if (section === undefined) {
    return emptyRead(
      userId,
      "glucose",
      subjectForTool("get_glucose_panel"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: section,
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getSleep(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getSleepArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_sleep", parsed.error);
  const snapshot = await readToolSnapshot(
    userId,
    ["sleep"],
    ["sleep", "sleepRhythm"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const nights = pickSection(snapshot.sections, "sleep");
  const rhythm = pickSection(snapshot.sections, "sleepRhythm");
  if (nights === undefined && rhythm === undefined) {
    return emptyRead(
      userId,
      "sleep",
      subjectForTool("get_sleep"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: {
      ...(nights !== undefined ? { nights } : {}),
      ...(rhythm !== undefined ? { rhythm } : {}),
    },
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getMedicationCompliance(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getMedicationComplianceArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return badArgs("get_medication_compliance", parsed.error);
  }
  const snapshot = await readToolSnapshot(
    userId,
    ["compliance"],
    ["compliance", "weeklyContext"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const compliance = pickSection(snapshot.sections, "compliance");
  // GLP-1 context rides the `weeklyContext` block.
  const weeklyContext = pickSection(snapshot.sections, "weeklyContext") as
    { glp1?: unknown } | undefined;
  const glp1 = weeklyContext?.glp1;
  if (compliance === undefined && glp1 === undefined) {
    return emptyRead(
      userId,
      "compliance",
      subjectForTool("get_medication_compliance"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: {
      ...(compliance !== undefined ? { compliance } : {}),
      ...(glp1 !== undefined ? { glp1 } : {}),
    },
  };
}

async function getLabs(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getLabsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_labs", parsed.error);
  // Labs ride the snapshot regardless of `sources` (attached unconditionally),
  // so a minimal scope still surfaces them.
  //
  // v1.21.0 (A5-F4) — the labs block itself is a "latest reading per biomarker
  // over the last 12 months" snapshot and is intentionally window-AGNOSTIC
  // (the read cutoff is fixed). We still thread the conversation's window onto
  // the scope so the snapshot's `scope` block reports the right horizon for the
  // turn; it does not move the labs read.
  //
  // v1.21.0 (D5-1) — prefer the turn's shared full-source scope so this read
  // lands the inventory's cache entry; fall back to a tight empty-source scope
  // (labs ride unconditionally) when no shared scope or a window mismatch.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor([], fallbackWindow, fallbackWindow, sharedScope, reach),
    { reach },
  );
  const labs = pickSection(snapshot.sections, "labs") as
    { recent?: Array<{ name?: string; analyte?: string }> } | undefined;
  if (labs === undefined) {
    // The labs read is window-AGNOSTIC: a fixed trailing-12-month cutoff. So the
    // window it "searched" is a year regardless of the conversation's scope —
    // a panel from 2023 is outside it and must not read as "no labs on file".
    // Under a shorter lookback limit the labs read stops at the limit.
    return emptyRead(
      userId,
      "labs",
      subjectForTool("get_labs"),
      clampWindow("lastYear", reach),
      reach,
    );
  }

  const analyte = parsed.data.analyte?.trim().toLowerCase();
  if (analyte && Array.isArray(labs.recent)) {
    const filtered = labs.recent.filter((entry) => {
      const haystack =
        `${entry.name ?? ""} ${entry.analyte ?? ""}`.toLowerCase();
      return haystack.includes(analyte);
    });
    if (filtered.length === 0) {
      return { present: false, reason: "analyte_not_found" };
    }
    return { present: true, data: { recent: filtered } };
  }
  return { present: true, data: labs };
}

async function getIllnessRecovery(
  userId: string,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  // Validate the (empty) args shape for consistency; an empty object always
  // passes.
  getIllnessRecoveryArgsSchema.parse({});
  // Recovery composites gate on the `recovery` module + the HRV/RHR/VO2max
  // sources; request them so the derived / dayStrain / trajectory blocks can
  // build when the module is on. Illness rides the snapshot unconditionally.
  //
  // v1.21.0 (A5-F4) — honour the conversation's window so the recovery/strain/
  // trajectory composites are computed over the horizon the caller asked for
  // rather than the builder default.
  //
  // v1.21.0 (D5-1) — prefer the turn's shared full-source scope (which already
  // carries hrv/resting_hr/vo2_max + illness + derived) so this read lands the
  // inventory's cache entry; the narrow scope is the window-mismatch fallback.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(
      ["hrv", "resting_hr", "vo2_max"],
      fallbackWindow,
      fallbackWindow,
      sharedScope,
      reach,
    ),
    { reach },
  );
  const illness = pickSection(snapshot.sections, "illness");
  const derived = pickSection(snapshot.sections, "derived");
  const dayStrain = pickSection(snapshot.sections, "dayStrain");
  const trajectory = pickSection(snapshot.sections, "trajectory");
  // v1.21.0 (NEW-B B-2) — the computed illness retrospective the card shows
  // (recovery-gap, gap-driver, nadir, pre-onset, red flags) for the most
  // relevant episode. Read-only, coverage-gated (null when the engine
  // withholds), and the SAME engine the card + the red-flag notifier run, so
  // the Coach restates the numbers the user sees rather than the composite.
  const illnessScores = await buildIllnessScores(userId, undefined, reach);
  if (
    illness === undefined &&
    derived === undefined &&
    dayStrain === undefined &&
    trajectory === undefined &&
    illnessScores === null
  ) {
    // No row-backed subject: illness episodes + the recovery composites are
    // computed / module-gated, not a window slice of one table, so there is
    // nothing an availability probe could establish. Honest absence, unless
    // a lookback limit is what hid the episodes.
    if (isBounded(reach) && (await illnessBeyondReach(userId, reach))) {
      return { present: false, reason: OUTSIDE_REACH_REASON };
    }
    return emptyRead(
      userId,
      "illness_recovery",
      subjectForTool("get_illness_recovery"),
      limitWindow(fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: {
      ...(illness !== undefined ? { illness } : {}),
      ...(illnessScores !== null ? { illnessScores } : {}),
      ...(derived !== undefined ? { derived } : {}),
      ...(dayStrain !== undefined ? { dayStrain } : {}),
      ...(trajectory !== undefined ? { trajectory } : {}),
    },
  };
}

async function getWorkouts(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getWorkoutsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_workouts", parsed.error);
  // The workouts block builds when the `workouts` cluster is active AND the
  // user has workout rows in the window. Scope the read to that single source.
  const snapshot = await readToolSnapshot(
    userId,
    ["workouts"],
    ["workouts"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const workouts = pickSection(snapshot.sections, "workouts");
  if (workouts === undefined) {
    return emptyRead(
      userId,
      "workouts",
      subjectForTool("get_workouts"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return { present: true, data: workouts };
}

async function getCycle(
  userId: string,
  rawArgs: unknown,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getCycleArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_cycle", parsed.error);
  // The cycle block predicts from every logged cycle, so the snapshot leaves
  // it out under any lookback limit. Say why, rather than that it is absent.
  if (isBounded(reach)) {
    return (await isCycleAvailableForUser(userId)) &&
      (await cycleRecorded(userId))
      ? { present: false, reason: OUTSIDE_REACH_REASON }
      : { present: false, reason: "no_data" };
  }
  // The cycle block is gated INSIDE the builder by `isCycleAvailableForUser`
  // (the per-user toggle AND the operator switch), independent of `sources` —
  // so a minimal scope still surfaces it when the account tracks cycles, and a
  // non-cycle account structurally produces no block (→ present:false).
  //
  // v1.21.0 (D5-1) — prefer the turn's shared full-source scope so this read
  // lands the inventory's cache entry; the empty-source scope is the fallback
  // when no shared scope is threaded.
  const snapshot = await buildCoachSnapshot(
    userId,
    sharedScope ?? { sources: [] },
    { reach },
  );
  const cycle = pickSection(snapshot.sections, "cycle");
  if (cycle === undefined) {
    // No row-backed subject: the cycle block is gated by the per-user toggle
    // AND the operator switch inside the builder, so an absent block is a gate
    // verdict rather than a window artefact.
    return emptyRead(
      userId,
      "cycle",
      subjectForTool("get_cycle"),
      sharedScope?.window,
      reach,
    );
  }
  return { present: true, data: cycle };
}

async function getCorrelations(
  userId: string,
  rawArgs: unknown,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getCorrelationsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_correlations", parsed.error);
  // Reads the deterministic FDR discovery + coincident-deviation flag; returns
  // a clean `{ present: false }` when too little paired data exists.
  //
  // No availability probe here, and no window either: a discovered pattern is
  // not a slice of one table — it needs two channels paired over overlapping
  // days, and the reader already reports WHY nothing survived (its own reason
  // code). "No pattern survived the correction" is an honest absence of a
  // finding, not an absence of data, and nothing older would change it.
  // The reader's language, from their stored preference — the executor is
  // reached from the chat loop and from MCP, neither of which carries a request
  // of its own. The notes below are finished sentences; some MCP clients show
  // them to the person verbatim rather than letting the model re-word them.
  const locale = await resolveLocaleForUser(userId);
  // The scan reads 180 days, or the lookback limit when that is shorter.
  const result = await readCoachCorrelations(userId, locale, { reach });
  if (!result.present) {
    return { present: false, reason: result.reason ?? "no_pattern" };
  }
  return {
    present: true,
    data: {
      ...(result.drivers ? { drivers: result.drivers } : {}),
      ...(result.coincident ? { coincident: result.coincident } : {}),
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    },
  };
}

// ── v1.39.4: result tables ──────────────────────────────────────────────

/**
 * True when the snapshot builder admitted `metric` for this account: the
 * resolved scope it pins on every snapshot is the source set left after the
 * module switches and the person's own exclusions. The table tool reads
 * rows the builder does not, so it asks the builder's gate first rather
 * than keeping a second copy of it.
 */
export function scopeAdmits(
  sections: Record<string, unknown>,
  metric: CoachScopeSource,
): boolean {
  const scope = sections.scope as { sources?: unknown } | undefined;
  return Array.isArray(scope?.sources) && scope.sources.includes(metric);
}

/**
 * The earlier tables a turn may name and show again: those whose metric the
 * same gate would read now. With a conversation scope that is the scope's
 * sources less the person's exclusions and switched-off modules; without
 * one, every metric not excluded. The exclusion is the snapshot's own
 * (`coachExclusions`, `admitCoachSources`), so a metric the person excluded
 * after a table was stored is neither listed for the model nor sent to it.
 * Tables of other domains (labs) answer to their module when read.
 *
 * The lookback limit applies the same way: a table whose range reaches past
 * it (stored before the limit was set or narrowed) is not listed, because
 * its line hands the model the window and the row count of history the
 * Coach may no longer read. `show_result` refuses it on the same test.
 */
export async function admittedPriorResults(args: {
  userId: string;
  prefs: Pick<CoachPrefs, "excludeMetrics">;
  scope: CoachScope | undefined;
  reach: CoachHistoryReach;
  prior: readonly PriorResultTurn[];
}): Promise<PriorResultTurn[]> {
  if (args.prior.length === 0) return [];
  const excluded = coachExclusions(
    args.prefs,
    await resolveModuleMap(args.userId),
  );
  const scoped =
    args.scope?.sources && args.scope.sources.length > 0
      ? admitCoachSources(args.scope.sources, excluded)
      : null;
  const admits = (domain: CoachStepDomain) =>
    !isCoachScopeSource(domain) ||
    (scoped
      ? scoped.has(domain)
      : admitCoachSources([domain], excluded).size > 0);
  return args.prior
    .map((turn) => ({
      ...turn,
      results: turn.results.filter(
        (meta) =>
          admits(meta.source.domain) &&
          tableRangeWithinReach(
            meta.source.window,
            meta.source.period ?? "current",
            args.reach,
          ),
      ),
    }))
    .filter((turn) => turn.results.length > 0);
}

/** True for a step domain the snapshot scope gates (a metric, not labs). */
export function isCoachScopeSource(
  domain: CoachStepDomain,
): domain is CoachScopeSource {
  return Object.hasOwn(COACH_SOURCE_MEASUREMENT_TYPES, domain);
}

/**
 * True when a table's whole range lies inside the lookback limit. An earlier
 * period needs twice its window (previous) or a year more (a year ago), so a
 * range either fits with room to spare or does not fit at all; the UTC day
 * edges are close enough.
 */
export function tableRangeWithinReach(
  window: CoachScopeWindow,
  period: CoachResultPeriod,
  reach: CoachHistoryReach,
  now: Date = new Date(),
): boolean {
  if (!isBounded(reach)) return true;
  if (exceedsReach(window, reach)) return false;
  const range = resolveTableRange({ window, period, timeZone: "UTC", now });
  return withinReach(range.from, reach, now);
}

async function getMetricTable(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getMetricTableArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_metric_table", parsed.error);
  const { metric, granularity } = parsed.data;
  // All time becomes the lookback limit; a narrower window stays.
  const window = clampWindow(
    parsed.data.window ?? fallbackWindow ?? DEFAULT_WINDOW,
    reach,
  );
  const period =
    window === "allTime" ? "current" : (parsed.data.period ?? "current");

  const excluded = METRIC_TABLE_EXCLUDED_SOURCES[metric];
  if (excluded) return { present: false, reason: excluded };

  // An earlier period is read only when all of it lies inside the limit: the
  // previous window or the same window a year ago, cut short, would be a
  // different comparison under the same name.
  if (
    period !== "current" &&
    !tableRangeWithinReach(window, period, reach, turn?.now)
  ) {
    return {
      present: false,
      reason: OUTSIDE_REACH_REASON,
      searchedWindow: window,
    };
  }

  // Same gate as every other read: a module switched off, or a metric the
  // person excluded from the Coach, is not read here either.
  const gate = await buildCoachSnapshot(
    userId,
    sharedScope ?? {
      sources: [metric],
      window: limitWindow(fallbackWindow, reach),
    },
    { reach },
  );
  if (!scopeAdmits(gate.sections, metric)) {
    return {
      present: false,
      reason: "unavailable_in_scope",
      searchedWindow: window,
    };
  }

  const timeZone = await resolveUserTimezone(userId);
  const table = await readMetricTable({
    userId,
    metric,
    window,
    period,
    granularity,
    timeZone,
    locale: turn?.locale ?? "en",
    ref: "r0",
    units: gate.units,
    now: turn?.now,
  });
  if (!table) {
    return emptyRead(
      userId,
      metric,
      subjectForTool("get_metric_table", metric),
      window,
      reach,
    );
  }
  // An earlier window is read to be compared: read the current one too and
  // hand the model both, and the change between them, in one summary.
  let comparison: Record<string, unknown> | null = null;
  if (period !== "current") {
    const current = await readMetricTable({
      userId,
      metric,
      window,
      period: "current",
      granularity,
      timeZone,
      locale: turn?.locale ?? "en",
      ref: "r0",
      units: gate.units,
      now: turn?.now,
    });
    comparison = current ? compareWithCurrent(table, current) : null;
  }
  const summarise = (t: CoachResultTable) => ({
    ...summariseTable(t),
    ...(comparison ? { comparison } : {}),
  });
  const ref = turn?.refs.next() ?? null;
  if (!ref) {
    // Outside a chat turn, or past the sixth table: the model still gets
    // the figures, there is just no table to name.
    return { present: true, data: summarise(table) };
  }
  const named = { ...table, ref };
  return {
    present: true,
    resultRef: ref,
    data: summarise(named),
    table: named,
  };
}

/**
 * A table shown again, with the chart its `view` asks for. No view: the chart
 * the server picks for any table. `table`: no chart. `chart`: a day table
 * becomes how often each range came up (a histogram); any other table, or a
 * day table with too few values, keeps the chart the server picks. The model
 * then reads the summary of what is shown.
 */
function withResultView(
  shown: CoachResultTable,
  view: "table" | "chart" | undefined,
  locale: Locale,
): CoachResultTable {
  // The view is this showing's alone, never the stored copy's.
  const { view: _stored, ...table } = shown;
  if (view === "table") {
    // The table shows first; the chart stays for the toggle and the chip
    // back to it.
    const chart = deriveChartSpec(table);
    return chart
      ? { ...table, chart, chartKind: chart.kind, view: "table" }
      : { ...table, chart: null, chartKind: null };
  }
  if (view === "chart") {
    const { t } = getServerTranslator(locale);
    const distribution = buildDistributionTable(table, {
      localeTag: resolveIntlLocale(locale),
      title: t(COACH_RESULT_TITLE_KEYS.distribution, {
        metric: t(coachDomainLabelKey(table.source.domain)),
      }),
      range: t(COACH_RESULT_COLUMN_KEYS.range),
      count: t(COACH_RESULT_COLUMN_KEYS.count),
      bin: (from, to, unit) =>
        t(COACH_RESULT_UI_KEYS.histogramBin, { from, to, unit }),
    });
    if (distribution) return distribution;
  }
  const chart = deriveChartSpec(table);
  return { ...table, chart, chartKind: chart?.kind ?? null };
}

/**
 * `show_result` — an earlier table of THIS conversation, shown again. The
 * name resolves only against the tables the turn's own conversation holds
 * (`turn.priorResults`), and the values come through the owner- and
 * conversation-narrowed read, so a name from anywhere else is an unknown
 * result, never a lookup.
 */
async function showResult(
  userId: string,
  rawArgs: unknown,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = showResultArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs(SHOW_RESULT_TOOL_NAME, parsed.error);
  const target = turn
    ? resolvePriorResultRef(parsed.data.ref, turn.priorResults)
    : null;
  if (!turn || !target) {
    annotate({
      action: { name: "coach.result.unknown_ref" },
      meta: { inTurn: turn !== undefined },
    });
    return { present: false, reason: "unknown_result" };
  }

  // A stored table whose range reaches past the lookback limit set since is
  // not shown again: the limit covers what the Coach shows as much as what
  // it reads.
  const { window: storedWindow, period: storedPeriod } = target.meta.source;
  if (
    storedWindow !== undefined &&
    !tableRangeWithinReach(
      storedWindow,
      storedPeriod ?? "current",
      reach,
      turn.now,
    )
  ) {
    return { present: false, reason: OUTSIDE_REACH_REASON };
  }

  // The same gate a fresh read passes, before anything is decrypted: a
  // metric the person has since excluded from the Coach, or left out of
  // this conversation's scope, is not sent to the model again either.
  const domain = target.meta.source.domain;
  if (isCoachScopeSource(domain)) {
    const gate = await buildCoachSnapshot(
      userId,
      sharedScope ?? {
        sources: [domain],
        window: limitWindow(target.meta.source.window, reach),
      },
      { reach },
    );
    if (!scopeAdmits(gate.sections, domain)) {
      return { present: false, reason: "unavailable_in_scope" };
    }
  }

  const modules = await resolveModuleMap(userId);
  const entries = await readMessageResults(
    userId,
    turn.conversationId,
    target.messageId,
    (domain) => isCoachDomainWithheld(domain, modules),
  );
  const entry = entries?.find((candidate) => candidate.ref === target.ref);
  if (!entry) return { present: false, reason: "unknown_result" };
  if ("withheld" in entry) {
    return {
      present: false,
      reason:
        entry.withheld === "module_disabled"
          ? "module_disabled"
          : "result_unavailable",
    };
  }
  const ref = turn.refs.next();
  if (!ref) return { present: false, reason: "result_limit" };
  const table = withResultView(
    {
      ...entry,
      ref,
      displayed: false,
      reusedFrom: { messageId: target.messageId, ref: target.ref },
    },
    parsed.data.view,
    turn.locale,
  );
  return {
    present: true,
    resultRef: ref,
    data: {
      shownAgain: formatPriorResultRef(
        turn.priorResults.find((p) => p.messageId === target.messageId)
          ?.turnIndex ?? 0,
        target.ref,
      ),
      ...summariseTable(table),
    },
    table,
  };
}

/**
 * The table an older tool's present result projects to, named with the
 * turn's next ref. A projection that fails leaves the answer as it was: the
 * table is a view of the result, never a condition for it.
 */
async function withProjectedTable(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  result: CoachToolResult,
  turn: CoachToolTurnContext,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const argWindow =
    rawArgs !== null &&
    typeof rawArgs === "object" &&
    typeof (rawArgs as { window?: unknown }).window === "string"
      ? ((rawArgs as { window: CoachScopeWindow }).window as CoachScopeWindow)
      : undefined;
  const window = clampWindow(
    argWindow ?? fallbackWindow ?? DEFAULT_WINDOW,
    reach,
  );
  try {
    let table: CoachResultTable | null = null;
    switch (name) {
      case "get_workouts":
        table = projectWorkouts(result.data, {
          ref: "r0",
          locale: turn.locale,
          window,
          timeZone: "UTC",
        });
        break;
      case "get_medication_compliance":
        table = projectCompliance(result.data, {
          ref: "r0",
          locale: turn.locale,
          window,
          timeZone: "UTC",
        });
        break;
      case "get_labs":
        table = projectLabs(result.data, {
          ref: "r0",
          locale: turn.locale,
          window,
          timeZone: await resolveUserTimezone(userId),
        });
        break;
      case "get_sleep": {
        const read = await readMetricTable({
          userId,
          metric: "sleep",
          window,
          period: "current",
          granularity: "day",
          timeZone: await resolveUserTimezone(userId),
          locale: turn.locale,
          ref: "r0",
          // Sleep is read in minutes for every reader; no preference applies.
          units: DEFAULT_UNIT_PREFERENCES,
          now: turn.now,
        });
        table =
          read && read.source.granularity === "day"
            ? {
                ...read,
                source: { ...read.source, tool: "get_sleep" },
                titleKey: COACH_RESULT_TITLE_KEYS.sleepByNight,
                title: getServerTranslator(turn.locale).t(
                  COACH_RESULT_TITLE_KEYS.sleepByNight,
                ),
              }
            : read && {
                ...read,
                source: { ...read.source, tool: "get_sleep" },
              };
        break;
      }
      default:
        return result;
    }
    if (!table) return result;
    const ref = turn.refs.next();
    if (!ref) return result;
    return { ...result, resultRef: ref, table: { ...table, ref } };
  } catch (err) {
    annotate({
      action: { name: "coach.result.projection_failed" },
      meta: {
        tool: name,
        reason: err instanceof Error ? err.name : "unknown",
      },
    });
    return result;
  }
}
