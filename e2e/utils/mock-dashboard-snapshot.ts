import type { Page } from "@playwright/test";

import {
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@/lib/dashboard-layout";
import type { DailyBriefing } from "@/lib/ai/schema";
import type { DashboardScoreRing } from "@/lib/dashboard/score-rings";
import type { DataSummary } from "@/lib/analytics/trends";
import type {
  DashboardSnapshot,
  DashboardLayoutCatalogueEntry,
  DashboardTargetBands,
} from "@/lib/dashboard/snapshot";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { METRIC_BOUNDS } from "@/lib/analytics/effective-range";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildBandsFromTrafficRange,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";

// v1.18.6 — resolve the mock's band block from the same pure helpers the
// server builder uses, so the e2e fixture matches the real DTO shape.
function mockTargetBands(): DashboardTargetBands {
  const dob = new Date("1990-01-01T00:00:00.000Z");
  const bpTargets = getBpTargets(dob);
  const pulseTarget = getPersonalizedPulseTarget(
    getAgeFromDateOfBirth(dob),
    "MALE",
  );
  const bodyFatRange = getBodyFatTargetRange("MALE");
  return {
    bpTargets,
    bpSysRange: bpTargets
      ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
      : null,
    bpDiaRange: bpTargets
      ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
      : null,
    pulseDisplayRange: {
      greenMin: pulseTarget.greenMin,
      greenMax: pulseTarget.greenMax,
      orangeMin: pulseTarget.orangeMin,
      orangeMax: pulseTarget.orangeMax,
    },
    pulseBands: [
      { min: 30, max: pulseTarget.orangeMin, color: "#ff5555", opacity: 0.16 },
      {
        min: pulseTarget.orangeMin,
        max: pulseTarget.greenMin,
        color: "#ffb86c",
        opacity: 0.18,
      },
      {
        min: pulseTarget.greenMin,
        max: pulseTarget.greenMax,
        color: "#50fa7b",
        opacity: 0.2,
      },
      {
        min: pulseTarget.greenMax,
        max: pulseTarget.orangeMax,
        color: "#ffb86c",
        opacity: 0.18,
      },
      { min: pulseTarget.orangeMax, max: 220, color: "#ff5555", opacity: 0.16 },
    ].filter((b) => b.max > b.min),
    bodyFatRange,
    bodyFatBands: buildTrafficLightBands(bodyFatRange.min, bodyFatRange.max, {
      lowerBound: 2,
      upperBound: 55,
    }),
    weightRange: buildWeightRangeFromHeight(180),
    weightBands: buildBandsFromTrafficRange(buildWeightRangeFromHeight(180), {
      lowerBound: METRIC_BOUNDS.WEIGHT.min,
      upperBound: 250,
    }),
  };
}

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
    median: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
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

/**
 * Long-headline briefing fixture for the hero density guard: every
 * signal pairs a wrapping German headline with a wide delta string —
 * the exact shape that squeezed the spotlight rows on phone widths.
 */
export const LONG_HEADLINE_BRIEFING: DailyBriefing = {
  paragraph:
    "Dein systolischer Blutdruck liegt heute deutlich unter deinem Monatsmittel, während die Schlafdauer stabil bleibt.",
  signalsOfDay: [
    {
      sourceMetric: "bp",
      tone: "watch",
      headline:
        "Systolischer Blutdruck deutlich unter deinem Monatsmittel gemessen",
      nudge: "Miss heute Abend erneut, um den Wert einzuordnen.",
      delta: "−12 mmHg vs. 30-Tage-Mittel",
    },
    {
      sourceMetric: "sleep",
      tone: "info",
      headline:
        "Schlafdauer in den letzten sieben Nächten etwa eine Stunde kürzer als üblich",
      nudge: "Plane heute eine frühere Nachtruhe ein.",
      delta: "−58 min",
    },
    {
      sourceMetric: "compliance",
      tone: "good",
      headline: "Alle geplanten Dosen der Woche bisher vollständig eingenommen",
      nudge: "Weiter so — die Abenddosis steht um 20:00 an.",
      delta: "7/7 Tage",
    },
  ],
  keyFindings: [],
};

/** Three-ring hero row fixture (max the hero renders beside the score). */
export const MOCK_SCORE_RINGS: DashboardScoreRing[] = [
  { id: "READINESS", score: 82, band: "green" },
  { id: "RECOVERY_SCORE", score: 74, band: "yellow" },
  {
    id: "MED_COMPLIANCE",
    score: 33,
    band: "yellow",
    doses: { taken: 1, scheduled: 3 },
  },
];

export interface MockSnapshotOptions {
  /**
   * Tile summaries keyed by `MeasurementType`. Defaults to the
   * four-metric populated set. Pass `{}` for an empty strip (e.g. the
   * incomplete-onboarding branch).
   */
  summaries?: Record<string, DataSummary>;
  /** Artificial latency in ms before the route fulfils (race specs). */
  delayMs?: number;
  /** Fresh (`ready`, non-stale) briefing for the dashboard briefing card. */
  briefing?: DailyBriefing;
  /** Selected score rings carried on the snapshot (server-computed). */
  scoreRings?: DashboardScoreRing[];
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
    },
    layout: DEFAULT_DASHBOARD_LAYOUT,
    layoutCatalogue: buildLayoutCatalogue(),
    metricStates: {},
    targetBands: mockTargetBands(),
    tiles: {
      summaries,
      lastSeenByType,
      mood: { summary: null, entries: [] },
    },
    extras: null,
    medsToday: {
      activeCount: 0,
      scheduledToday: 0,
      takenToday: 0,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
      nextDueMedicationName: null,
      nextDueMedicationId: null,
    },
    healthScore: options.briefing
      ? {
          score: 84,
          band: "green",
          delta: -2,
          restMode: null,
          // v1.38 — full breadth, so nothing extra renders. Present
          // because the server sends it on every scored snapshot.
          scoreBasis: {
            domains: 3,
            recommended: 3,
            tier: "full" as const,
            physiological: true,
          },
        }
      : null,
    scoreRings: options.scoreRings,
    briefing: options.briefing ?? null,
    briefingState: options.briefing ? "ready" : "preparing",
    briefingUpdatedAt: options.briefing ? now : null,
    briefingStale: false,
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
