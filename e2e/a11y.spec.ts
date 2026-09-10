import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { openMenu } from "./open-menu";
import { POPULATED_SUMMARIES } from "./utils/mock-dashboard-snapshot";

type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

type Theme = "light" | "dark";

/**
 * One scan target: where to go, and what has to be on screen before axe is
 * allowed to look.
 *
 * The `painted` locator is the whole contract of this file. A scan that runs
 * against a page whose content has not arrived reports violations the app does
 * not have — "page must have a level-one heading" against a page that has one,
 * a moment later — and that reads as a product defect until somebody re-runs
 * it. Two rules keep the sentinel honest, and both were learned from a case
 * that broke them:
 *
 *  1. It must name something the PAGE renders once its data is there, never
 *     something the shell or a skeleton also carries. `#main-content` is the
 *     app frame and exists before the route paints anything; `[role="status"]`
 *     is on every busy placeholder; a filter rail renders next to the loading
 *     silhouettes it filters. Each of those is a coin flip, not a wait.
 *  2. It must not be the thing the scan asserts. Waiting for `<h1>` and then
 *     letting axe check that an `<h1>` exists is a check that cannot fail —
 *     strictly worse than the flake, because a page that really lost its
 *     heading would wait out the timeout under a misleading name instead of
 *     failing the rule. Every case here gates on content that lives in a
 *     different component from the heading, so dropping the heading still
 *     fails the scan.
 */
type RouteCase = {
  name: string;
  path: string;
  painted: (page: Page) => Locator;
};

const THEMES: readonly Theme[] = ["light", "dark"];
const WCAG_TAGS: Record<string, true> = {
  wcag2a: true,
  wcag2aa: true,
  wcag21a: true,
  wcag21aa: true,
};
const SEMANTIC_RULES: Record<string, true> = {
  "heading-order": true,
  "page-has-heading-one": true,
  "landmark-one-main": true,
  "landmark-unique": true,
  region: true,
};
const A11Y_WORKOUT_ID = "a11y-workout";
const A11Y_CONVERSATION_ID = "a11y-conversation";
const A11Y_DOCUMENT_ID = "a11y-document";

// Ten daily rows ending half a day before now. The chart range tabs are
// calendar-day windows anchored on now (v1.37.29), so absolute-dated rows
// age out of the default window — the weight sub-page would render its
// empty state and the `.recharts-wrapper` painted gate would never fire.
const fixedMeasurementRows = Array.from({ length: 10 }, (_, index) => ({
  id: `a11y-measurement-${index}`,
  type: "WEIGHT",
  value: 78.5 + (index % 3) - 1,
  measuredAt: new Date(
    Date.now() - 12 * 3_600_000 - index * 86_400_000,
  ).toISOString(),
  source: "MANUAL",
  notes: null,
}));

// Ten daily mood scores ending yesterday, anchored for the same reason the
// measurement rows above are: the mood chart windows by calendar day and
// withholds its line below three DISTINCT days, so a fixed date left the mood
// sub-page painting its sparse placeholder. The scan's painted gate was then
// satisfied by a different chart on the page, and the mood line — the reason
// the case exists — was never waited for and might never have been scanned.
const fixedMoodEntries = Array.from({ length: 10 }, (_, index) => ({
  date: new Date(Date.now() - (index + 1) * 86_400_000)
    .toISOString()
    .slice(0, 10),
  score: 3 + (index % 3) * 0.5,
  samples: 1,
}));

const workoutListEntry = {
  id: A11Y_WORKOUT_ID,
  sportType: "running",
  startedAt: "2026-07-20T07:00:00.000Z",
  endedAt: "2026-07-20T07:30:00.000Z",
  durationSec: 1800,
  distanceM: 5200,
  activeEnergyKcal: 320,
  avgHr: 145,
  maxHr: 170,
  source: "APPLE_HEALTH",
  externalId: "a11y-workout-external",
  hasRoute: true,
  hasHrSeries: true,
};

const workoutDetail = {
  ...workoutListEntry,
  minHr: 110,
  stepCount: 5800,
  elevationM: 12.5,
  pauseDurationSec: null,
  metadata: null,
  route: {
    geometry: {
      type: "LineString",
      coordinates: Array.from({ length: 20 }, (_, index) => [
        11 + index * 0.0004,
        50 + index * 0.0003,
      ]),
    },
    sampleTimestamps: null,
  },
  samples: { sampleCount: 20, samples: null },
  hrSeries: {
    source: "pulse_window",
    bucketSec: 8,
    points: [
      { tSec: 0, mean: 130, min: 125, max: 135 },
      { tSec: 8, mean: 140, min: 135, max: 145 },
      { tSec: 16, mean: 150, min: 145, max: 155 },
    ],
    envelope: false,
  },
  zones: {
    model: "tanaka",
    hrMax: 180,
    zones: [
      { zone: 1, lowBpm: 90, highBpm: 108, seconds: 300 },
      { zone: 2, lowBpm: 109, highBpm: 126, seconds: 420 },
      { zone: 3, lowBpm: 127, highBpm: 144, seconds: 540 },
      { zone: 4, lowBpm: 145, highBpm: 162, seconds: 360 },
      { zone: 5, lowBpm: 163, highBpm: null, seconds: 180 },
    ],
  },
  splits: [
    { km: 1, durationSec: 340, paceSecPerKm: 340 },
    { km: 2, durationSec: 345, paceSecPerKm: 345 },
  ],
  sportContext: {
    count: 8,
    avgDurationSec: 2040,
    avgDistanceM: 5800,
    avgAvgHr: 148,
  },
  aiInsight: null,
  canonicalId: A11Y_WORKOUT_ID,
  dayKey: "2026-07-20",
  previousWorkoutId: null,
};

const medication = {
  id: "a11y-medication",
  name: "A11y medication",
  dose: "10 mg",
  category: "OTHER",
  active: true,
  notificationsEnabled: true,
  pausedAt: null,
  lastTakenAt: null,
  startsOn: null,
  endsOn: null,
  oneShot: false,
  schedules: [
    {
      id: "a11y-medication-schedule",
      windowStart: "08:00",
      windowEnd: "09:00",
      label: null,
      dose: null,
      daysOfWeek: null,
      timesOfDay: ["08:00"],
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      reminderGraceMinutes: null,
    },
  ],
};

const inboundDocument = {
  id: A11Y_DOCUMENT_ID,
  kind: "LAB_RESULT",
  title: "A11y blood panel",
  filename: "a11y-blood-panel.txt",
  mimeType: "text/plain",
  byteSize: 2048,
  status: "CONFIRMED",
  providerType: "mock",
  reportDate: "2026-07-19",
  documentDate: "2026-07-19",
  errorReason: null,
  factCount: 0,
  pendingCount: 0,
  conditionLinks: [],
  encounterLinks: [],
  servingClass: "attachment",
  hasContentIndex: true,
  contentIndexSource: "vision",
  hasThumbnail: false,
  createdAt: "2026-07-19T12:00:00.000Z",
  updatedAt: "2026-07-19T12:00:00.000Z",
};

function fulfilJson(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

function reportBlocking(label: string, blocking: AxeViolation[]) {
  if (blocking.length === 0) return;
  console.log(
    `axe violations for ${label}:\n${blocking
      .map(
        (violation) =>
          `  - [${violation.impact}] ${violation.id}: ${violation.help}\n` +
          `    ${violation.helpUrl}\n` +
          violation.nodes
            .map(
              (node, index) =>
                `    node ${index + 1}: ${node.target.join(" ")}\n` +
                `      ${node.failureSummary ?? "No failure summary supplied."}\n` +
                `      html: ${node.html}`,
            )
            .join("\n"),
      )
      .join("\n")}`,
  );
}

async function runAxe(page: Page): Promise<AxeViolation[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();

  return results.violations.filter((violation) => {
    if (SEMANTIC_RULES[violation.id]) {
      return (
        violation.impact === "moderate" ||
        violation.impact === "serious" ||
        violation.impact === "critical"
      );
    }
    const isWcagRule = violation.tags.some((tag) => WCAG_TAGS[tag]);
    return (
      isWcagRule &&
      (violation.impact === "serious" || violation.impact === "critical")
    );
  });
}

async function useExplicitTheme(page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((explicitTheme: Theme) => {
    window.localStorage.setItem("healthlog-theme", explicitTheme);
  }, theme);
}

async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator("html")).toHaveClass(
    new RegExp(`(^|\\s)${theme}(\\s|$)`),
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("healthlog-theme")))
    .toBe(theme);
}

async function scanPaintedState(
  page: Page,
  theme: Theme,
  label: string,
  painted: Locator,
): Promise<AxeViolation[]> {
  await expect(painted).toBeVisible({ timeout: 15_000 });
  await page.evaluate(async () => {
    const finiteAnimations = document
      .getAnimations()
      .filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity,
      );
    const { promise: animationTimeout, resolve } =
      Promise.withResolvers<void>();
    window.setTimeout(resolve, 500);
    await Promise.race([
      Promise.allSettled(
        finiteAnimations.map((animation) => animation.finished),
      ),
      animationTimeout,
    ]);
  });
  await expectTheme(page, theme);
  const blocking = await runAxe(page);
  reportBlocking(`${theme} ${label}`, blocking);
  return blocking;
}

function expectNoViolations(
  theme: Theme,
  label: string,
  blocking: AxeViolation[],
) {
  expect(blocking, `${theme} ${label} accessibility violations`).toHaveLength(
    0,
  );
}

async function visitAndScan(
  page: Page,
  theme: Theme,
  routeCase: RouteCase,
): Promise<AxeViolation[]> {
  return test.step(`${theme} ${routeCase.name}`, async () => {
    await page.goto(routeCase.path, { waitUntil: "domcontentloaded" });
    return scanPaintedState(
      page,
      theme,
      routeCase.name,
      routeCase.painted(page),
    );
  });
}

async function installA11yMocks(page: Page) {
  await page.route(/\/api\/analytics(\?|$)/, (route) =>
    fulfilJson(route, {
      summaries: POPULATED_SUMMARIES,
      bpInTargetPct: 80,
      glucoseByContext: {},
    }),
  );

  await page.route("**/api/mood/analytics", (route) =>
    fulfilJson(route, {
      entries: fixedMoodEntries,
      summary: { count: fixedMoodEntries.length },
    }),
  );

  // Matches the current `MoodInsightsResponse` (mood-insights-shared.tsx): the
  // sections short-circuit on `summary.totalEntries === 0` and then read
  // `heatmap.cells`, so `totalEntries` and a populated `heatmap` are both
  // required or the page throws into its error boundary. Breakdown arrays are
  // present-but-empty; the correlations block carries every metric key.
  await page.route("**/api/mood/insights", (route) =>
    fulfilJson(route, {
      summary: { totalEntries: fixedMoodEntries.length, inTargetPct: null },
      heatmap: { windowDays: 30, cells: fixedMoodEntries },
      distribution: [],
      weekday: [],
      timeOfDay: { buckets: [], reliable: false, best: null, worst: null },
      stability: null,
      tags: [],
      structuredTags: [],
      narratives: [],
      correlations: {
        sleep: { result: null, points: [], n: 0 },
        steps: { result: null, points: [], n: 0 },
        pulse: { result: null, points: [], n: 0 },
        weight: { result: null, points: [], n: 0 },
        bloodPressureSystolic: { result: null, points: [], n: 0 },
      },
    }),
  );

  await page.route("**/api/mood/tags*", (route) =>
    fulfilJson(route, { groups: [], tags: [] }),
  );

  await page.route("**/api/mood-entries*", (route) =>
    fulfilJson(route, {
      entries: [
        {
          id: "a11y-mood",
          date: "2026-07-20",
          mood: "GUT",
          score: 4,
          tags: [],
          tagKeys: [],
          source: "MANUAL",
          moodLoggedAt: "2026-07-20T18:30:00.000Z",
          note: null,
        },
      ],
      meta: { total: 1 },
    }),
  );

  await page.route(/\/api\/measurements\/series-batch(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const types = (url.searchParams.get("types") ?? "WEIGHT").split(",");
    const series = Object.fromEntries(
      types.map((type) => [
        type,
        fixedMeasurementRows.map((row) => ({
          type,
          value: row.value,
          measuredAt: row.measuredAt,
          count: 1,
        })),
      ]),
    );
    return fulfilJson(route, { series });
  });

  await page.route("**/api/measurements*", (route) =>
    fulfilJson(route, {
      measurements: fixedMeasurementRows,
      meta: { total: fixedMeasurementRows.length },
    }),
  );

  await page.route("**/api/insights/comprehensive", (route) =>
    fulfilJson(route, {
      totalMeasurements: fixedMeasurementRows.length,
      moodSummary: { count: 1 },
    }),
  );

  // The workout detail page's day context reads the day's pulse shape and
  // the night the person woke from into it.
  await page.route("**/api/insights/pulse/intraday*", (route) =>
    fulfilJson(route, {
      dateKey: "2026-07-20",
      bucketMinutes: 10,
      series: [
        { startMinute: 420, mean: 62, count: 6, min: 58, max: 70 },
        { startMinute: 430, mean: 118, count: 6, min: 96, max: 141 },
      ],
      baseline: 58,
      baselineSource: "resting",
      tension: null,
      resolution: "dense",
    }),
  );

  await page.route("**/api/sleep/night*", (route) =>
    fulfilJson(route, {
      night: "2026-07-20",
      main: {
        night: "2026-07-20",
        source: "APPLE_HEALTH",
        start: "2026-07-19T22:10:00.000Z",
        end: "2026-07-20T05:45:00.000Z",
        asleepMinutes: 415,
        inBedMinutes: 455,
        awakeMinutes: 40,
        awakenings: 2,
        reconstructed: false,
        stages: {},
        segments: [],
        sourceDiscrepancy: null,
      },
      naps: [],
    }),
  );

  await page.route("**/api/workouts**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/workouts/${A11Y_WORKOUT_ID}`) {
      return fulfilJson(route, workoutDetail);
    }
    return fulfilJson(route, {
      workouts: [workoutListEntry],
      meta: {
        total: 1,
        limit: Number(url.searchParams.get("limit") ?? 100),
        offset: Number(url.searchParams.get("offset") ?? 0),
        droppedDuplicates: 0,
      },
    });
  });

  await page.route(/\/api\/insights\/chat(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/insights/chat/${A11Y_CONVERSATION_ID}`) {
      return fulfilJson(route, {
        id: A11Y_CONVERSATION_ID,
        title: "A11y evidence conversation",
        createdAt: "2026-07-20T09:00:00.000Z",
        updatedAt: "2026-07-20T09:01:00.000Z",
        messageCount: 2,
        fenced: false,
        attachments: [],
        documentTitle: null,
        attachmentCount: 0,
        summary: null,
        messages: [
          {
            id: "a11y-coach-user-message",
            role: "user",
            content: "How is my blood pressure trending?",
            createdAt: "2026-07-20T09:00:00.000Z",
            metricSource: null,
            providerType: null,
            promptVersion: null,
            tokensUsed: null,
            model: null,
          },
          {
            id: "a11y-coach-assistant-message",
            role: "assistant",
            content: "Your recent readings are steady.",
            createdAt: "2026-07-20T09:01:00.000Z",
            metricSource: {
              windows: ["last30days"],
              metrics: ["bp", "pulse"],
              counts: { bp: 12, pulse: 14 },
              keyValues: [
                {
                  label: "Average blood pressure",
                  value: "124/80",
                  unit: "mmHg",
                  window: "last 30 days",
                },
              ],
            },
            providerType: "mock",
            promptVersion: "a11y",
            tokensUsed: 42,
            model: "mock",
          },
        ],
      });
    }
    return fulfilJson(route, {
      conversations: [
        {
          id: A11Y_CONVERSATION_ID,
          title: "A11y evidence conversation",
          createdAt: "2026-07-20T09:00:00.000Z",
          updatedAt: "2026-07-20T09:01:00.000Z",
          messageCount: 2,
          fenced: false,
          attachments: [],
          documentTitle: null,
        },
      ],
      nextCursor: null,
    });
  });

  await page.route("**/api/insights/coach/nudge-status*", (route) =>
    fulfilJson(route, { nudgedAt: null, unread: false }),
  );
  await page.route("**/api/coach/about-me/questions*", (route) =>
    fulfilJson(route, { questions: [] }),
  );
  await page.route("**/api/auth/me/coach-prefs", (route) =>
    fulfilJson(route, {
      tone: "warm",
      verbosity: "default",
      excludeMetrics: [],
      showEvidenceByDefault: false,
      defaultWindow: "allTime",
    }),
  );

  await page.route("**/api/medications**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/medications/compliance") {
      return fulfilJson(route, []);
    }
    if (url.pathname === "/api/medications/layout") {
      return fulfilJson(route, { version: 1, view: "cards", order: [] });
    }
    if (url.pathname === "/api/medications") {
      return fulfilJson(route, [medication]);
    }
    return fulfilJson(route, {});
  });
  await page.route("**/api/settings/reminder-thresholds", (route) =>
    fulfilJson(route, {
      lowStockThreshold: null,
      lowStockRunwayDays: null,
      reorderLeadDays: null,
    }),
  );

  await page.route("**/api/labs/ocr/capability", (route) =>
    fulfilJson(route, {
      available: true,
      mode: "vision",
      reason: null,
      pdfSupported: true,
    }),
  );
  await page.route("**/api/labs?*", (route) =>
    fulfilJson(route, {
      results: [
        {
          id: "a11y-lab",
          biomarkerId: null,
          panel: "A11y panel",
          analyte: "A11y LDL",
          value: 2.4,
          valueText: null,
          unit: "mmol/L",
          referenceLow: 0,
          referenceHigh: 3,
          takenAt: "2026-07-19T12:00:00.000Z",
          source: "MANUAL",
          hasNote: false,
          rangeStatus: "inRange",
          createdAt: "2026-07-19T12:00:00.000Z",
          updatedAt: "2026-07-19T12:00:00.000Z",
        },
      ],
      meta: { total: 1, limit: 500, offset: 0 },
    }),
  );

  await page.route("**/api/documents/inbound**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/documents/inbound/usage") {
      return fulfilJson(route, {
        usedBytes: inboundDocument.byteSize,
        quotaBytes: 1_073_741_824,
        maxFileBytes: 26_214_400,
        acceptedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".webp"],
        linkedEpisodes: [],
        assistAvailable: true,
        contentIndex: { enabled: true, indexedCount: 1, totalCount: 1 },
      });
    }
    if (url.pathname === "/api/documents/inbound/capability") {
      return fulfilJson(route, {
        available: true,
        mode: "vision",
        reason: null,
        pdfSupported: true,
        egress: "local",
      });
    }
    if (url.pathname === `/api/documents/inbound/${A11Y_DOCUMENT_ID}/summary`) {
      return fulfilJson(route, {
        summary: "A deterministic summary of the A11y blood panel.",
      });
    }
    if (url.pathname === `/api/documents/inbound/${A11Y_DOCUMENT_ID}`) {
      return fulfilJson(route, {
        ...inboundDocument,
        facts: [],
        summary: "A stored summary of the A11y blood panel.",
        summaryGeneratedAt: "2026-07-19T12:05:00.000Z",
        summaryState: "READY",
      });
    }
    if (url.pathname === "/api/documents/inbound") {
      return fulfilJson(route, {
        documents: [inboundDocument],
        nextCursor: null,
      });
    }
    return fulfilJson(route, {});
  });
  await page.route("**/api/auth/me/documents-auto-ai-read", (route) =>
    fulfilJson(route, { documentsAutoAiRead: false }),
  );

  await page.route("**/api/admin/app-logs*", (route) =>
    fulfilJson(route, {
      events: [
        {
          timestamp: "2026-07-20T10:00:00.000Z",
          duration_ms: 24,
          request_id: "a11y-request",
          trace_id: "a11y-trace",
          level: "info",
          kind: "http",
          service: "web",
          environment: "test",
          http: {
            method: "GET",
            path: "/api/version",
            route: "/api/version",
            status: 200,
          },
          action: { name: "a11y.paint" },
        },
      ],
      meta: { total: 1, bufferMax: 500 },
    }),
  );
  await page.route("**/api/admin/backups", (route) =>
    fulfilJson(route, {
      rows: [
        {
          id: "a11y-backup",
          userId: "a11y-user",
          username: "a11y-backup-user",
          type: "WEEKLY_AUTO",
          sizeBytes: 4096,
          createdAt: "2026-07-20T03:00:00.000Z",
        },
      ],
      retentionDays: 30,
    }),
  );
}

const INSIGHTS_ROUTES: readonly RouteCase[] = [
  {
    name: "/insights overview",
    path: "/insights",
    painted: (page) =>
      page.locator('[data-slot="wellness-scores"]').filter({
        has: page.locator(
          '[data-slot="wellness-scores-grid"]:not([aria-busy="true"])',
        ),
      }),
  },
  {
    // `.recharts-wrapper` is a class the charting library writes, not a
    // contract this repository keeps, and it is shared by every chart on the
    // page — so the gate could be satisfied by a chart other than the one the
    // route exists to render, and it moves whenever the library's markup does.
    // `chart-plot` is the measurement chart's own slot and the data branch is
    // the only branch that renders it: an empty window paints `ChartEmptyState`
    // instead and this scan still waits, which is what it is for.
    name: "/insights/weight metric subpage",
    path: "/insights/weight",
    painted: (page) => page.locator('[data-slot="chart-plot"]').first(),
  },
  {
    // Mood is event-driven, so its sub-page renders the heatmap and the mood
    // line chart from `/api/mood/insights` rather than a MeasurementType series.
    // The mood chart carries the same `chart-plot` slot on the same terms, so
    // the scan waits for the heavy content to land here too.
    name: "/insights/mood metric subpage",
    path: "/insights/mood",
    painted: (page) => page.locator('[data-slot="chart-plot"]').first(),
  },
  {
    // The two states this page's OWN render produces: the list, or the
    // no-workouts empty state. Never `[role="status"]`, because the busy
    // skeletons carry it too (`chart-skeleton` in the streamed route shell is
    // one), so that selector matched the loading tree the server sends before
    // the page client has mounted anything. On a loaded runner the scan then
    // landed on a document whose only heading had not rendered yet and blamed
    // the app for a missing `<h1>` it does have.
    name: "/insights/workouts list",
    path: "/insights/workouts",
    painted: (page) =>
      page
        .locator(
          '#main-content [data-slot="workout-list"], #main-content [data-slot="empty-state"]',
        )
        .first(),
  },
  {
    name: "/insights/workouts/:id detail",
    path: `/insights/workouts/${A11Y_WORKOUT_ID}`,
    painted: (page) =>
      page.locator('[data-slot="workout-detail-header"]:visible'),
  },
  {
    // `coach-page` is the sizing wrapper around a `<Suspense fallback={null}>`,
    // so it is on screen while the conversation below it is still nothing at
    // all. Gate on the conversation surface itself.
    name: "/coach",
    path: "/coach",
    painted: (page) =>
      page.locator(
        '[data-slot="coach-conversation"][data-variant="page"]:visible',
      ),
  },
];

const RECORD_ROUTES: readonly RouteCase[] = [
  {
    // `filter-bar` is a sibling of the loading silhouettes, not their
    // successor — the rail renders above the list in every branch, so it was
    // on screen while the rows were still `measurement-list-loading`
    // rectangles. The rows wrapper exists only in the resolved, non-empty
    // branch, and both the desktop table and the mobile card list carry it.
    name: "/measurements",
    path: "/measurements",
    painted: (page) => page.locator('[data-slot="measurement-rows"]:visible'),
  },
  {
    // Same shape as /measurements, and the one this was measured on: under
    // an 8× CPU throttle `filter-bar` and `mood-list-loading` resolved in the
    // same 40 ms poll, the rows a poll later.
    name: "/mood",
    path: "/mood",
    painted: (page) => page.locator('[data-slot="mood-rows"]:visible'),
  },
  {
    // Was `getByRole("heading", { level: 1 })` — the axe rule's own query
    // used as its own precondition. The card carries the mocked medication's
    // id; `MedicationCardSkeleton` carries no id at all.
    name: "/medications",
    path: "/medications",
    painted: (page) => page.locator("[data-medication-id]").first(),
  },
  {
    name: "/labs",
    path: "/labs",
    painted: (page) => page.locator('[data-slot="lab-list"]:visible'),
  },
  {
    name: "/documents compact panel",
    path: "/documents?view=compact",
    painted: (page) =>
      page.locator(`[data-document-id="${A11Y_DOCUMENT_ID}"]`).first(),
  },
];

const ADMIN_AND_BASELINE_ROUTES: readonly RouteCase[] = [
  {
    name: "/admin/app-logs",
    path: "/admin/app-logs",
    painted: (page) => page.locator('[data-slot="app-log-rows"] tr').first(),
  },
  {
    name: "/admin/backups",
    path: "/admin/backups",
    painted: (page) => page.locator('[data-slot="backup-rows"]:visible'),
  },
  {
    // This one is why the whole file was swept. `#main-content` is the
    // authenticated shell's `<main>`: it is in the first HTML on every route,
    // it wraps whatever the segment happens to be streaming, and on `/` that
    // is `app/loading.tsx` — a silhouette with no heading in it. The scan was
    // therefore free to run against a document that legitimately had no `<h1>`
    // yet and report the app as missing one. Measured under an 8× CPU
    // throttle: `#main-content` at 759 ms, the tile strip at 4896 ms.
    //
    // The gate is the revealed chart cell rather than the tile strip because
    // an unrevealed cell is `invisible` AND `aria-hidden` — the chart cards
    // are simply not in the accessibility tree, so axe walks past the whole
    // chart row without reading it. Gating on the strip alone left it a
    // coin flip whether the row was scanned at all: locally the cells were
    // still hidden at strip time and revealed six seconds later, while the
    // runner that reported the heading-order break had already revealed
    // them. The row is the dashboard's largest surface; the scan has to see
    // it every time or not claim to have checked the page.
    name: "/ dashboard",
    path: "/",
    painted: (page) =>
      page
        .locator('[data-slot="dashboard-chart-cell"][data-revealed="true"]')
        .first(),
  },
  {
    // The settings heading belongs to `<SettingsShell>`, i.e. the chrome —
    // waiting on it says nothing about the section body below. The
    // connections panel is that body. This route has no data-gated content of
    // its own: every provider card renders immediately and fills in its
    // status pill later, so the panel's presence is the honest ceiling here.
    name: "/settings/integrations",
    path: "/settings/integrations",
    painted: (page) => page.locator('[data-slot="connections-panel"]:visible'),
  },
  {
    // The heading comes from `<AdminShell>` and is on screen while every card
    // under it is still a spinner. The audit list is the last card on the
    // overview and only exists once its query has answered.
    name: "/admin overview",
    path: "/admin",
    painted: (page) => page.locator('[data-slot="admin-audit-rows"]:visible'),
  },
  {
    name: "/admin/system-status",
    path: "/admin/system-status",
    painted: (page) => page.locator('[data-slot="system-status-grid"]:visible'),
  },
  {
    name: "/admin/users",
    path: "/admin/users",
    painted: (page) => page.locator('[data-slot="admin-user-rows"]:visible'),
  },
];

test.describe("axe-core public surfaces", () => {
  for (const theme of THEMES) {
    test(`theme=${theme} /auth/login`, async ({ page }) => {
      await useExplicitTheme(page, theme);
      await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
      const blocking = await scanPaintedState(
        page,
        theme,
        "/auth/login",
        // Not `getByRole("main")`: the public shell renders that landmark
        // around whatever the segment is streaming, so it is satisfied
        // before the login card itself exists. The action block is the
        // page's own.
        page.locator('[data-slot="login-actions"]:visible'),
      );
      expectNoViolations(theme, "/auth/login", blocking);
    });
  }
});

test.describe("axe-core authenticated route and state matrix", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const theme of THEMES) {
    test(`theme=${theme} routes: /insights, metric, workouts list/detail, /coach`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await useExplicitTheme(page, theme);
      await installA11yMocks(page);
      const blocking: AxeViolation[] = [];
      for (const routeCase of INSIGHTS_ROUTES) {
        blocking.push(...(await visitAndScan(page, theme, routeCase)));
      }
      expectNoViolations(theme, "insights route matrix", blocking);
    });

    test(`theme=${theme} routes: /measurements, /mood, /medications, /labs, /documents`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await useExplicitTheme(page, theme);
      await installA11yMocks(page);
      const blocking: AxeViolation[] = [];
      for (const routeCase of RECORD_ROUTES) {
        blocking.push(...(await visitAndScan(page, theme, routeCase)));
      }
      expectNoViolations(theme, "record route matrix", blocking);
    });

    test(`theme=${theme} routes: retained baseline + /admin/app-logs and /admin/backups`, async ({
      page,
    }) => {
      test.setTimeout(150_000);
      await useExplicitTheme(page, theme);
      await installA11yMocks(page);
      const blocking: AxeViolation[] = [];
      for (const routeCase of ADMIN_AND_BASELINE_ROUTES) {
        blocking.push(...(await visitAndScan(page, theme, routeCase)));
      }
      expectNoViolations(theme, "admin and retained route matrix", blocking);
    });

    test(`theme=${theme} open states: OCR picker, Coach evidence chips, medication dialog, document detail sheet`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await useExplicitTheme(page, theme);
      await installA11yMocks(page);
      const blocking: AxeViolation[] = [];

      await test.step(`${theme} /labs open OCR picker dialog`, async () => {
        await page.goto("/labs", { waitUntil: "domcontentloaded" });
        await expect(
          page.locator('[data-slot="lab-list"]:visible'),
        ).toBeVisible({
          timeout: 15_000,
        });
        await openMenu(
          page,
          page
            .locator('#main-content [data-slot="dropdown-menu-trigger"]')
            .first(),
        );
        await page.getByRole("menuitem").first().click();
        const sheet = page.locator('[data-slot="responsive-sheet-content"]');
        await expect(sheet.locator('input[type="file"]')).toHaveCount(1);
        blocking.push(
          ...(await scanPaintedState(
            page,
            theme,
            "/labs open OCR picker",
            sheet,
          )),
        );
      });

      await test.step(`${theme} /coach open evidence disclosure and source chips`, async () => {
        await page.goto(`/coach?c=${A11Y_CONVERSATION_ID}`, {
          waitUntil: "domcontentloaded",
        });
        const evidence = page.locator('[data-slot="coach-evidence"]').first();
        await expect(evidence).toBeVisible({ timeout: 15_000 });
        await evidence.locator("summary").click();
        await expect(evidence).toHaveAttribute("open", "");
        await expect(
          evidence.locator('[data-slot="coach-source-chips"]'),
        ).toBeVisible();
        blocking.push(
          ...(await scanPaintedState(
            page,
            theme,
            "/coach open evidence disclosure and source chips",
            evidence,
          )),
        );
      });

      await test.step(`${theme} /medications open representative wizard dialog`, async () => {
        await page.goto("/medications", { waitUntil: "domcontentloaded" });
        // axe scans the whole document, dialog and page behind it alike, so
        // the list has to have arrived before the dialog opens on top of it.
        await expect(page.locator("[data-medication-id]").first()).toBeVisible({
          timeout: 15_000,
        });
        await openMenu(
          page,
          page
            .locator('#main-content [data-slot="dropdown-menu-trigger"]')
            .first(),
        );
        await page.getByRole("menuitem").last().click();
        const dialog = page.locator('[data-slot="medication-wizard-dialog"]');
        blocking.push(
          ...(await scanPaintedState(
            page,
            theme,
            "/medications open wizard dialog",
            dialog,
          )),
        );
      });

      await test.step(`${theme} /documents compact detail sheet and summary panel`, async () => {
        await page.goto(`/documents?view=compact&doc=${A11Y_DOCUMENT_ID}`, {
          waitUntil: "domcontentloaded",
        });
        // Same reason as the medication dialog: the vault behind the sheet is
        // in the scan, so it has to be past `documents-loading` first.
        await expect(
          page.locator(`[data-document-id="${A11Y_DOCUMENT_ID}"]`).first(),
        ).toBeVisible({ timeout: 15_000 });
        const sheet = page.locator('[data-slot="responsive-sheet-content"]');
        await expect(sheet).toBeVisible({ timeout: 15_000 });
        await sheet.getByRole("button", { name: /summari/i }).click();
        const summary = sheet.locator('[data-slot="document-summary-panel"]');
        await expect(summary).toContainText("deterministic summary", {
          timeout: 15_000,
        });
        blocking.push(
          ...(await scanPaintedState(
            page,
            theme,
            "/documents compact detail sheet and summary panel",
            sheet,
          )),
        );
      });
      expectNoViolations(theme, "open state matrix", blocking);
    });
  }

  test("skip-link does not block logo click outside focus", async ({
    page,
    viewport,
  }) => {
    test.skip(
      (viewport?.width ?? 0) < 768,
      "desktop sidebar logo is hidden on mobile by design",
    );

    await installA11yMocks(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const logoLink = page
      .locator("a[href='/']")
      .filter({ hasText: "HealthLog" })
      .first();
    await expect(logoLink).toBeVisible();

    const logoBox = await logoLink.boundingBox();
    expect(logoBox).not.toBeNull();
    if (!logoBox) return;

    await logoLink.click({
      position: { x: logoBox.width / 2, y: logoBox.height / 2 },
    });
    await page.waitForURL(/\/$/);
  });
});
