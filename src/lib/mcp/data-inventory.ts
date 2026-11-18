/**
 * The MCP data inventory: which domains the record holds, read from the
 * record itself rather than from a Coach snapshot.
 *
 * `list_metrics`, the `measurements/inventory` resource, `search` and the
 * metric argument completion all answer "what exists". They used to answer
 * it by building the whole Coach snapshot (`buildCoachDataInventory`): every
 * timeline, the all-time figures, the derived scores, the correlations, two
 * hundred statements on a dense account, to learn which sections came back.
 * A host calls these first and often, a completion on every keystroke, and on
 * an account with years of heart rate every few seconds they ran past the
 * client's timeout before returning a list of names.
 *
 * Here each domain is asked only whether it holds rows in the inventory's
 * window, under the same gates the snapshot applies (the module switches and
 * the Coach exclusions, `coachExclusions` / `admitCoachSources`):
 *
 *   - a measurement-backed domain's count is its readings in the window,
 *     exact, from the DAY rollup tier where it matches the record and the
 *     live rows where it does not (`countLiveReadings`), so a dense stream
 *     costs a day of rows and the tier's days, not the stream;
 *   - mood, medication intake and workouts are one count each over their own
 *     tables in the window, labs and cycles one existence probe each;
 *   - illness reads its own small block, which also carries Rest Mode;
 *   - the computed domains (illness and recovery, cross-metric patterns) are
 *     present when the signals they are computed from are, the way the
 *     snapshot gates them.
 *
 * An absent row then goes through the same availability probe the Coach
 * inventory uses (`attachInventoryAvailability`), so a history older than
 * the window is named as such and not as absence. The rows keep the Coach
 * inventory's shape and tools, so a host sees the same manifest it always
 * did; `count` is the readings in the window, every source counted.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { countLiveReadings } from "@/lib/rollups/live-counts";
import { isModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import { admitCoachSources, coachExclusions } from "@/lib/ai/coach/scope-gate";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import {
  COACH_SOURCE_DOMAIN_LABEL,
  FULL_INVENTORY_SOURCE_SET,
  METRIC_SERIES_INVENTORY_SOURCES,
} from "@/lib/ai/coach/tools/source-keys";
import {
  attachInventoryAvailability,
  probeEnvironment,
  type InventoryEntry,
} from "@/lib/ai/coach/tools/inventory";
import { cycleRecorded } from "@/lib/ai/coach/tools/availability";
import { buildIllnessSnapshotBlock } from "@/lib/ai/coach/illness-snapshot";
import { DEFAULT_WINDOW } from "@/lib/ai/coach/snapshot-cache";
import { windowToDays } from "@/lib/ai/coach/snapshot-series";
import type { CoachScopeSource } from "@/lib/ai/coach/types";

export interface McpDataInventory {
  entries: InventoryEntry[];
  restMode: boolean;
  cycleEnabled: boolean;
  window: string;
}

/** The measurement types a source reads, for presence and count. */
function countedTypes(source: CoachScopeSource): readonly MeasurementType[] {
  // A blood-pressure reading is a systolic and a diastolic row; the count is
  // of readings, so one side of the pair.
  if (source === "bp") return ["BLOOD_PRESSURE_SYS"];
  return COACH_SOURCE_MEASUREMENT_TYPES[source] ?? [];
}

export async function buildMcpDataInventory(
  userId: string,
  options: {
    /**
     * Resolve what an absent row's history holds. Off for callers that use
     * the present rows only (search, argument completion).
     */
    availability?: boolean;
    now?: Date;
  } = {},
): Promise<McpDataInventory> {
  const now = options.now ?? new Date();
  const window = DEFAULT_WINDOW;
  const since = new Date(now.getTime() - windowToDays(window) * 86_400_000);

  const [moduleMap, prefsRow, cycleEnabled] = await Promise.all([
    resolveModuleMap(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { coachPrefsJson: true },
    }),
    isCycleAvailableForUser(userId),
  ]);
  const excluded = coachExclusions(
    parseCoachPrefs(prefsRow?.coachPrefsJson),
    moduleMap,
  );
  const sources = admitCoachSources(FULL_INVENTORY_SOURCE_SET, excluded);

  const measured = new Set<MeasurementType>();
  for (const source of [
    ...METRIC_SERIES_INVENTORY_SOURCES,
    "glucose" as const,
    "sleep" as const,
  ]) {
    if (!sources.has(source)) continue;
    for (const type of countedTypes(source)) measured.add(type);
  }

  const windowed = { userId, deletedAt: null };
  const [counts, mood, intakes, workouts, labs, cycle, illness, environment] =
    await Promise.all([
      countLiveReadings(userId, [...measured], since, now),
      sources.has("mood")
        ? prisma.moodEntry.count({
            where: { ...windowed, moodLoggedAt: { gte: since } },
          })
        : 0,
      sources.has("compliance")
        ? prisma.medicationIntakeEvent.count({
            where: {
              ...windowed,
              ...TRACKED_INTAKE_EVENT_WHERE,
              scheduledFor: { gte: since, lte: now },
            },
          })
        : 0,
      sources.has("workouts")
        ? prisma.workout.count({ where: { userId, startedAt: { gte: since } } })
        : 0,
      isModuleEnabled(userId, "labs").then((on) =>
        on
          ? prisma.labResult.findFirst({
              where: windowed,
              select: { id: true },
            })
          : null,
      ),
      cycleEnabled ? cycleRecorded(userId) : false,
      buildIllnessSnapshotBlock(userId, now),
      probeEnvironment(userId),
    ]);

  const sourceCount = (source: CoachScopeSource): number =>
    sources.has(source)
      ? countedTypes(source).reduce((n, t) => n + (counts.get(t) ?? 0), 0)
      : 0;
  const has = (source: CoachScopeSource): boolean => sourceCount(source) > 0;
  const counted = (n: number) => (n > 0 ? { count: n } : {});

  const entries: InventoryEntry[] = [];
  for (const metric of METRIC_SERIES_INVENTORY_SOURCES) {
    const n = metric === "mood" ? mood : sourceCount(metric);
    entries.push({
      tool: "get_metric_series",
      metric,
      domain: COACH_SOURCE_DOMAIN_LABEL[metric] ?? metric,
      present: n > 0,
      ...counted(n),
    });
  }
  entries.push({
    tool: "get_glucose_panel",
    domain: "glucose",
    present: has("glucose"),
    ...counted(sourceCount("glucose")),
  });
  entries.push({
    tool: "get_sleep",
    domain: "sleep",
    present: has("sleep"),
    ...counted(sourceCount("sleep")),
  });
  entries.push({
    tool: "get_medication_compliance",
    domain: "medication compliance",
    present: intakes > 0,
    ...counted(intakes),
  });
  entries.push({
    tool: "get_workouts",
    domain: "workouts & training",
    present: workouts > 0,
    ...counted(workouts),
  });
  entries.push({ tool: "get_labs", domain: "lab results", present: !!labs });
  // The derived scores, the day strain and the trajectories are computed
  // from these signals, and the snapshot builds them only while one of them
  // is in scope.
  const derived =
    has("hrv") || has("resting_hr") || has("sleep") || has("vo2_max");
  entries.push({
    tool: "get_illness_recovery",
    domain: "illness & recovery",
    present: illness !== null || derived,
  });
  entries.push({
    tool: "get_correlations",
    domain: "cross-metric patterns (discovered drivers)",
    present: derived || mood > 0 || has("steps"),
  });
  if (cycleEnabled) {
    entries.push({
      tool: "get_cycle",
      domain: "menstrual cycle & phase",
      present: cycle,
    });
  }
  if (environment !== null) {
    entries.push({
      tool: "get_environment",
      domain: "weather, air quality & pollen (modelled, not personal exposure)",
      present: environment,
    });
  }
  entries.push({
    tool: "get_day",
    domain: "one day across the record, by date (YYYY-MM-DD)",
    present: true,
  });

  if (options.availability !== false) {
    await attachInventoryAvailability(userId, entries, window);
  }

  return {
    entries,
    restMode: illness?.restMode === true,
    cycleEnabled,
    window,
  };
}
