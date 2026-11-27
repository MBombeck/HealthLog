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
import { settleBeforeMeasure, waitForFonts } from "./utils/settle";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const EVIDENCE_DIR = join(process.cwd(), "test-results", "v1341");

const NARRATIVE_DIGEST: DailyDigest = {
  generatedAt: "2026-07-29T08:30:00.000Z",
  ai: DIGEST_AI_AVAILABLE,
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
  // The lead talks about blood pressure, so the server keeps only the delta.
  signalLine: { headline: null, delta: "−12 mmHg vs. 30-Tage-Mittel" },
  briefingLead: LONG_HEADLINE_BRIEFING.paragraph,
  lead: { text: LONG_HEADLINE_BRIEFING.paragraph, source: "briefing" },
  today: [],
  restMode: null,
  line: LONG_HEADLINE_BRIEFING.paragraph,
  worthALook: [],
  asks: [],
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
  // The injected stylesheet can pull a font the page had not needed yet, so
  // the wait repeats after it. Bounded, for the reason `waitForFonts` gives.
  await waitForFonts(page);
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
    await mkdir(EVIDENCE_DIR, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    // The top of the dashboard reads the unified digest endpoint; a
    // deterministic reader keeps the capture stable. Without a morning read
    // the score row shows the Health score alone.
    await page.route(/\/api\/daily\/morning(\?|$)/, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      }),
    );
    await page.route(/\/api\/daily\/digest(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: NARRATIVE_DIGEST, error: null }),
      }),
    );
    await mockDashboardSnapshot(page, {
      briefing: LONG_HEADLINE_BRIEFING,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#main-content")).toBeVisible();
    const scores = page.locator('[data-slot="today-scores"]');
    await expect(scores).toHaveAttribute("data-tile-count", "1");
    await expect(
      scores
        .locator('[data-slot="today-score-tile"] [data-slot="score-ring"]')
        .getByText("84", { exact: true }),
    ).toHaveCount(1);
    await settleAndCapture(page, testInfo, "dashboard-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
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
