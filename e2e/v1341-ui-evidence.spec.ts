import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { DailyDigest } from "@/lib/daily/digest";
import { SCORE_VERSION } from "@/lib/analytics/score/types";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  LONG_HEADLINE_BRIEFING,
  mockDashboardSnapshot,
} from "./utils/mock-dashboard-snapshot";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";
import { settleBeforeMeasure } from "./utils/settle";

const EVIDENCE_DIR = join(process.cwd(), "test-results", "v1341");

const NARRATIVE_DIGEST: DailyDigest = {
  generatedAt: "2026-07-29T08:30:00.000Z",
  phase: "final",
  sleepPending: false,
  score: {
    value: 84,
    band: "green",
    delta: -2,
    deltaReason: null,
    scoreVersion: SCORE_VERSION,
    composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
  },
  topSignal: LONG_HEADLINE_BRIEFING.signalsOfDay?.[0] ?? null,
  briefingLead: LONG_HEADLINE_BRIEFING.paragraph,
  line: LONG_HEADLINE_BRIEFING.paragraph,
  worthALook: [],
  justIn: null,
  reactionLine: null,
};

async function settleAndCapture(
  page: Page,
  testInfo: TestInfo,
  filename: string,
): Promise<void> {
  await settleBeforeMeasure(page, page.locator("#main-content"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  });
  await page.evaluate(() => document.fonts?.ready);
  const path = join(EVIDENCE_DIR, filename);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(filename, { path, contentType: "image/png" });
}

test.describe("v1.34.1 deterministic UI evidence", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "one canonical capture per named evidence file",
    );
  });

  test("captures the five release-review surfaces", async ({
    page,
  }, testInfo) => {
    // Five full page loads and five captures in one case, deliberately: the
    // evidence set is only comparable if every shot comes from one consistent
    // state, so splitting it into five cases would defeat its purpose. That is
    // five times the work of an ordinary case against the same default budget,
    // and it timed out twice on loaded runners while passing everywhere else.
    //
    // This raises the wall-clock allowance to match the work, and nothing else.
    // Every capture still has to happen and still has to succeed; no assertion
    // is relaxed. If this case starts timing out again, the honest reading is a
    // real slowdown in one of the five surfaces, not a budget to raise further.
    test.slow();

    await mkdir(EVIDENCE_DIR, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    let dailyDigest = NARRATIVE_DIGEST;
    // TodayHero reads the unified digest endpoint, not the dashboard
    // snapshot's legacy briefing field. Keep a mutable, deterministic reader
    // so this evidence covers both the narrative composition captured below
    // and the compact score-only fallback through the exact production seam.
    await page.route(/\/api\/daily\/digest(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: dailyDigest, error: null }),
      }),
    );
    await mockDashboardSnapshot(page, {
      briefing: LONG_HEADLINE_BRIEFING,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#main-content")).toBeVisible();
    const hero = page.locator('[data-slot="today-hero"]');
    await expect(hero).toHaveAttribute("data-layout", "narrative");
    await expect(hero.locator('[data-slot="today-hero-lead"]')).toContainText(
      "Dein systolischer Blutdruck",
    );
    await expect(hero.locator('[data-slot="score-ring"]')).toHaveCSS(
      "width",
      "168px",
    );
    await settleAndCapture(page, testInfo, "dashboard-desktop.png");

    dailyDigest = {
      ...NARRATIVE_DIGEST,
      topSignal: null,
      briefingLead: null,
      line: "Dein Gesundheitsscore liegt heute bei 84.",
      reactionLine: null,
    };
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(hero).toHaveAttribute("data-layout", "compact-all-clear");
    await expect(hero.locator('[data-slot="today-hero-lead"]')).toHaveCount(0);
    await expect(
      hero.locator('[data-slot="today-hero-all-clear"]'),
    ).toBeVisible();
    await expect(hero.locator('[data-slot="score-ring"]')).toHaveCSS(
      "width",
      "120px",
    );
    await expect(
      hero.locator('[data-slot="score-ring"]').getByText("84", { exact: true }),
    ).toHaveCount(1);
    await settleAndCapture(page, testInfo, "dashboard-score-only-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    const compactHeroBox = await hero.boundingBox();
    expect(compactHeroBox).not.toBeNull();
    expect(
      compactHeroBox?.width ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await mockPopulatedInsights(page);
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-slot="insights-tab-strip"]'),
    ).toBeVisible();
    await settleAndCapture(page, testInfo, "insights-mobile.png");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings/anamnesis", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settleAndCapture(page, testInfo, "anamnesis-desktop.png");

    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto("/settings/account", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settleAndCapture(page, testInfo, "settings-short-desktop.png");

    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/admin/system-status", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settleAndCapture(page, testInfo, "admin-tablet.png");
  });
});
