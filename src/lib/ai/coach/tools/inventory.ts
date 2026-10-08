/**
 * v1.20.0 (F1) — Coach DATA INVENTORY manifest.
 *
 * The tiny, always-sent manifest that replaces snapshot-stuffing in the base
 * context. It tells the model WHAT data exists (so it never invents a metric)
 * and WHICH tool to call to fetch it — without shipping the figures themselves.
 *
 * Built deterministically from a single `buildCoachSnapshot` over the user's
 * effective scope: the snapshot already resolves the module / cycle gates and
 * computes presence + counts, so a domain the user opted out of is structurally
 * absent from the manifest (it will report `present: false`). The build is
 * memoised by the 60s snapshot LRU, so the tools that fire on the same turn
 * re-use these reads rather than paying for them twice.
 *
 * Cost: the manifest is ~0.3–0.5k tokens vs the ~6–15k-token snapshot JSON it
 * replaces — the figures move out of the prompt and into on-demand tool results.
 */
import { annotate } from "@/lib/logging/context";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import type {
  CoachProvenanceMetric,
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
} from "@/lib/ai/coach/types";
import {
  COACH_SOURCE_SNAPSHOT_KEY,
  COACH_SOURCE_DOMAIN_LABEL,
  METRIC_SERIES_INVENTORY_SOURCES,
  FULL_INVENTORY_SOURCE_SET,
} from "./source-keys";
import {
  OUTSIDE_REACH_REASON,
  classifyAvailability,
  probeBeyondReach,
  probeCoachAvailability,
  subjectForTool,
  type CoachAvailabilitySubject,
  type CoachDomainAvailability,
} from "./availability";
import { isCoachToolName } from "./definitions";
import {
  UNBOUNDED_REACH,
  clampWindow,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";

/**
 * What the record holds for a domain the WINDOW read found nothing for. Absent
 * on a present row and on a genuinely empty domain; set only when rows exist
 * that this window could not reach. Model-facing only — no i18n.
 */
export interface InventoryAvailability {
  /**
   * `outside_window`, `unavailable_in_scope` or `outside_reach` — see
   * `availability.ts`. An `outside_reach` row carries no figures at all.
   */
  state: string;
  count?: number;
  firstDate?: string;
  lastDate?: string;
  /** A window the model may re-call with to reach the rows, or null. */
  reachableWithWindow: string | null;
}

/** One row of the inventory: a domain + whether the user has data for it. */
export interface InventoryEntry {
  /** The tool that fetches this domain. */
  tool: string;
  /** Stable domain label the model reads (e.g. "blood pressure", "glucose"). */
  domain: string;
  present: boolean;
  /** Sample count, when the snapshot reported one. */
  count?: number;
  /** For get_metric_series rows: the `metric` argument to pass. */
  metric?: string;
  /**
   * Set when `present` is false and the record nevertheless holds rows for this
   * domain. Without it a history the window cannot reach is indistinguishable
   * from a metric that was never recorded, and the model is told to move on from
   * a topic the record can answer.
   */
  availability?: InventoryAvailability;
}

export interface CoachDataInventory {
  entries: InventoryEntry[];
  /** Illness rest-mode flag, so the safety framing is right before any call. */
  restMode: boolean;
  /** Whether cycle tracking is available (fetched via get_cycle). */
  cycleEnabled: boolean;
  /** The window the inventory was built against. */
  window: string;
  /** The person's lookback limit, or undefined when there is none. */
  lookbackLimit?: string;
  /**
   * v1.21.0 (D5-1) — the exact full-source scope this inventory's snapshot was
   * built against. The route threads it to the tool loop so every per-tool read
   * lands the SAME 60s LRU entry (one snapshot build per turn, not N). Returned
   * here so the route reuses the identical scope object rather than
   * re-deriving it and risking a key mismatch.
   */
  probeScope: CoachScope;
}

/**
 * v1.21.0 (C2-2 / C2-3) — generate the get_metric_series inventory rows from
 * the FULL source→key map rather than the eight legacy clusters. Every series
 * the user actually has rows for is advertised, so the model is no longer told
 * (rule 2) to skip body-composition / vascular / SpO2 / gait / environment.
 * The `provenance` count key equals the source name for these series sources.
 */
const METRIC_SERIES_DOMAINS: Array<{
  sectionKey: string;
  metric: CoachScopeSource;
  domain: string;
  provenance: CoachProvenanceMetric;
}> = METRIC_SERIES_INVENTORY_SOURCES.map((metric) => ({
  sectionKey: COACH_SOURCE_SNAPSHOT_KEY[metric] as string,
  metric,
  domain: COACH_SOURCE_DOMAIN_LABEL[metric] ?? (metric as string),
  provenance: metric as unknown as CoachProvenanceMetric,
}));

export async function buildCoachDataInventory(
  userId: string,
  scope: CoachScope | undefined,
  /** The person's lookback limit; the probe and every row answer to it. */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<CoachDataInventory> {
  // v1.21.0 (C2-2) — probe presence against the FULL source set, not the
  // user's narration-cluster default. `effectiveScope` only carried the
  // window; expanding `sources` here makes the snapshot build every domain the
  // user has rows for, so sleep / glucose / activity / body-composition / etc.
  // no longer report `absent` for a default-prefs user. Each per-tool read
  // still re-scopes to its own domain, so this presence probe never widens a
  // figure read — it only widens what the inventory advertises.
  const probeScope: CoachScope = {
    sources: [...FULL_INVENTORY_SOURCE_SET],
    window:
      scope?.window === undefined
        ? undefined
        : clampWindow(scope.window, reach),
  };
  const [snapshot, cycleEnabled, environment] = await Promise.all([
    buildCoachSnapshot(userId, probeScope, { reach }),
    isCycleAvailableForUser(userId),
    probeEnvironment(userId),
  ]);
  const sections = snapshot.sections;
  const counts = snapshot.provenance.counts ?? {};
  const has = (key: string): boolean =>
    sections[key] !== undefined && sections[key] !== null;

  const entries: InventoryEntry[] = [];

  // get_metric_series domains — one row per metric the snapshot surfaced.
  for (const m of METRIC_SERIES_DOMAINS) {
    const present = has(m.sectionKey);
    entries.push({
      tool: "get_metric_series",
      metric: m.metric,
      domain: m.domain,
      present,
      ...(present && typeof counts[m.provenance] === "number"
        ? { count: counts[m.provenance] }
        : {}),
    });
  }

  // Dedicated-tool domains.
  entries.push({
    tool: "get_glucose_panel",
    domain: "glucose",
    present: has("glucose"),
    ...(typeof counts.glucose === "number" ? { count: counts.glucose } : {}),
  });
  entries.push({
    tool: "get_sleep",
    domain: "sleep",
    present: has("sleep") || has("sleepRhythm"),
    ...(typeof counts.sleep === "number" ? { count: counts.sleep } : {}),
  });
  entries.push({
    tool: "get_medication_compliance",
    domain: "medication compliance",
    present: has("compliance") || has("weeklyContext"),
    ...(typeof counts.compliance === "number"
      ? { count: counts.compliance }
      : {}),
  });
  // v1.21.0 (C2-4) — workouts has its own tool now (get_metric_series refuses
  // it). The block builds when the user has workout rows + the cluster is on.
  entries.push({
    tool: "get_workouts",
    domain: "workouts & training",
    present: has("workouts"),
    ...(typeof counts.workouts === "number" ? { count: counts.workouts } : {}),
  });
  entries.push({
    tool: "get_labs",
    domain: "lab results",
    present: has("labs"),
  });
  entries.push({
    tool: "get_illness_recovery",
    domain: "illness & recovery",
    present:
      has("illness") || has("derived") || has("dayStrain") || has("trajectory"),
  });
  // v1.21.0 (C3) — discovered cross-metric correlations (FDR-controlled lagged
  // drivers) + the coincident-deviation flag. Advertised when the user has any
  // two discovery channels with data; the tool itself returns present:false
  // cleanly when nothing survives, so the inventory marks it present whenever a
  // correlatable signal exists (mood / cardio / activity).
  entries.push({
    tool: "get_correlations",
    domain: "cross-metric patterns (discovered drivers)",
    present:
      has("derived") ||
      has("mood") ||
      has("heartRateVariability") ||
      has("restingHeartRate") ||
      has("steps") ||
      has("sleep"),
  });
  // v1.21.0 (C2-1) — cycle is fetchable via get_cycle when cycle tracking is
  // available for this account (per-user toggle AND operator switch).
  if (cycleEnabled) {
    entries.push({
      tool: "get_cycle",
      domain: "menstrual cycle & phase",
      present: has("cycle"),
    });
  }

  // v1.42 (#615) — the stored days' weather and air quality, advertised only
  // while the environment module is on (off, the domain does not exist for
  // the Coach, like the cycle above).
  if (environment !== null) {
    entries.push({
      tool: "get_environment",
      domain: "weather, air quality & pollen (modelled, not personal exposure)",
      present: environment,
    });
  }

  // v1.42 (#613) — one day across the record, by date. Always offered: the
  // tool answers no_data itself for a day that holds nothing.
  entries.push({
    tool: "get_day",
    domain: "one day across the record, by date (YYYY-MM-DD)",
    present: true,
  });

  // Every row that came back absent gets checked against the record before the
  // manifest says "absent". A domain whose whole history predates the window —
  // an imported year of readings, a device that stopped syncing — is otherwise
  // advertised as if it had never been recorded, and rule 2 then tells the model
  // not to fetch it at all. That is the reported defect: the tool never even
  // runs, so nothing downstream can recover the distinction.
  await attachAvailability(userId, entries, probeScope.window, reach);

  // restMode rides the illness section.
  const illness = sections.illness as { restMode?: boolean } | undefined;
  const restMode = illness?.restMode === true;

  const scopeBlock = sections.scope as { window?: string } | undefined;

  return {
    entries,
    restMode,
    cycleEnabled,
    window: scopeBlock?.window ?? scope?.window ?? "last30days",
    ...(reach.days !== null ? { lookbackLimit: reach.window } : {}),
    probeScope,
  };
}

/**
 * Whether the account's environment days exist: null when the module is off
 * or the probe failed (the row is left out), else whether any day is stored.
 * One indexed probe.
 */
async function probeEnvironment(userId: string): Promise<boolean | null> {
  try {
    if (!(await isModuleEnabled(userId, "environment"))) return null;
    const row = await prisma.environmentContext.findFirst({
      where: { userId },
      select: { date: true },
    });
    return row !== null;
  } catch (err) {
    // The manifest is advisory: a failed probe leaves the row out (the tool
    // itself still answers), and says so on the request's event.
    annotate({
      action: { name: "coach.inventory.environment_failed" },
      meta: { reason: err instanceof Error ? err.name : "unknown" },
    });
    return null;
  }
}

/**
 * Fill `entry.availability` for every absent row the record actually holds rows
 * for. One batched probe: a single grouped aggregate over `Measurement` for the
 * union of the absent measurement-backed domains, plus at most one `aggregate()`
 * per other table asked for. Runs after the snapshot, so a domain that DID
 * report data is never probed.
 *
 * A probe failure leaves every `availability` unset — which reads as "absent",
 * the pre-existing behaviour — so an unavailable probe degrades the manifest's
 * precision and never its correctness. The per-tool result path is the one that
 * must distinguish an unconfirmed absence, and it does (`no_data_unconfirmed`).
 */
async function attachAvailability(
  userId: string,
  entries: InventoryEntry[],
  window: CoachScopeWindow | undefined,
  reach: CoachHistoryReach,
): Promise<void> {
  const subjects = new Map<string, CoachAvailabilitySubject>();
  const keyed = new Map<string, InventoryEntry>();
  for (const entry of entries) {
    if (entry.present) continue;
    if (!isCoachToolName(entry.tool)) continue;
    const subject = subjectForTool(
      entry.tool,
      entry.metric as CoachScopeSource | undefined,
    );
    if (subject === null) continue;
    const key = `${entry.tool}:${entry.metric ?? entry.domain}`;
    subjects.set(key, subject);
    keyed.set(key, entry);
  }
  if (subjects.size === 0) return;
  let probed: Map<string, CoachDomainAvailability>;
  let beyond: Set<string>;
  try {
    probed = await probeCoachAvailability(userId, subjects, { reach });
    // Under a limit, a domain with nothing inside it may still hold rows
    // older than it. Those are named as beyond the limit, with no figures.
    const unprobed = new Map([...subjects].filter(([key]) => !probed.has(key)));
    beyond = await probeBeyondReach(userId, unprobed, reach);
  } catch (err) {
    // The manifest degrades to the pre-fix precision (every unreached domain
    // reads "absent"), which is why this is a catch and not a throw — but a
    // silent one would be the very class of failure this change exists to end.
    const reason = err instanceof Error ? err.name : "unknown";
    annotate({
      action: { name: "coach.inventory.availability_failed" },
      meta: { probed: subjects.size, reason },
    });
    return;
  }
  annotate({
    action: { name: "coach.inventory.availability" },
    meta: { probed: subjects.size, stored: probed.size },
  });
  for (const key of beyond) {
    const entry = keyed.get(key);
    if (!entry) continue;
    entry.availability = {
      state: OUTSIDE_REACH_REASON,
      reachableWithWindow: null,
    };
  }
  for (const [key, available] of probed) {
    const entry = keyed.get(key);
    if (!entry) continue;
    entry.availability = {
      state: classifyAvailability(available, window),
      count: available.count,
      firstDate: available.firstDate,
      lastDate: available.lastDate,
      reachableWithWindow: available.reachableWithWindow,
    };
  }
}

/**
 * v1.21.0 (D1) — render the launch FOCUS hint for the tool-mode user turn.
 *
 * When the Coach is opened from a metric page or card, the client sends
 * `scope.sources` (the metric the user is looking at). The no-tools path
 * narrows the snapshot to those sources, but the tool-mode inventory probes the
 * FULL source set, so without this hint the metric-narrowing was silently
 * dropped server-side (D1 — the only surviving signals were the window + seed
 * question). This injects a single `FOCUS:` line naming the launched domain(s)
 * so the model prioritises the metric the user actually opened the Coach about,
 * while every other domain stays fetchable (the user can still pivot).
 *
 * Returns `""` when no explicit sources were pinned (a generic open), so the
 * prompt prefix is byte-identical to before on the non-scoped path.
 */
export function renderFocusHint(
  sources: readonly CoachScopeSource[] | undefined,
): string {
  if (!sources || sources.length === 0) return "";
  const labels = sources.map(
    (s) => COACH_SOURCE_DOMAIN_LABEL[s] ?? (s as string),
  );
  // De-dup while preserving order (two sources can share a label only via the
  // fallback, but keep it stable regardless).
  const seen = new Set<string>();
  const unique = labels.filter((l) => {
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  return `FOCUS: the user opened this conversation from ${unique.join(
    ", ",
  )} — prioritise that, fetch its figures first, and only branch to other domains if the question leads there.`;
}

/**
 * Render the inventory as the compact text block that rides the base context.
 * Brand-free, deterministic, and stable across turns so the prompt-cache prefix
 * stays intact. Each line tells the model the domain, whether data exists, and
 * the tool + argument to call.
 */
export function renderDataInventory(inventory: CoachDataInventory): string {
  const lines: string[] = [];
  lines.push("DATA INVENTORY");
  lines.push(
    'This lists which of the user\'s data exists and how to fetch it. Never cite a figure you did not fetch with a tool this turn. Three states per domain: "present" — fetch it with the named tool. "absent" — the record holds nothing for it, ever. "outside window" / "not in scope" — the record DOES hold readings, listed with their count and date range; that is not absence, so never say the user has no data for it, and call its tool anyway (the result reports what the record holds and, when a window would reach it, which one to re-call with).',
  );
  lines.push(`Window: ${inventory.window}.`);
  if (inventory.lookbackLimit) {
    lines.push(
      `Lookback limit: ${inventory.lookbackLimit}. The user set how far back you may read; nothing older reaches you, whatever window a tool is called with. "BEYOND LOOKBACK" marks a domain whose readings are all older than that: do not call its tool, say older readings lie beyond the lookback set in the Coach settings, and name no figures.`,
    );
  }
  if (inventory.restMode) {
    lines.push(
      "The user is currently in REST MODE (recovering from illness) — frame any activity guidance gently.",
    );
  }
  for (const e of inventory.entries) {
    const arg = e.metric ? ` (metric:"${e.metric}")` : "";
    lines.push(
      `- ${e.domain}: ${renderState(e)} → ${e.tool}${arg}${
        e.present && typeof e.count === "number" ? ` [~${e.count} samples]` : ""
      }`,
    );
  }
  return lines.join("\n");
}

/**
 * The state word (or clause) for one inventory row. An absent row whose record
 * is NOT empty renders the count + range it holds, so the manifest can never
 * again advertise a stored history as nothing.
 */
function renderState(entry: InventoryEntry): string {
  if (entry.present) return "present";
  const a = entry.availability;
  if (!a) return "absent";
  if (a.state === OUTSIDE_REACH_REASON) return "BEYOND LOOKBACK";
  // Terse by design: the preamble states once what these two states mean and
  // that neither is absence. Repeating that per row would double a manifest
  // that rides every single turn.
  const range = `${a.count} readings, ${a.firstDate} to ${a.lastDate}`;
  if (a.state === "unavailable_in_scope") {
    return `NOT IN SCOPE [${range}, inside the window — module may be off]`;
  }
  return a.reachableWithWindow
    ? `OUTSIDE WINDOW [${range}, re-call with window:"${a.reachableWithWindow}"]`
    : `OUTSIDE WINDOW [${range}, older than any window reaches]`;
}
