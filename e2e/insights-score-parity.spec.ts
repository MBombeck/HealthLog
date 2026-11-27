/**
 * 1.50 — every 0..100 score wears the same tile and opens the same page, on
 * the web as in the iPhone app: the head shows readiness, the sleep score,
 * the Health score, stress and strain as one family, an estimate labelled
 * as one; each score page reads assessment, then what counts (rows with
 * their weights, or the one sentence for a score without parts), then the
 * course. Checked in both themes, with axe over each surface.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";

test.use({ storageState: STORAGE_STATE_PATH });

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function themed(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("healthlog-theme", t);
    } catch {
      // A blocked store falls back to the media query below.
    }
  }, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await mockPopulatedInsights(page);
}

/** A strain served as an estimate, with its assessment, on its own page. */
async function serveStrain(page: Page) {
  const now = new Date().toISOString();
  await page.route(/\/api\/insights\/derived\?metric=STRAIN_SCORE/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          metric: "STRAIN_SCORE",
          status: "ok",
          value: {
            score: 46,
            band: "green",
            trendDelta: -3,
            daysInWindow: 12,
            asOf: now,
            series: [50, 52, 49, 47, 46],
            anchor: "personal",
            components: null,
            origin: "estimate",
            deviceSource: null,
          },
          coverage: {
            requiredInputs: 1,
            presentInputs: 1,
            historyDays: 12,
            missing: [],
          },
          confidence: { score: 90, band: "high" },
          provenance: {
            inputs: ["STRAIN_SCORE"],
            source: "DAY",
            windowDays: 14,
            computedAt: now,
          },
          reason: null,
          assessment: { text: "A lighter day than most.", updatedAt: now },
        },
        error: null,
      }),
    }),
  );
}

async function noViolations(page: Page, scope: string) {
  const results = await new AxeBuilder({ page })
    .include(scope)
    .withTags(WCAG)
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`score parity, ${theme}`, () => {
    test("the head shows every score as one family", async ({ page }) => {
      await themed(page, theme);
      await page.goto("/insights");
      const grid = page.locator('[data-slot="wellness-scores-grid"]');
      await expect(grid.locator('[data-metric="STRAIN_SCORE"]')).toBeVisible();
      const order = await grid
        .locator('[data-slot="wellness-score-tile"]')
        .evaluateAll((tiles) =>
          tiles.map((tile) => tile.getAttribute("data-metric")),
        );
      expect(order).toEqual([
        "READINESS",
        "HEALTH_SCORE",
        "STRESS_SCORE",
        "STRAIN_SCORE",
      ]);
      // The estimates carry a label, not a section of their own.
      await expect(
        grid.locator(
          '[data-metric="STRESS_SCORE"] [data-slot="wellness-score-origin"]',
        ),
      ).toBeVisible();
      await expect(page.locator('[data-slot="estimates-section"]')).toHaveCount(
        0,
      );
      await noViolations(page, '[data-slot="wellness-scores"]');
    });

    test("a score without parts says so in the place of the rows", async ({
      page,
    }) => {
      await themed(page, theme);
      await serveStrain(page);
      await page.goto("/insights/scores/strain");
      const anatomy = page.locator('[data-slot="score-anatomy-view"]');
      await expect(anatomy).toBeVisible();
      // The assessment leads, the anatomy follows.
      const assessment = page.getByText("A lighter day than most.");
      await expect(assessment).toBeVisible();
      const [first, second] = await Promise.all([
        assessment.boundingBox(),
        anatomy.boundingBox(),
      ]);
      expect(first!.y).toBeLessThan(second!.y);
      await expect(
        anatomy.locator('[data-slot="score-anatomy-no-factors"]'),
      ).toBeVisible();
      await expect(
        anatomy.locator('[data-slot="score-anatomy-origin"]'),
      ).toBeVisible();
      await noViolations(page, "#main-content");
    });

    test("the Health score lists its pillars with their weights", async ({
      page,
    }) => {
      await themed(page, theme);
      await page.goto("/insights/scores/health");
      const card = page.locator('[data-slot="health-score-card"]');
      const pillars = card.locator('[data-slot="health-score-contributors"]');
      await expect(pillars).toBeVisible();
      await expect(
        pillars.locator('[data-slot="health-score-pillar-value"]').first(),
      ).toContainText("25%");
      const [band, rows] = await Promise.all([
        card.locator('[data-slot="health-score-band"]').boundingBox(),
        pillars.boundingBox(),
      ]);
      // The lines that explain the number stand above what counts.
      expect(band!.y).toBeLessThan(rows!.y);
      await noViolations(page, "#main-content");
    });
  });
}
