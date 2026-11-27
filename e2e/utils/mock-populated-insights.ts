import type { Page } from "@playwright/test";

import {
  SECTION_MOBILITY,
  SECTION_VITALS,
} from "@/components/insights/derived/use-dashboard-derived";
import { SCORE_VERSION } from "@/lib/analytics/score/types";

/**
 * A POPULATED Insights overview fixture.
 *
 * The mobile-overflow guard exists to prove that a page carrying real content
 * does not scroll sideways. Against the shared e2e account — which owns no
 * measurements — `/insights` resolves to its empty state, and an empty page
 * trivially fits any viewport. Every section below therefore gets a body:
 * populated wellness scores, a full vitals grid, and the "signals of the day"
 * card whose heading carries the long plain-language provenance caption.
 *
 * The strings are deliberately long. Prose in a heading's trailing `action`
 * slot is exactly what widened the page in the first place, and a fixture with
 * short labels would not reproduce it.
 */

const NOW = "2026-01-15T08:30:00.000Z";

function provenance(inputs: string[]) {
  return {
    inputs,
    source: "DAY" as const,
    windowDays: 30,
    computedAt: NOW,
  };
}

function coverage() {
  return {
    requiredInputs: 4,
    presentInputs: 4,
    historyDays: 90,
    missing: [] as string[],
  };
}

function confidence() {
  return { score: 88, band: "high" as const };
}

function deviation(
  type: string,
  value: number,
  low: number,
  high: number,
  direction: "above" | "below" | "in",
) {
  return {
    type,
    value,
    center: (low + high) / 2,
    low,
    high,
    outside: direction !== "in",
    direction,
  };
}

/**
 * The "signals of the day" payload in its `fired` state — the branch that
 * renders `SectionHeading action={<CoincidentProvenance/>}`, i.e. a full
 * sentence pinned into the heading row.
 */
const COINCIDENT_FIRED = {
  metric: "COINCIDENT_DEVIATION",
  status: "ok" as const,
  value: {
    fired: true,
    day: "2026-01-15",
    illnessExplained: false,
    vitals: [
      deviation("RESTING_HEART_RATE", 71, 52, 62, "above"),
      deviation("HEART_RATE_VARIABILITY", 38, 45, 78, "below"),
      deviation("RESPIRATORY_RATE", 17.4, 12.5, 16.2, "above"),
      deviation("OXYGEN_SATURATION", 97, 96, 99, "in"),
      deviation("BODY_TEMPERATURE", 36.9, 36.2, 37.1, "in"),
    ],
    contributing: [
      deviation("RESTING_HEART_RATE", 71, 52, 62, "above"),
      deviation("HEART_RATE_VARIABILITY", 38, 45, 78, "below"),
      deviation("RESPIRATORY_RATE", 17.4, 12.5, 16.2, "above"),
    ],
  },
  coverage: coverage(),
  confidence: confidence(),
  provenance: provenance([
    "RESTING_HEART_RATE",
    "HEART_RATE_VARIABILITY",
    "RESPIRATORY_RATE",
  ]),
  reason: null,
};

/**
 * A populated Health Score report for the hero band's score column.
 *
 * The panel is the widest-content block in the band: a fixed-width label
 * column, a fill bar, a value column and a popover trigger all on one 20 px
 * line, plus a coalesced failed-read line that carries an inline button. An
 * empty score leaves the column unmounted entirely, so without this the
 * phone-width guard measured a band that had no panel in it.
 *
 * By default it is an account a person could have: four scored rows and
 * glycaemia and lipids not measured yet, with a delta the history below it
 * stands behind. `everyState` adds the two states a geometry guard needs to
 * measure and no real account carries together: a failed lipids read with
 * its retry, and wellbeing withheld for safety signposting. A screenshot of
 * the page is taken without it, so a fixture state never passes for one the
 * server produced.
 */
function scorePillar(id: string, domain: string, score: number) {
  return {
    id,
    domain,
    result: {
      status: "ok" as const,
      value: {
        score,
        observed: {
          value: 126,
          unit: "mmHg",
          label: "126/78 mmHg",
          asOf: NOW,
          sources: ["MANUAL"],
        },
        reference: {
          kind: "clinical-threshold" as const,
          low: 120,
          high: 129,
          label: "120 to 129/70 to 79 mmHg",
          source: "ESH 2023",
        },
        noiseFloor: 1,
        deltaEligible: true,
        deltaIdentity: id,
      },
      coverage: coverage(),
      confidence: confidence(),
      provenance: provenance([id]),
    },
  };
}

function gatedPillar(id: string, domain: string, reason: string) {
  return {
    id,
    domain,
    result: {
      status: "insufficient" as const,
      coverage: {
        requiredInputs: 4,
        presentInputs: 0,
        historyDays: 0,
        missing: [] as string[],
      },
      provenance: provenance([id]),
      reason,
    },
  };
}

/** The score the panel shows, and the stored score a week before it. */
export const HEALTH_SCORE_SHOWN = 74;
const HEALTH_SCORE_WEEK_AGO = 72;

/** The local day `offset` days from today, `YYYY-MM-DD`. */
function localDay(offset: number): string {
  const at = new Date(Date.now() + offset * 86_400_000);
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${m}-${d}`;
}

/**
 * The health score's stored days for the chart under the panel: the same
 * store the delta is read from, so the panel's "+2" is the move between the
 * chart's newest point and its point a week earlier.
 */
export function healthScoreHistoryPoints(days: number) {
  const count = Math.min(days, 30);
  return Array.from({ length: count }, (_, i) => {
    const offset = i - count + 1;
    const value =
      offset === 0
        ? HEALTH_SCORE_SHOWN
        : offset === -7
          ? HEALTH_SCORE_WEEK_AGO
          : 70 + ((i * 5) % 7);
    return { day: localDay(offset), value, seamBreak: false };
  });
}

export function healthScoreReport(everyState: boolean) {
  return {
    composite: {
      status: "ok" as const,
      value: {
        score: HEALTH_SCORE_SHOWN,
        band: "green" as const,
        numberBand: "green" as const,
        bandSetter: "SLEEP",
        composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP", "ADIPOSITY"],
        configured: false,
        // Each counted pillar's share, as the scorer publishes it: the score is
        // the plain mean, so four pillars weigh a quarter each.
        weights: [
          { id: "BLOOD_PRESSURE", weight: 0.25 },
          { id: "ACTIVITY", weight: 0.25 },
          { id: "SLEEP", weight: 0.25 },
          { id: "ADIPOSITY", weight: 0.25 },
        ],
        // v1.38 — four pillars across four areas of health, so this is a
        // full-breadth score and the panel adds no basis line. It rides
        // anyway, because the wire carries the block on every ok composite
        // and a fixture missing a field the server always sends stops
        // exercising the branch a person meets.
        scoreBasis: {
          domains: 4,
          recommended: 3,
          tier: "full" as const,
          physiological: true,
        },
        noiseFloor: 3,
        scoreVersion: SCORE_VERSION,
      },
      coverage: coverage(),
      confidence: confidence(),
      provenance: provenance(["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"]),
    },
    pillars: [
      scorePillar("BLOOD_PRESSURE", "cardiometabolic", 56),
      scorePillar("ACTIVITY", "activity", 88),
      scorePillar("SLEEP", "sleep", 41),
      scorePillar("ADIPOSITY", "adiposity", 72),
      ...(everyState
        ? [
            gatedPillar("LIPIDS", "cardiometabolic", "read_failed"),
            gatedPillar("WELLBEING", "wellbeing", "crisis_signposting"),
          ]
        : [gatedPillar("LIPIDS", "cardiometabolic", "not_tracked")]),
      gatedPillar("GLYCAEMIA", "cardiometabolic", "not_tracked"),
    ],
    delta: HEALTH_SCORE_SHOWN - HEALTH_SCORE_WEEK_AGO,
    deltaReason: null,
    scoreVersion: SCORE_VERSION,
    weightGoal: {
      status: "ok" as const,
      value: {
        currentKg: 81,
        target: { min: 74, max: 78 },
        distanceKg: 3,
        deltaKg: 1,
        asOf: NOW,
        source: "MANUAL",
      },
      coverage: coverage(),
      confidence: confidence(),
      provenance: provenance(["WEIGHT"]),
    },
    algorithmNotice: null,
    restMode: null,
  };
}

/** A deterministic sparkline series around `center`. */
function series(center: number, spread: number): number[] {
  return Array.from({ length: 30 }, (_, i) =>
    Number((center + Math.sin(i / 2.5) * spread).toFixed(2)),
  );
}

/**
 * A populated `WellnessScoreValue` entry — the exact wire shape the three
 * persisted score types share (`RECOVERY_SCORE` / `STRESS_SCORE` /
 * `STRAIN_SCORE`).
 */
function wellnessScore(
  metric: string,
  score: number,
  band: "green" | "yellow" | "red",
) {
  return {
    metric,
    status: "ok" as const,
    value: {
      score,
      band,
      trendDelta: 3.4,
      daysInWindow: 28,
      asOf: NOW,
      series: series(score, 6),
      // Whose number it is, as the server resolves it: the recovery proxy is
      // HealthLog's blend, stress and strain are estimates.
      origin: metric === "RECOVERY_SCORE" ? "computed" : "estimate",
      deviceSource: null,
    },
    coverage: coverage(),
    confidence: confidence(),
    provenance: provenance(["SLEEP_DURATION", "RESTING_HEART_RATE"]),
    reason: null,
    assessment: null,
  };
}

/**
 * A fresh readiness (`ReadinessValue`), the first ring at the head of the
 * overview. Its components are left empty: the head reads score, band,
 * freshness and course only.
 */
function readiness(score: number, band: "green" | "yellow" | "red") {
  return {
    metric: "READINESS",
    status: "ok" as const,
    value: {
      score,
      band,
      components: [],
      series: series(score, 6),
      asOfDay: NOW.slice(0, 10),
      fresh: true,
    },
    coverage: coverage(),
    confidence: confidence(),
    provenance: provenance(["RESTING_HEART_RATE", "HEART_RATE_VARIABILITY"]),
    reason: null,
    assessment: null,
  };
}

/** A populated `VitalsBaselineValue` tile — exact wire shape. */
function vitalsBaseline(type: string, center: number, spread: number) {
  return {
    metric: "VITALS_BASELINE",
    status: "ok" as const,
    value: {
      type,
      center,
      low: Number((center - spread).toFixed(2)),
      high: Number((center + spread).toFixed(2)),
      spread,
      sampleDays: 30,
      k: 2,
      series: series(center, spread / 2),
    },
    coverage: coverage(),
    confidence: confidence(),
    provenance: provenance([type]),
    reason: null,
  };
}

/**
 * The honest "not enough history" arm. Metrics whose value shapes this fixture
 * does not reproduce exactly are served as `insufficient` rather than as an
 * invented payload — that is a real state those tiles handle (they un-mount),
 * and a wrong-shaped `ok` payload would throw in the tile instead of testing
 * anything.
 */
function insufficient(metric: string) {
  return {
    metric,
    status: "insufficient" as const,
    value: null,
    coverage: {
      requiredInputs: 4,
      presentInputs: 1,
      historyDays: 3,
      missing: ["SLEEP_DURATION"],
    },
    confidence: null,
    provenance: provenance([]),
    reason: "not_enough_history",
  };
}

/** Center + spread per vital, in each metric's own units. */
const VITAL_BANDS: Record<string, [number, number]> = {
  RESTING_HEART_RATE: [57, 5],
  RESPIRATORY_RATE: [14.1, 1.8],
  OXYGEN_SATURATION: [97, 1.5],
  BODY_TEMPERATURE: [36.6, 0.45],
  BLOOD_GLUCOSE: [92, 13],
  WEIGHT: [79.4, 3],
};

function buildBatchMetrics(): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    RECOVERY_SCORE: wellnessScore("RECOVERY_SCORE", 66, "yellow"),
    STRESS_SCORE: wellnessScore("STRESS_SCORE", 41, "green"),
    STRAIN_SCORE: wellnessScore("STRAIN_SCORE", 72, "yellow"),
    READINESS: readiness(74, "green"),
    SLEEP_SCORE: insufficient("SLEEP_SCORE"),
    FITNESS_AGE: insufficient("FITNESS_AGE"),
    VASCULAR_AGE_DELTA: insufficient("VASCULAR_AGE_DELTA"),
    HRV_BALANCE: insufficient("HRV_BALANCE"),
    BMI: insufficient("BMI"),
    SIX_MINUTE_WALK_BAND: insufficient("SIX_MINUTE_WALK_BAND"),
  };
  for (const type of SECTION_VITALS) {
    if (type === "HEART_RATE_VARIABILITY") continue;
    const [center, spread] = VITAL_BANDS[type] ?? [50, 5];
    metrics[`VITALS_BASELINE:${type}`] = vitalsBaseline(type, center, spread);
  }
  for (const { metric } of SECTION_MOBILITY) {
    metrics[metric] = insufficient(metric);
  }
  return metrics;
}

/**
 * Route-mock a populated Insights overview onto `page`.
 *
 * Only the reads that decide whether a section renders AT ALL are stubbed;
 * everything else (the i18n bundle, every layout decision, the real component
 * tree) stays authentic, so the geometry under test is the shipped geometry.
 */
export async function mockPopulatedInsights(
  page: Page,
  options: { everyState?: boolean } = {},
): Promise<void> {
  // Without a non-empty comprehensive payload the page short-circuits to its
  // "no data yet" empty state and no section mounts at all.
  // RegExp matchers throughout, not globs: Playwright's URL glob treats `?` as
  // a single-character wildcard, so `**/api/insights/derived?*` also matches
  // `/api/insights/derived/batch?…` and the two handlers shadow each other.
  await page.route(/\/api\/insights\/comprehensive(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          totalMeasurements: 4821,
          moodSummary: { count: 96 },
          medications: [{ id: "med-1" }, { id: "med-2" }, { id: "med-3" }],
        },
        error: null,
      }),
    }),
  );

  // The batched derived read behind the wellness strip + the vitals grid.
  await page.route(/\/api\/insights\/derived\/batch(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { metrics: buildBatchMetrics() },
        error: null,
      }),
    }),
  );

  // The hero band's score column. The real response is fetched and the score
  // injected into it, so every OTHER field the page reads off `/api/analytics`
  // stays authentic and this fixture cannot silently blank a section it was
  // never meant to touch.
  await page.route(/\/api\/analytics(\?|$)/, async (route) => {
    const response = await route.fetch();
    let payload: { data?: Record<string, unknown> | null; error?: unknown };
    try {
      payload = await response.json();
    } catch {
      payload = { data: {}, error: null };
    }
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({
        ...payload,
        data: {
          ...(payload.data ?? {}),
          healthScore: healthScoreReport(options.everyState === true),
        },
      }),
    });
  });

  // The health score's course under its panel, from the store its delta is
  // read from. The other scores fall through to the real handler.
  await page.route(/\/api\/insights\/score-history\?/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("score") !== "HEALTH_SCORE") {
      return route.fallback();
    }
    const days = Number(url.searchParams.get("days"));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          score: "HEALTH_SCORE",
          days,
          points: healthScoreHistoryPoints(days),
          band: { lo: 69, hi: 76, n: 29 },
        },
        error: null,
      }),
    });
  });

  // The single-metric derived route. Only COINCIDENT_DEVIATION is stubbed —
  // it is the card whose heading carries the provenance sentence. Any other
  // metric falls through to the real handler.
  await page.route(/\/api\/insights\/derived\?/, async (route) => {
    const metric = new URL(route.request().url()).searchParams.get("metric");
    if (metric !== "COINCIDENT_DEVIATION") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: COINCIDENT_FIRED, error: null }),
    });
  });
}
