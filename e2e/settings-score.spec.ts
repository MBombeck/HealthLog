import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { settleBeforeMeasure } from "./utils/settle";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import { healthScoreAlgorithmItemKey } from "@/lib/daily/priority-item-key";

/**
 * Settings → Health Score: the surface that decides which pillars count.
 *
 * Everything asserted here goes through stable `data-slot` / `data-*`
 * attributes rather than viewport-dependent text, so the spec keeps working
 * at any width and in any locale (only the copy assertions read English, and
 * the suite pins the English locale through the storage state).
 *
 * The refusal case is driven through the REAL write. Deselecting every
 * pillar genuinely fails the server's breadth rule, and a refused write
 * persists nothing, so the case leaves the shared account exactly as it
 * found it. Mocking the 422 would have proved that the page can render a
 * message, not that the rule is enforced or that the page reads the reason
 * the server actually sends.
 *
 * The analytics read IS mocked, because it is the page's secondary read and
 * the states it drives — waiting for data, safety signposting — depend on
 * what the seeded account happens to hold. Fixing it makes those two rows
 * deterministic without touching the write path under test.
 */

/** A slim Health Score report: only the fields the settings page reads. */
function scoreReport() {
  const coverage = {
    requiredInputs: 3,
    presentInputs: 2,
    historyDays: 14,
    missing: [],
  };
  const provenance = {
    inputs: [],
    source: "live",
    windowDays: 90,
    computedAt: new Date().toISOString(),
  };
  const insufficient = (reason: string) => ({
    status: "insufficient",
    reason,
    coverage,
    provenance,
  });
  return {
    composite: insufficient("no_usable_data"),
    pillars: [
      {
        id: "LIPIDS",
        domain: "cardiometabolic",
        result: insufficient("not_tracked"),
      },
      {
        id: "WELLBEING",
        domain: "wellbeing",
        result: insufficient("crisis_signposting"),
      },
      {
        id: "BLOOD_PRESSURE",
        domain: "cardiometabolic",
        result: insufficient("read_failed"),
      },
    ],
    delta: null,
    deltaReason: "no_current_score",
    scoreVersion: SCORE_VERSION,
    weightGoal: insufficient("no_goal"),
    // Raised and never dismissed, which is the state every account is in:
    // nothing has ever rendered this notice.
    algorithmNotice: {
      itemKey: healthScoreAlgorithmItemKey(SCORE_VERSION),
      dismissed: false,
    },
  };
}

async function mockAnalytics(page: import("@playwright/test").Page) {
  await page.route(/\/api\/analytics(\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { summaries: {}, healthScore: scoreReport() },
        error: null,
      }),
    });
  });
}

test.describe("Settings → Health Score", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await mockAnalytics(page);
  });

  test("groups the pillars by area and makes the three axes legible", async ({
    page,
  }) => {
    await page.goto("/settings/score", { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-slot="score-config-card"]');
    await settleBeforeMeasure(page, card);

    // The heading the settings IA requires, owned by the shell and not
    // re-declared inside the card; a Settings page has no subheading (1.50). The shell renders the pair
    // twice under distinct ids — `…-title` inside a `hidden md:block` column
    // and `…-title-mobile` inside an `md:hidden` one — so exactly one of them
    // is on screen at any width. Asserting the desktop id alone passed on the
    // wide project and failed on the narrow one against a heading that is
    // hidden by design.
    const heading = page
      .locator(
        "#settings-section-score-title, #settings-section-score-title-mobile",
      )
      .filter({ has: page.locator(":scope:visible") });
    await expect(heading).toHaveCount(1);
    await expect(heading.first()).toBeVisible();
    await expect(
      heading.first().locator("xpath=following-sibling::p[1]"),
    ).toHaveCount(0);

    // One concept, one card. A second card beside it would be the
    // top/bottom split of one decision the rules forbid; the notice is a
    // different concept and is allowed its own.
    await expect(page.locator('[data-slot="score-config-card"]')).toHaveCount(
      1,
    );

    // The cardiometabolic triple. The list is flat (no group headings) — the
    // rows carry their domain, so the three cardiometabolic pillars are found
    // on the row itself.
    const cardio = page.locator(
      '[data-slot="score-pillar-row"][data-domain="cardiometabolic"]',
    );
    await expect(cardio).toHaveCount(3);

    // The rows say nothing about recording or showing — the card says it
    // once, above them, and the modules screen owns those two questions.
    const rows = page.locator('[data-slot="score-pillar-row"]');
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(page.locator('[data-slot="score-pillar-axes"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[data-slot="score-config-three-axes"]'),
    ).toContainText("keeps being recorded");
  });

  test("offers a switch on every pillar it lists", async ({ page }) => {
    await page.goto("/settings/score", { waitUntil: "domcontentloaded" });
    const rows = page.locator('[data-slot="score-pillar-row"]');
    await settleBeforeMeasure(page, rows.first());

    // Nothing on this page is a choice the person cannot make. The pillar
    // that could never score was removed from the catalogue rather than
    // listed as an inert row.
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    await expect(page.locator('[data-slot="score-pillar-switch"]')).toHaveCount(
      rowCount,
    );
    await expect(
      page.locator('[data-slot="score-pillar-row"][data-pillar="FITNESS"]'),
    ).toHaveCount(0);
  });

  test("tells waiting for data apart from safety guidance and a failed read", async ({
    page,
  }) => {
    await page.goto("/settings/score", { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-slot="score-config-card"]');
    await settleBeforeMeasure(page, card);

    const state = (pillar: string) =>
      page.locator(
        `[data-slot="score-pillar-row"][data-pillar="${pillar}"] [data-slot="score-pillar-state"]`,
      );

    await expect(state("LIPIDS")).toHaveAttribute("data-state", "waiting");
    // Safety signposting is its own state and never a configuration error.
    await expect(state("WELLBEING")).toHaveAttribute("data-state", "crisis");
    // A failed read is a failure, not absence.
    await expect(state("BLOOD_PRESSURE")).toHaveAttribute(
      "data-state",
      "read_failed",
    );
  });

  test("renders the score notice and lets it be dismissed", async ({
    page,
  }) => {
    await page.goto("/settings/score", { waitUntil: "domcontentloaded" });
    const notice = page.locator('[data-slot="score-change-notice"]');
    await settleBeforeMeasure(page, notice);

    await expect(notice).toBeVisible();

    let dismissed: string | null = null;
    await page.route(/\/api\/daily\/digest\/dismiss$/, async (route) => {
      dismissed = String(route.request().postDataJSON()?.itemKey ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { dismissed: true }, error: null }),
      });
    });
    // The refetch after the dismissal has to come back already dismissed,
    // or the notice would simply be raised again and the test would be
    // asserting a race rather than the behaviour.
    await page.route(/\/api\/analytics(\?|$)/, async (route) => {
      const report = scoreReport();
      report.algorithmNotice.dismissed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { summaries: {}, healthScore: report },
          error: null,
        }),
      });
    });

    await notice.locator('[data-slot="score-change-notice-dismiss"]').click();

    await expect(notice).toHaveCount(0);
    expect(dismissed).toBe(healthScoreAlgorithmItemKey(SCORE_VERSION));
  });

  test("refuses a selection too narrow to produce a score, in plain language", async ({
    page,
  }) => {
    await page.goto("/settings/score", { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-slot="score-config-card"]');
    await settleBeforeMeasure(page, card);

    // v1.38 — this case used to deselect down to activity and wellbeing,
    // which the server refused as two areas with no physical
    // measurement. That selection saves and scores now, so it no longer
    // exercises a refusal at all. Take every pillar out instead: the
    // empty selection is the one the scorer genuinely cannot answer, and
    // it is what this spec exists to prove is enforced server-side.
    await page.locator('[data-slot="score-config-preset-all"]').click();
    const rows = page.locator('[data-slot="score-pillar-row"]');
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      if ((await row.getAttribute("data-counts")) === "false") continue;
      await row.locator('[data-slot="score-pillar-switch"]').click();
    }

    await page.locator('[data-slot="score-config-save"]').click();

    const refusal = page.locator('[data-slot="score-config-refusal"]');
    await expect(refusal).toBeVisible();
    await expect(refusal).toHaveAttribute("role", "alert");
    // The server's machine reason, rendered as a sentence a person can act
    // on, not as an error code and not as the server's English fallback.
    await expect(refusal).toContainText("at least one area of health");
    await expect(refusal).not.toContainText("_selected");
  });

  test("keeps the content column the same width as its neighbours", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-driven assertion; desktop project only",
    );
    await page.setViewportSize({ width: 1440, height: 900 });

    async function columnWidth(route: string, sentinel: string) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await settleBeforeMeasure(page, page.locator(sentinel));
      return page.evaluate(() => {
        const column = document.querySelector("section[aria-labelledby]");
        const grid = column?.closest("div.grid") ?? null;
        const cell = grid?.lastElementChild ?? null;
        return cell ? Math.round(cell.getBoundingClientRect().width) : -1;
      });
    }

    const modules = await columnWidth(
      "/settings/modules",
      '[data-slot="card"]',
    );
    const score = await columnWidth(
      "/settings/score",
      '[data-slot="score-config-card"]',
    );

    expect(modules).toBeGreaterThan(0);
    expect(Math.abs(score - modules)).toBeLessThanOrEqual(1);
  });
});
