/**
 * v1.42 — three surfaces made easier to live with.
 *
 *   - Documents: the display choice behind the wrench (cards or list, months
 *     stacked or flowing) persists per account; every delete asks first; the
 *     selection is cleared with an X on the count line.
 *   - Wellness scores: every score tile shows its course; a score's detail
 *     page carries its history right under the score card and no longer the
 *     warning-coloured "not clinical" line.
 *   - Mood insights: the calendar and the line chart appear together without
 *     moving the page, and logging is the header plus every Insights page
 *     uses.
 *
 * Everything is addressed through stable data attributes, never copy.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { ensureVaultFixture, seedNamespaceDocs } from "./setup/vault-fixture";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";

test.use({ storageState: STORAGE_STATE_PATH });

async function resetDocumentsLayout(page: Page): Promise<void> {
  const res = await page.request.put("/api/documents/inbound/layout", {
    data: { version: 1, view: "cards", arrangement: "stacked" },
  });
  expect(res.status()).toBe(200);
}

test.describe("documents", () => {
  test.beforeAll(async () => {
    await ensureVaultFixture();
  });

  test("the display choice behind the wrench persists across visits", async ({
    page,
    isMobile,
  }) => {
    // Both projects share one account; the layout is account state, so one
    // project owns this journey.
    test.skip(isMobile, "account-level preference; one project owns it");
    await resetDocumentsLayout(page);
    try {
      await page.goto("/documents");
      const timeline = page.locator('[data-slot="document-timeline"]');
      await expect(timeline).toHaveAttribute("data-view", "cards");
      await expect(timeline).toHaveAttribute("data-arrangement", "stacked");

      await page.locator('[data-slot="documents-customize"]').click();
      await expect(page).toHaveURL(/\/settings\/layout\/documents$/);
      const settings = page.locator('[data-slot="documents-layout-settings"]');
      await settings.locator('[data-slot="module-view-list"]').click();
      await expect(
        settings.locator('[data-slot="module-view-list"]'),
      ).toHaveAttribute("aria-pressed", "true");
      const flow = settings.locator('[data-slot="documents-arrangement-flow"]');
      // Wait for the write to land, so the reload below reads it back.
      const saved = page.waitForResponse(
        (r) =>
          r.url().includes("/api/documents/inbound/layout") &&
          r.request().method() === "PUT",
      );
      await flow.click();
      expect((await saved).status()).toBe(200);

      await page.goto("/documents");
      await expect(timeline).toHaveAttribute("data-view", "list");
      await expect(timeline).toHaveAttribute("data-arrangement", "flow");
      await expect(
        timeline
          .locator('[data-slot="document-card"][data-variant="row"]')
          .first(),
      ).toBeVisible();
      // Flowing: no month gets a row of its own, the name rides inline.
      await expect(
        timeline.locator('[data-slot="document-flow-month"]').first(),
      ).toBeVisible();

      // A fresh visit in a fresh page — the choice is the account's, not
      // this tab's.
      const second = await page.context().newPage();
      await second.goto("/documents");
      await expect(
        second.locator('[data-slot="document-timeline"]'),
      ).toHaveAttribute("data-arrangement", "flow");
      await second.close();
    } finally {
      await resetDocumentsLayout(page);
    }
  });

  test("bulk delete asks first, and cancelling deletes nothing", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "selection by checkbox is a pointer flow");
    await seedNamespaceDocs("qoldel", 2);
    await page.goto("/documents?q=qoldel");
    const box = page.getByRole("checkbox", { name: "Select qoldel 002" });
    await expect(box).toBeVisible();
    await box.click();

    let deletes = 0;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes("/api/documents/inbound/bulk") &&
        (req.postData() ?? "").includes('"delete"')
      ) {
        deletes += 1;
      }
    });

    const bar = page.locator('[data-slot="document-bulk-bar"]');
    await bar.locator('[data-slot="document-bulk-delete"]').click();
    const confirm = page.locator('[data-slot="documents-delete-confirm"]');
    await expect(confirm).toBeVisible();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(confirm).toBeHidden();
    expect(deletes).toBe(0);
    await expect(
      page.getByRole("button", { name: "Open qoldel 002" }),
    ).toBeVisible();

    await bar.locator('[data-slot="document-bulk-delete"]').click();
    await confirm.click();
    await expect(
      page.getByRole("button", { name: "Open qoldel 002" }),
    ).toBeHidden();
    expect(deletes).toBe(1);
  });

  test("the Delete key on a focused card asks first too", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "keyboard flow");
    await seedNamespaceDocs("qolkey", 1);
    await page.goto("/documents?q=qolkey");
    const open = page.getByRole("button", { name: "Open qolkey 001" });
    await expect(open).toBeVisible();
    await open.focus();
    await page.keyboard.press("Delete");
    await expect(
      page.locator('[data-slot="documents-delete-confirm"]'),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(open).toBeVisible();
  });

  test("the selection clears with the X on the count line", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "selection by checkbox is a pointer flow");
    await seedNamespaceDocs("qolclear", 2);
    await page.goto("/documents?q=qolclear");
    await page.getByRole("checkbox", { name: "Select qolclear 001" }).click();

    const bar = page.locator('[data-slot="document-bulk-bar"]');
    await expect(bar).toBeVisible();
    const count = bar.locator('[data-slot="document-bulk-count"]');
    const clear = bar.locator('[data-slot="document-bulk-clear"]');
    const actions = bar.locator('[data-slot="document-bulk-actions"]');

    // The X sits on the count line, at its right edge, above the action row,
    // and the action row follows the count line without a gap of its own.
    const [countBox, clearBox, actionsBox, barBox] = await Promise.all([
      count.boundingBox(),
      clear.boundingBox(),
      actions.boundingBox(),
      bar.boundingBox(),
    ]);
    expect(countBox && clearBox && actionsBox && barBox).toBeTruthy();
    const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
    expect(Math.abs(mid(clearBox!) - mid(countBox!))).toBeLessThan(6);
    expect(
      barBox!.x + barBox!.width - (clearBox!.x + clearBox!.width),
    ).toBeLessThan(20);
    expect(
      actionsBox!.y - (clearBox!.y + clearBox!.height),
    ).toBeLessThanOrEqual(10);
    // One action row: every verb shares a top edge.
    const tops = await actions
      .locator("button")
      .evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().top)),
      );
    expect(new Set(tops).size).toBe(1);

    await clear.click();
    await expect(bar).toBeHidden();
  });
});

test.describe("wellness scores", () => {
  test("every score tile shows its course", async ({ page }) => {
    await mockPopulatedInsights(page);
    await page.goto("/insights");
    for (const metric of ["RECOVERY_SCORE", "STRESS_SCORE"]) {
      const tile = page.locator(
        `[data-slot="wellness-score-tile"][data-metric="${metric}"]`,
      );
      await tile.scrollIntoViewIfNeeded();
      await expect(
        tile.locator('[data-slot="wellness-score-history"]'),
      ).toBeVisible();
    }
  });

  test("a score's detail page carries its history under the card, without the caveat line", async ({
    page,
  }) => {
    // The e2e account has no nightly score; serve one so the page has a
    // score to draw the history under.
    await page.route(
      /\/api\/insights\/derived\?metric=RECOVERY_SCORE/,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              metric: "RECOVERY_SCORE",
              status: "ok",
              value: {
                score: 66,
                band: "yellow",
                trendDelta: 2,
                daysInWindow: 5,
                asOf: new Date().toISOString(),
                series: [58, 61, 64, 60, 66],
                anchor: null,
                components: null,
              },
              coverage: {
                requiredInputs: 1,
                presentInputs: 1,
                historyDays: 5,
                missing: [],
              },
              confidence: { score: 80, band: "high" },
              provenance: {
                inputs: ["RECOVERY_SCORE"],
                source: "live",
                windowDays: 14,
                computedAt: new Date().toISOString(),
              },
              reason: null,
              assessment: null,
            },
            error: null,
          }),
        }),
    );
    await page.goto("/insights/scores/recovery");
    const anatomy = page.locator('[data-slot="score-anatomy-view"]');
    await expect(anatomy).toBeVisible();
    const history = page.locator('[data-slot="score-history-chart"]');
    await expect(history).toBeAttached();
    const [cardBox, historyBox] = await Promise.all([
      anatomy.boundingBox(),
      history.boundingBox(),
    ]);
    expect(historyBox!.y).toBeGreaterThan(cardBox!.y + cardBox!.height - 1);
    await expect(anatomy.locator(".text-warning")).toHaveCount(0);
  });
});

test.describe("mood insights", () => {
  test.beforeAll(async ({ browser }) => {
    // A short, real history, so the calendar and the chart both have days.
    const context = await browser.newContext({
      storageState: STORAGE_STATE_PATH,
    });
    const now = Date.now();
    for (let day = 1; day <= 12; day++) {
      const res = await context.request.post("/api/mood-entries", {
        data: {
          mood: day % 3 === 0 ? "OKAY" : "GUT",
          moodLoggedAt: new Date(now - day * 86_400_000).toISOString(),
          source: "MANUAL",
          externalId: `e2e-qol-mood-${day}`,
        },
      });
      expect([200, 201]).toContain(res.status());
    }
    await context.close();
  });

  test("the calendar and the chart appear together without moving the page", async ({
    page,
  }) => {
    // The calendar's read is the slower one in production; slow it down here
    // so the old order (chart first, calendar pushing it down) would show.
    await page.route(/\/api\/mood\/insights(\?|$)/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.continue();
    });
    await page.addInitScript(() => {
      const w = window as unknown as {
        __cls: number;
        __seen: Record<string, number>;
      };
      w.__cls = 0;
      w.__seen = {};
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<
          PerformanceEntry & { value: number; hadRecentInput: boolean }
        >) {
          if (!entry.hadRecentInput) w.__cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
      const watch = () => {
        if (
          !w.__seen.heatmap &&
          document.querySelector('[data-slot="mood-heatmap-day-list"]')
        )
          w.__seen.heatmap = performance.now();
        if (
          !w.__seen.chart &&
          document.querySelector(
            '[data-slot="insights-mood-chart"] .recharts-surface',
          ) &&
          !document.querySelector(
            '[data-slot="insights-mood-chart"] .invisible',
          )
        )
          w.__seen.chart = performance.now();
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });

    await page.goto("/insights/mood");
    await expect(
      page.locator('[data-slot="mood-heatmap-day-list"]'),
    ).toBeAttached({
      timeout: 15_000,
    });
    await expect(
      page
        .locator('[data-slot="insights-mood-chart"] .recharts-surface')
        .first(),
    ).toBeVisible();
    await page.waitForTimeout(1_500);

    const { cls, seen } = await page.evaluate(() => {
      const w = window as unknown as {
        __cls: number;
        __seen: Record<string, number>;
      };
      return { cls: w.__cls, seen: w.__seen };
    });
    expect(cls).toBeLessThan(0.02);
    expect(seen.heatmap).toBeDefined();
    expect(seen.chart).toBeDefined();
    // Together: within a couple of frames of each other.
    expect(Math.abs(seen.heatmap - seen.chart)).toBeLessThan(100);
  });

  test("logging is the header plus, not a text link", async ({ page }) => {
    await page.goto("/insights/mood");
    const add = page.locator(
      '[data-slot="insights-mood-add"][data-header-add]',
    );
    await expect(add).toBeVisible();
    await expect(
      page.locator('[data-slot="insights-mood-log-link"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-slot="insights-mood-mental-wellbeing-link"]'),
    ).toHaveCount(0);
    await add.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
