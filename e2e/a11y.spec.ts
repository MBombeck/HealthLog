import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { POPULATED_SUMMARIES } from "./utils/mock-dashboard-snapshot";

type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

type Theme = "light" | "dark";

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

const fixedMeasurementRows = Array.from({ length: 10 }, (_, index) => ({
  id: `a11y-measurement-${index}`,
  type: "WEIGHT",
  value: 78.5 + (index % 3) - 1,
  measuredAt: `2026-07-${String(20 - index).padStart(2, "0")}T08:00:00.000Z`,
  source: "MANUAL",
  notes: null,
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
      entries: [{ date: "2026-07-20", score: 4 }],
      summary: { count: 1 },
    }),
  );

  await page.route("**/api/mood/insights", (route) =>
    fulfilJson(route, {
      summary: { count: 1 },
      tagBreakdown: [],
      trends: [],
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
    name: "/insights/weight metric subpage",
    path: "/insights/weight",
    painted: (page) => page.locator(".recharts-wrapper").first(),
  },
  {
    name: "/insights/workouts list",
    path: "/insights/workouts",
    painted: (page) =>
      page
        .locator(
          '#main-content [data-slot="workout-list"], #main-content [role="status"]',
        )
        .first(),
  },
  {
    name: "/insights/workouts/:id detail",
    path: `/insights/workouts/${A11Y_WORKOUT_ID}`,
    painted: (page) => page.locator('[data-slot="workout-detail-header"]'),
  },
  {
    name: "/coach",
    path: "/coach",
    painted: (page) => page.locator('[data-slot="coach-page"]').first(),
  },
];

const RECORD_ROUTES: readonly RouteCase[] = [
  {
    name: "/measurements",
    path: "/measurements",
    painted: (page) => page.locator('[data-slot="filter-bar"]'),
  },
  {
    name: "/mood",
    path: "/mood",
    painted: (page) => page.locator('[data-slot="filter-bar"]'),
  },
  {
    name: "/medications",
    path: "/medications",
    painted: (page) => page.getByRole("heading", { level: 1 }).first(),
  },
  {
    name: "/labs",
    path: "/labs",
    painted: (page) => page.getByText("A11y LDL").first(),
  },
  {
    name: "/documents compact panel",
    path: "/documents?view=compact",
    painted: (page) => page.getByText("A11y blood panel").first(),
  },
];

const ADMIN_AND_BASELINE_ROUTES: readonly RouteCase[] = [
  {
    name: "/admin/app-logs",
    path: "/admin/app-logs",
    painted: (page) => page.getByText("a11y.paint").first(),
  },
  {
    name: "/admin/backups",
    path: "/admin/backups",
    painted: (page) =>
      page.getByText("a11y-backup-user", { exact: true }).filter({
        visible: true,
      }),
  },
  {
    name: "/ dashboard",
    path: "/",
    painted: (page) => page.locator("#main-content"),
  },
  {
    name: "/settings/integrations",
    path: "/settings/integrations",
    painted: (page) => page.getByRole("heading", { level: 1 }).first(),
  },
  {
    name: "/admin overview",
    path: "/admin",
    painted: (page) => page.getByRole("heading", { level: 1 }).first(),
  },
  {
    name: "/admin/system-status",
    path: "/admin/system-status",
    painted: (page) => page.getByRole("heading", { level: 1 }).first(),
  },
  {
    name: "/admin/users",
    path: "/admin/users",
    painted: (page) => page.getByRole("heading", { level: 1 }).first(),
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
        page.getByRole("main"),
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
        await expect(page.getByText("A11y LDL").first()).toBeVisible({
          timeout: 15_000,
        });
        await page
          .locator('#main-content [data-slot="dropdown-menu-trigger"]')
          .first()
          .click();
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
        await page
          .locator('#main-content [data-slot="dropdown-menu-trigger"]')
          .first()
          .click();
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
