/**
 * v1.4.15 — onboarding tour state model.
 * v1.18.6 — rebuilt as a 15-stop module-by-module guided tour.
 *
 * Pure data + state-machine helpers for the spotlight tour. Kept
 * DOM-free so vitest (Node environment, no jsdom) can exercise the
 * navigation logic directly.
 *
 * The tour walks every module in the order data → intelligence →
 * export, teaching each module's value, one hidden capability, and how
 * it feeds the others. The UI layer (`src/components/onboarding/tour.tsx`)
 * builds the step list once on mount and then drives navigation through
 * these helpers.
 *
 * Stops anchor to UI targets via `data-tour-id` attributes (NOT
 * class-name selectors — class names churn during Tailwind tweaks;
 * `data-tour-id` is a stable contract). A stop on another route also
 * carries a `route`; the overlay `router.push`es there, waits for the
 * anchor to mount, then measures. A missing target at runtime falls
 * back to a centred-screen tooltip so the tour never blocks.
 */

import type { ModuleKey } from "@/lib/modules/registry";
import { isSurfaceVisible } from "@/lib/modules/surface";

/** Stable IDs for every stop in the tour, in presentation order. */
export type TourStopId =
  | "dashboardOverview"
  | "quickAdd"
  | "measurements"
  | "medications"
  | "labs"
  | "illness"
  | "vorsorge"
  | "cycle"
  | "mood"
  | "insights"
  | "coach"
  | "integrations"
  | "export"
  | "achievements"
  | "wrapUp";

/**
 * One step in the tour. The `targetId` matches a `data-tour-id` on a
 * live element; the title/body i18n keys live under
 * `onboarding.tour.steps.<id>.*`.
 */
export interface TourStop {
  id: TourStopId;
  /**
   * The `data-tour-id` value of the element to anchor the spotlight
   * to. `null` for a purely informational centred stop (the wrap-up).
   */
  targetId: string | null;
  /**
   * Preferred tooltip placement relative to the target. The UI layer
   * may flip it if the target is too close to a viewport edge.
   */
  placement: "top" | "bottom" | "left" | "right" | "center";
  /** i18n key for the step title. */
  titleKey: string;
  /** i18n key for the step body. */
  bodyKey: string;
  /**
   * v1.18.6 — the route this stop's anchor lives on. Absent ⇒ the
   * anchor is on the current page (the wrap-up centred stop). When set,
   * the overlay navigates there before measuring. `"/"` is explicit for
   * the two dashboard stops so the resume path can route back from any
   * page.
   */
  route?: string;
}

/**
 * v1.18.6 — the canonical 15-stop module tour. Each entry is a literal
 * so the order, anchors, routes and gates are one auditable list.
 */
const ALL_STOPS: readonly TourStop[] = [
  {
    id: "dashboardOverview",
    targetId: "dashboard-tile-strip",
    placement: "bottom",
    route: "/",
    titleKey: "onboarding.tour.steps.dashboardOverview.title",
    bodyKey: "onboarding.tour.steps.dashboardOverview.body",
  },
  {
    id: "quickAdd",
    targetId: "dashboard-quick-add",
    placement: "bottom",
    route: "/",
    titleKey: "onboarding.tour.steps.quickAdd.title",
    bodyKey: "onboarding.tour.steps.quickAdd.body",
  },
  {
    id: "measurements",
    targetId: "measurements-hero",
    placement: "bottom",
    route: "/measurements",
    titleKey: "onboarding.tour.steps.measurements.title",
    bodyKey: "onboarding.tour.steps.measurements.body",
  },
  {
    id: "medications",
    targetId: "medications-hero",
    placement: "bottom",
    route: "/medications",
    titleKey: "onboarding.tour.steps.medications.title",
    bodyKey: "onboarding.tour.steps.medications.body",
  },
  {
    id: "labs",
    targetId: "labs-hero",
    placement: "bottom",
    route: "/labs",
    titleKey: "onboarding.tour.steps.labs.title",
    bodyKey: "onboarding.tour.steps.labs.body",
  },
  {
    id: "illness",
    targetId: "illness-hero",
    placement: "bottom",
    route: "/illness",
    titleKey: "onboarding.tour.steps.illness.title",
    bodyKey: "onboarding.tour.steps.illness.body",
  },
  {
    id: "vorsorge",
    targetId: "vorsorge-hero",
    placement: "bottom",
    route: "/checkups",
    titleKey: "onboarding.tour.steps.vorsorge.title",
    bodyKey: "onboarding.tour.steps.vorsorge.body",
  },
  {
    id: "cycle",
    targetId: "cycle-hero",
    placement: "bottom",
    route: "/cycle",
    titleKey: "onboarding.tour.steps.cycle.title",
    bodyKey: "onboarding.tour.steps.cycle.body",
  },
  {
    id: "mood",
    targetId: "mood-hero",
    placement: "bottom",
    route: "/mood",
    titleKey: "onboarding.tour.steps.mood.title",
    bodyKey: "onboarding.tour.steps.mood.body",
  },
  {
    id: "insights",
    targetId: "insights-hero",
    placement: "bottom",
    route: "/insights",
    titleKey: "onboarding.tour.steps.insights.title",
    bodyKey: "onboarding.tour.steps.insights.body",
  },
  {
    id: "coach",
    targetId: "coach-hero",
    placement: "bottom",
    route: "/coach",
    titleKey: "onboarding.tour.steps.coach.title",
    bodyKey: "onboarding.tour.steps.coach.body",
  },
  {
    id: "integrations",
    targetId: "integrations-hero",
    placement: "bottom",
    route: "/settings/integrations",
    titleKey: "onboarding.tour.steps.integrations.title",
    bodyKey: "onboarding.tour.steps.integrations.body",
  },
  {
    id: "export",
    targetId: "export-hero",
    placement: "bottom",
    route: "/settings/health-record",
    titleKey: "onboarding.tour.steps.export.title",
    bodyKey: "onboarding.tour.steps.export.body",
  },
  {
    id: "achievements",
    targetId: "achievements-hero",
    placement: "bottom",
    route: "/achievements",
    titleKey: "onboarding.tour.steps.achievements.title",
    bodyKey: "onboarding.tour.steps.achievements.body",
  },
  {
    id: "wrapUp",
    targetId: null,
    placement: "center",
    titleKey: "onboarding.tour.steps.wrapUp.title",
    bodyKey: "onboarding.tour.steps.wrapUp.body",
  },
];

/**
 * A partial map of `ModuleKey → enabled` — the `modules` field from
 * `GET /api/auth/me`. Default-on: a missing key or `true` keeps the
 * stop; only an explicit `false` drops it.
 */
export type TourModuleMap = Partial<Record<ModuleKey, boolean>>;

/**
 * Build the resolved tour-step list for the given module map. Stops
 * whose page belongs to a module that is `false` are dropped without
 * renumbering the rest.
 *
 * `filterToStop` narrows the list to a single stop — the per-module
 * "Diese Tour zeigen" re-entry shows just that module's card. An
 * unknown / module-disabled stop id yields an empty list (caller
 * renders nothing).
 */
export function buildTourStops(opts?: {
  modules?: TourModuleMap;
  filterToStop?: TourStopId;
}): TourStop[] {
  const modules = opts?.modules;
  // A stop follows the page it stands on, through the same surface map the
  // nav reads (`nav:<route>`), so a stop and its nav entry cannot disagree.
  const gated = ALL_STOPS.filter(
    (s) => !s.route || isSurfaceVisible(`nav:${s.route}`, modules),
  );
  if (opts?.filterToStop) {
    return gated.filter((s) => s.id === opts.filterToStop);
  }
  return gated;
}

/**
 * Tour navigation state. Pure value, immutable per transition — every
 * helper returns a fresh state instead of mutating in place.
 */
export interface TourState {
  /** Index into the steps array. May equal `steps.length` when complete. */
  index: number;
  /** Cached step list — handy for the renderer. */
  steps: TourStop[];
  /**
   * `null` while running, `"completed"` once the user reached the end
   * and clicked Done, `"skipped"` if they hit Skip on any step.
   */
  outcome: "completed" | "skipped" | null;
}

/**
 * Initial state. `resumeFromStopId` (v1.18.6) seeds the index from a
 * persisted resume point — if the id is present in the resolved list,
 * the tour opens there; otherwise it starts at the first stop (e.g. the
 * resume stop's module was disabled since the checkpoint was written).
 */
export function initTourState(
  steps: TourStop[],
  resumeFromStopId?: string | null,
): TourState {
  let index = 0;
  if (resumeFromStopId) {
    const found = steps.findIndex((s) => s.id === resumeFromStopId);
    if (found >= 0) index = found;
  }
  return { index, steps, outcome: null };
}

/**
 * Advance to the next step. On the last step, mark `completed`. A
 * no-op on a terminal state so the renderer can fire-and-forget on
 * rapid double-clicks.
 */
export function nextStep(state: TourState): TourState {
  if (state.outcome !== null) return state;
  const lastIndex = state.steps.length - 1;
  if (state.index >= lastIndex) {
    return { ...state, index: state.steps.length, outcome: "completed" };
  }
  return { ...state, index: state.index + 1 };
}

/**
 * Step backwards. Pinned at index 0 — the first step has no Back
 * button visually; this keeps the LeftArrow shortcut safe.
 */
export function prevStep(state: TourState): TourState {
  if (state.outcome !== null) return state;
  if (state.index <= 0) return state;
  return { ...state, index: state.index - 1 };
}

/**
 * Whether the page a stop navigated to sent the person somewhere else.
 *
 * A stop's page can refuse the visit on its own (the Coach page answers an
 * unavailable Coach with a redirect to `/insights`), and the overlay would
 * otherwise push the stop's route again on every pathname change: a loop
 * between the two pages. `pushedFrom` is the pathname the tour navigated
 * from for this stop (`null` while it has not navigated), `arrived` whether
 * the stop's own page was reached since. Before arrival, a pathname still
 * equal to `pushedFrom` is a navigation on its way, not a redirect.
 */
export function stopRouteRedirected(args: {
  stopRoute: string;
  pathname: string;
  pushedFrom: string | null;
  arrived: boolean;
}): boolean {
  if (args.pushedFrom === null) return false;
  if (args.pathname === args.stopRoute) return false;
  return args.arrived || args.pathname !== args.pushedFrom;
}

/**
 * Drop the current stop after its page redirected, and carry on in the
 * direction the person was travelling. The stop leaves the list, so Back
 * never lands on it again and the counter stays honest; dropping the last
 * stop going forward completes the tour.
 */
export function dropRedirectedStop(
  state: TourState,
  direction: "forward" | "back",
): TourState {
  if (state.outcome !== null) return state;
  const steps = state.steps.filter((_, i) => i !== state.index);
  if (direction === "back") {
    return { ...state, steps, index: Math.max(0, state.index - 1) };
  }
  if (state.index >= steps.length) {
    return { ...state, steps, index: steps.length, outcome: "completed" };
  }
  return { ...state, steps };
}

/** User explicitly dismissed the tour from any step. */
export function skipTour(state: TourState): TourState {
  if (state.outcome !== null) return state;
  return { ...state, index: state.steps.length, outcome: "skipped" };
}

/** Whether the tour has reached a terminal state. */
export function isTourFinished(state: TourState): boolean {
  return state.outcome !== null;
}

/** The current stop, or null if the tour is finished. */
export function currentStop(state: TourState): TourStop | null {
  if (state.outcome !== null) return null;
  return state.steps[state.index] ?? null;
}

/** 1-based step counter for "{n}/{total}" displays. */
export function stepCounter(state: TourState): {
  current: number;
  total: number;
} {
  return {
    current: Math.min(state.index + 1, state.steps.length),
    total: state.steps.length,
  };
}

/**
 * v1.18.6 — derive the persisted progress checkpoint from the live
 * navigation state. Pure so the overlay can fire-and-forget it without
 * touching the DOM. `completedStopIds` accumulates every stop the user
 * has reached up to (and including) the current index; `lastStopId` is
 * the resume point.
 */
export function deriveProgress(state: TourState): {
  lastStopId: string | null;
  completedStopIds: string[];
  status: "in_progress" | "completed" | "skipped";
} {
  const status =
    state.outcome === "completed"
      ? "completed"
      : state.outcome === "skipped"
        ? "skipped"
        : "in_progress";
  const reachedCount =
    state.outcome !== null
      ? state.steps.length
      : Math.min(state.index + 1, state.steps.length);
  const completedStopIds = state.steps.slice(0, reachedCount).map((s) => s.id);
  const current = currentStop(state);
  return {
    lastStopId: current?.id ?? null,
    completedStopIds,
    status,
  };
}
