import type {
  DashboardLayout,
  DashboardWidgetId,
} from "@/lib/dashboard-layout";
import {
  PRIORITY_ITEM_KINDS,
  type PriorityItemKind,
} from "@/lib/daily/priority-item";

/**
 * Pure reorder helper shared by the arrow buttons and the
 * @dnd-kit drag-end handler. Both surfaces produce the same `widgets[]`
 * shape (`order: 0..n-1`) so the existing PUT contract stays untouched
 * and either input mode flushes via the same Save mutation. Exported so
 * the unit test can pin the contract without spinning up a DndContext.
 *
 * Also drives the arrow-button `move()` handler below;
 * the previous in-file swap-and-renumber implementation was a second
 * copy of the same logic.
 */
export function reorderWidgets(
  widgets: readonly { id: string; order: number }[],
  fromId: string,
  toId: string,
): { id: string; order: number }[] {
  const sorted = [...widgets].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((w) => w.id === fromId);
  const toIdx = sorted.findIndex((w) => w.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
    return sorted.map((w, i) => ({ ...w, order: i }));
  }
  const next = [...sorted];
  const [removed] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, removed);
  return next.map((w, i) => ({ ...w, order: i }));
}

export function setHeroItemKindEnabled(
  enabledKinds: readonly PriorityItemKind[] | undefined,
  kind: PriorityItemKind,
  enabled: boolean,
): PriorityItemKind[] {
  const next = new Set(enabledKinds ?? PRIORITY_ITEM_KINDS);
  if (enabled) next.add(kind);
  else next.delete(kind);
  return PRIORITY_ITEM_KINDS.filter((itemKind) => next.has(itemKind));
}

/**
 * Merge the `{ id, order }` shape returned by
 * `reorderWidgets()` back into the full `DashboardWidgetConfig[]` so
 * the section's draft state keeps every per-row flag (`visible`,
 * `tileVisible`) while the order is rewritten. The arrow buttons and
 * the @dnd-kit drag-end handler both flow through this helper so
 * neither surface can silently drop a flag.
 */
export function mergeReorderIntoLayout(
  widgets: DashboardLayout["widgets"],
  reordered: readonly { id: string; order: number }[],
): DashboardLayout["widgets"] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  return reordered.map((r, i) => {
    const original = byId.get(r.id as DashboardWidgetId);
    if (!original) {
      // Defence-in-depth dev warning for the orphan branch.
      // Today this branch is statically unreachable: every id in
      // `reordered` is sourced from `layout.widgets`, so `byId.get`
      // always hits. The upcoming per-tile Suspense refactor will
      // introduce dynamic widgets where this invariant could break;
      // the warning fires in dev only so a regression surfaces in the
      // console instead of silently dropping the row via the cast.
      if (
        typeof window !== "undefined" &&
        process.env.NODE_ENV === "development"
      ) {
        console.warn(
          `mergeReorderIntoLayout: orphan widget id "${r.id}" dropped`,
        );
      }
      return { ...r, order: i } as never;
    }
    return { ...original, order: i };
  });
}

/** Serialise layout saves and resets against the same endpoint. */
export const DASHBOARD_WIDGETS_MUTATION_SCOPE = "dashboard-widgets" as const;

export const WIDGET_LABEL_KEYS: Record<DashboardWidgetId, string> = {
  weight: "dashboard.weight",
  bp: "dashboard.bloodPressure",
  pulse: "dashboard.pulse",
  bodyFat: "dashboard.bodyFat",
  mood: "dashboard.mood",
  medications: "dashboard.medications",
  sleep: "measurements.typeSleep",
  steps: "measurements.typeSteps",
  glucose: "measurements.typeBloodGlucose",
  totalBodyWater: "measurements.typeTotalBodyWater",
  boneMass: "measurements.typeBoneMass",
  // Muscle mass joins the body-composition strip tiles.
  muscleMass: "measurements.typeMuscleMass",
  bpInTarget: "dashboard.bpInTarget",
  oxygenSaturation: "measurements.typeOxygenSaturation",
  // HRV + respiratory rate graduate to web-writable widgets.
  hrv: "measurements.typeHeartRateVariability",
  respiratoryRate: "measurements.typeRespiratoryRate",
  achievements: "achievements.title",
  // VO2 max secondary-metric tile (opt-in).
  vo2Max: "dashboard.vo2Max",
  // Recent workouts tile (default-on).
  recentWorkouts: "dashboard.recentWorkouts.title",
  // V1.10 additive HealthKit signals, now pinnable. Each
  // reuses the existing measurement-type label key.
  cardioRecovery: "measurements.typeCardioRecovery",
  sixMinuteWalk: "measurements.typeSixMinuteWalkDistance",
  stairAscentSpeed: "measurements.typeStairAscentSpeed",
  stairDescentSpeed: "measurements.typeStairDescentSpeed",
  breathingDisturbances: "measurements.typeBreathingDisturbances",
  wristTemperature: "measurements.typeWristTemperature",
  falls: "measurements.typeFallCount",
  walkingSteadiness: "measurements.typeWalkingSteadiness",
  // Vorsorge preventive-care summary card.
  vorsorge: "measurementReminders.sectionTitle",
  // Fluid intake strip tile (nutrients-store-backed).
  waterIntake: "nutrients.names.water",
};

export const HERO_ITEM_LABEL_KEYS: Record<PriorityItemKind, string> = {
  coach_checkin: "dashboard.heroItems.coach_checkin",
  dose_window: "dashboard.heroItems.dose_window",
  preventive_care: "dashboard.heroItems.preventive_care",
  sync_issue: "dashboard.heroItems.sync_issue",
  milestone: "dashboard.heroItems.milestone",
  ecg_new_recording: "dashboard.heroItems.ecg_new_recording",
  tension_window: "dashboard.heroItems.tension_window",
  same_time_baseline: "dashboard.heroItems.same_time_baseline",
  upcoming_visit: "dashboard.heroItems.upcoming_visit",
};
