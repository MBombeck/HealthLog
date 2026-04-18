/**
 * Dashboard widget layout — persisted in User.dashboardWidgetsJson.
 *
 * Single source of truth for which widgets show on /, what order, and
 * what the default layout is for new users. Null / missing = default.
 */

export type DashboardWidgetId =
  | "weight"
  | "bp"
  | "pulse"
  | "bodyFat"
  | "mood"
  | "medications"
  | "sleep"
  | "steps"
  | "glucose"
  | "bpInTarget";

export interface DashboardWidgetConfig {
  id: DashboardWidgetId;
  visible: boolean;
  order: number;
}

export interface DashboardLayout {
  version: number;
  widgets: DashboardWidgetConfig[];
}

export const DASHBOARD_LAYOUT_VERSION = 1;

/**
 * Default layout mirrors v1.1 behavior: core vitals always on, mood +
 * body-fat show if data exists (see dashboard page for the data-conditional
 * rendering). Ordering matches the visual order on / today.
 */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: DASHBOARD_LAYOUT_VERSION,
  widgets: [
    { id: "weight", visible: true, order: 0 },
    { id: "bp", visible: true, order: 1 },
    { id: "pulse", visible: true, order: 2 },
    { id: "bodyFat", visible: true, order: 3 },
    { id: "mood", visible: true, order: 4 },
    { id: "bpInTarget", visible: true, order: 5 },
    { id: "medications", visible: true, order: 6 },
    { id: "sleep", visible: false, order: 7 },
    { id: "steps", visible: false, order: 8 },
    { id: "glucose", visible: false, order: 9 },
  ],
};

export function resolveDashboardLayout(
  raw: unknown,
): DashboardLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_DASHBOARD_LAYOUT;
  const candidate = raw as Partial<DashboardLayout>;
  if (
    typeof candidate.version !== "number" ||
    !Array.isArray(candidate.widgets)
  ) {
    return DEFAULT_DASHBOARD_LAYOUT;
  }

  // Merge with defaults so new widgets introduced in later versions show up
  // automatically (invisible by default, users opt-in).
  const savedIds = new Set(candidate.widgets.map((w) => w.id));
  const missing = DEFAULT_DASHBOARD_LAYOUT.widgets.filter(
    (w) => !savedIds.has(w.id),
  );
  const maxOrder = Math.max(0, ...candidate.widgets.map((w) => w.order));
  const appended = missing.map((w, i) => ({
    ...w,
    visible: false, // default-invisible on auto-upgrade
    order: maxOrder + 1 + i,
  }));

  return {
    version: DASHBOARD_LAYOUT_VERSION,
    widgets: [...candidate.widgets, ...appended].sort(
      (a, b) => a.order - b.order,
    ),
  };
}

export function serializeDashboardLayout(
  layout: DashboardLayout,
): DashboardLayout {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    widgets: layout.widgets
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((w, i) => ({ ...w, order: i })), // normalize to 0-based dense order
  };
}
