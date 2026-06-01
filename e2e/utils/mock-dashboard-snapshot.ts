import type { Page } from "@playwright/test";

import {
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@/lib/dashboard-layout";
import type { DataSummary } from "@/lib/analytics/trends";
import type {
  DashboardSnapshot,
  DashboardLayoutCatalogueEntry,
} from "@/lib/dashboard/snapshot";

/**
 * v1.7.2 — shared mock for `GET /api/dashboard/snapshot`.
 *
 * The dashboard snapshot flag flipped default-ON in v1.7.2, so
 * `src/app/page.tsx` reads every above-the-fold tile from the single
 * `/api/dashboard/snapshot` cell unless `NEXT_PUBLIC_DASHBOARD_SNAPSHOT`
 * is `"false"`. The e2e build sets no such var, so the snapshot path is
 * live in CI. Specs that previously mocked only the legacy cells
 * (`/api/analytics` + `/api/mood/analytics` + `/api/dashboard/widgets`)
 * now hit the REAL snapshot route, which returns empty `summaries` for
 * the seed user (zero measurements) and blanks the tile strip.
 *
 * `mockDashboardSnapshot` registers a `page.route` for the snapshot
 * endpoint returning a correctly-typed `DashboardSnapshot` so the
 * default-ON path paints deterministic tiles. Callers keep their legacy
 * mocks alongside it — harmless, and they protect the reversible
 * `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false` path.
 */

/** Fill a `DataSummary` from a sparse partial, defaulting the rest. */
function summary(partial: Partial<DataSummary>): DataSummary {
  return {
    count: 0,
    latest: null,
    min: null,
    max: null,
    mean: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    slope90: null,
    anomalyCount: 0,
    avg30LastMonth: null,
    avg30LastYear: null,
    ...partial,
  };
}

/**
 * Four-metric populated tile set mirroring the legacy `/api/analytics`
 * mock shared by `dashboard.spec.ts` / `charts-mobile.spec.ts` /
 * `chart-overlay-controls.spec.ts`. Every summary has `count > 0` so the
 * tile clears the data-floor gate in `src/app/page.tsx`.
 */
export const POPULATED_SUMMARIES: Record<string, DataSummary> = {
  WEIGHT: summary({
    latest: 78.5,
    avg7: 78.2,
    avg30: 77.9,
    slope30: { slope: -0.05, direction: "down", confidence: 0.8 },
    count: 30,
  }),
  BLOOD_PRESSURE_SYS: summary({
    latest: 124,
    avg7: 122,
    avg30: 121,
    slope30: { slope: 0.1, direction: "stable", confidence: 0.3 },
    count: 30,
  }),
  BLOOD_PRESSURE_DIA: summary({
    latest: 80,
    avg7: 79,
    avg30: 78,
    slope30: { slope: 0.05, direction: "stable", confidence: 0.2 },
    count: 30,
  }),
  PULSE: summary({
    latest: 68,
    avg7: 70,
    avg30: 71,
    slope30: { slope: -0.2, direction: "down", confidence: 0.6 },
    count: 30,
  }),
};

/** WEIGHT-only populated set for specs that only need one tile + chart. */
export const WEIGHT_ONLY_SUMMARIES: Record<string, DataSummary> = {
  WEIGHT: POPULATED_SUMMARIES.WEIGHT,
};

function buildLayoutCatalogue(): DashboardLayoutCatalogueEntry[] {
  return DASHBOARD_WIDGET_CATALOGUE_IDS.map((id, order) => ({
    id,
    visible: true,
    order,
  }));
}

export interface MockSnapshotOptions {
  /**
   * Tile summaries keyed by `MeasurementType`. Defaults to the
   * four-metric populated set. Pass `{}` for an empty strip (e.g. the
   * incomplete-onboarding branch).
   */
  summaries?: Record<string, DataSummary>;
  /** Artificial latency in ms before the route fulfils (race specs). */
  delayMs?: number;
}

/** Assemble a fully-typed snapshot body from the requested tile data. */
export function buildMockSnapshot(
  options: MockSnapshotOptions = {},
): DashboardSnapshot {
  const summaries = options.summaries ?? POPULATED_SUMMARIES;
  const now = new Date().toISOString();
  const lastSeenByType: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > = {};
  for (const type of Object.keys(summaries)) {
    lastSeenByType[type] = { lastSeenAt: now, daysAgo: 0 };
  }
  return {
    user: {
      username: "e2e-tester",
      timezone: "Europe/Berlin",
      heightCm: 180,
      dateOfBirth: "1990-01-01T00:00:00.000Z",
      gender: "MALE",
      glucoseUnit: "mg/dL",
      onboardingTourCompleted: true,
      greetingHour: 9,
    },
    layout: DEFAULT_DASHBOARD_LAYOUT,
    layoutCatalogue: buildLayoutCatalogue(),
    metricStates: {},
    tiles: {
      summaries,
      lastSeenByType,
      mood: { summary: null, entries: [] },
    },
    extras: null,
    briefing: null,
    briefingState: "preparing",
    briefingUpdatedAt: null,
    generatedAt: now,
  };
}

/**
 * Register a `page.route` interceptor for `GET /api/dashboard/snapshot`
 * returning the API envelope `{ data: DashboardSnapshot, error: null }`.
 */
export async function mockDashboardSnapshot(
  page: Page,
  options: MockSnapshotOptions = {},
): Promise<void> {
  const body = buildMockSnapshot(options);
  await page.route(/\/api\/dashboard\/snapshot(\?|$)/, async (route) => {
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: body, error: null }),
    });
  });
}
