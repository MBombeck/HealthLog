/**
 * Insights without AI (#975): switched off by the operator, or never set up.
 *
 * J1 — every AI capability `operator_disabled`, nothing configurable here.
 *      The overview renders its data sections; nothing AI-shaped paints, not
 *      even a hint; not one request goes to a route that calls a model or
 *      serves model text, and no request is answered 403.
 * J3 — no provider, one could be set up here. Exactly one calm setup hint on
 *      the overview, no Coach launcher or per-card Coach hand-off, and
 *      `/coach` goes back to the overview. Dismissing the hint in Settings →
 *      AI keeps it gone on the overview.
 *
 * Both states are served through the `ai` block of `/api/auth/me`
 * (`serveAiBlock`, which says why): the operator's switches are instance-wide
 * and a parallel spec would lose its AI under a real flip.
 *
 * Every assertion is addressed to a stable `data-*` attribute, never copy.
 */
import type { Page, Request, Response } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockUnavailable, serveAiBlock } from "./setup/ai-capabilities";
import { expect, test } from "./setup/test";
import { revealDeferredSectionsSettled } from "./utils/deferred-sections";

test.use({ storageState: STORAGE_STATE_PATH });

/**
 * Mount every overview section, then let their reads land. Sections past the
 * first three render as an empty sentinel until they near the viewport, so a
 * count of zero taken before this would pass whatever those sections paint.
 */
async function mountWholeOverview(page: Page): Promise<void> {
  await revealDeferredSectionsSettled(page);
}

/** Routes that call a model or serve model-written text. */
const AI_ROUTE = new RegExp(
  [
    "/api/insights/generate",
    "/api/insights/(weight|bmi|pulse|blood-pressure|mood|medication-compliance)-status",
    "/api/insights/metric-status",
    "/api/insights/biomarker-assessment",
    "/api/insights/chat",
    "/api/insights/coach/nudge-status",
    "/api/medications/extract",
    "/api/labs/ocr/",
    "/api/feature-flags",
  ].join("|"),
);

function watchNetwork(page: Page): {
  aiRequests: string[];
  refused: string[];
} {
  const aiRequests: string[] = [];
  const refused: string[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (AI_ROUTE.test(url.pathname)) aiRequests.push(url.pathname);
  });
  page.on("response", (response: Response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/") && response.status() === 403) {
      refused.push(url.pathname);
    }
  });
  return { aiRequests, refused };
}

async function clearHintDismissal(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("healthlog.ai-setup-hint.")) {
        window.localStorage.removeItem(key);
      }
    }
  });
}

test.describe("J1: AI switched off by the operator", () => {
  test("the overview shows data, no AI, no AI requests and no refusals", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await serveAiBlock(
      page,
      aiBlockUnavailable("operator_disabled", {
        configured: false,
        managedBy: null,
        canConfigure: false,
      }),
    );
    const network = watchNetwork(page);

    await page.goto("/insights");
    await expect(page.locator('[data-slot="insights-hero-strip"]')).toBeVisible(
      { timeout: 20_000 },
    );
    // Let every section's reads land before judging what painted.
    await page.waitForLoadState("networkidle");
    await mountWholeOverview(page);

    // A read refused for want of AI paints one of these on the overview:
    // the section boundary, the error card, or the dense error row.
    await expect(
      page.locator('[data-slot="insights-overview-section-error"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-slot="query-error-card"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="query-error-row"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chart-error-state"]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-slot="daily-briefing"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="ai-setup-hint"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="coach-fab"]')).toHaveCount(0);

    // The ECG page is data and never waits on AI.
    await page.goto("/insights/ecg");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-slot="query-error-card"]')).toHaveCount(0);

    expect(network.aiRequests).toEqual([]);
    expect(network.refused).toEqual([]);
  });
});

test.describe("J3: no AI provider", () => {
  test("one calm setup hint, no Coach, no per-card provider state", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await serveAiBlock(
      page,
      aiBlockUnavailable("no_provider", {
        configured: false,
        managedBy: null,
        canConfigure: true,
      }),
    );
    const network = watchNetwork(page);

    await page.goto("/insights");
    await clearHintDismissal(page);
    await page.reload();

    await expect(page.locator('[data-slot="ai-setup-hint"]')).toHaveCount(1, {
      timeout: 20_000,
    });
    await page.waitForLoadState("networkidle");
    await mountWholeOverview(page);
    await expect(page.locator('[data-slot="coach-fab"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="daily-briefing"]')).toHaveCount(0);
    // The per-card Coach hand-offs paint only while the Coach is available.
    await expect(page.locator('[data-slot="ask-coach-action"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="ask-coach-icon"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="coach-launch-inline"]')).toHaveCount(
      0,
    );

    // The Coach page itself answers an unavailable Coach by going back to
    // the overview, rather than painting a composer that would be refused.
    await page.goto("/coach");
    await expect(page).toHaveURL(/\/insights$/, { timeout: 20_000 });

    // Settings → AI carries the same hint; dismissing it there is remembered.
    await page.goto("/settings/ai");
    const hint = page.locator('[data-slot="ai-setup-hint"]');
    await expect(hint).toHaveCount(1, { timeout: 20_000 });
    await page.locator('[data-slot="ai-setup-hint-dismiss"]').click();
    await expect(hint).toHaveCount(0);

    await page.goto("/insights");
    await expect(page.locator('[data-slot="insights-hero-strip"]')).toBeVisible(
      { timeout: 20_000 },
    );
    await page.waitForLoadState("networkidle");
    await mountWholeOverview(page);
    await expect(page.locator('[data-slot="ai-setup-hint"]')).toHaveCount(0);

    expect(network.aiRequests).toEqual([]);
  });
});
