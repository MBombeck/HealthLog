/**
 * A module switched off disappears everywhere, and a page of it answers with
 * the notice instead of errors.
 *
 * One journey on its own account (`E2E_MODULES`): mood and medications are
 * switched on, the surfaces they own are proven present (the positive control
 * every "is gone" assertion below leans on), then both are switched off
 * through the real module route and the same surfaces are proven gone:
 *
 *   - the Mood nav entry,
 *   - the Mood and Medications pills in the Insights tab strip,
 *   - the mood slot in the Insights trends row (the row fills from the next
 *     metric instead),
 *   - Mood and Medication in the add menu,
 *   - `/insights/mood` renders the module notice, not the page,
 *
 * and no chart on the overview paints its error state.
 *
 * Every assertion is addressed to a stable `data-*` attribute, never to copy.
 * The journey moves its account's module switches, so it runs in one project
 * and serially (see `playwright.config.ts`).
 */
import type { Page } from "@playwright/test";

import { MODULES_STORAGE_STATE_PATH } from "./setup/global-setup";
import { modulesSeedState } from "./setup/modules-fixture";
import { expect, test } from "./setup/test";
import { revealDeferredSections } from "./utils/deferred-sections";

test.use({ storageState: MODULES_STORAGE_STATE_PATH });
test.describe.configure({ mode: "serial" });

/** A same-origin JSON write from the page, so the session cookie rides along. */
async function send(
  page: Page,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<number> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status;
    },
    { method, path, body },
  );
}

async function setModules(page: Page, on: boolean): Promise<void> {
  expect(
    await send(page, "PATCH", "/api/auth/me/modules", {
      mood: on,
      medications: on,
    }),
  ).toBe(200);
}

/** One mood entry and one medication, created once, through the app. */
async function seed(page: Page): Promise<void> {
  const state = await modulesSeedState();
  if (state.moodEntries === 0) {
    expect(
      await send(page, "POST", "/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    ).toBe(201);
  }
  if (state.medications === 0) {
    expect(
      await send(page, "POST", "/api/medications", {
        name: "Module journey",
        dose: "5 mg",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    ).toBe(201);
  }
}

const moodPill = '[data-slot="insights-tab-strip-pill"][href="/insights/mood"]';
const medsPill =
  '[data-slot="insights-tab-strip-pill"][href="/insights/medications"]';
const trendCard = (metric: string) =>
  `[data-slot="trends-row-card"][data-metric="${metric}"]`;

async function openCapturePicker(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const capture = page.locator('[data-testid="bottom-nav-capture"]');
  await expect(capture).toBeVisible({ timeout: 15_000 });
  await capture.click();
  await expect(
    page.locator('[data-testid="capture-picker-measurement"]'),
  ).toBeVisible();
}

test("mood and medications, switched off, leave every surface they own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await setModules(page, true);
  await seed(page);

  // ── Positive control: with both modules on, each surface is there. ──
  await page.goto("/insights");
  await expect(page.locator(moodPill)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(medsPill)).toBeVisible();
  await expect(page.locator(trendCard("mood"))).toHaveCount(1);
  await expect(page.locator('[data-tour-id="nav-mood"]')).toHaveCount(1);

  await openCapturePicker(page);
  await expect(page.locator('[data-testid="capture-picker-mood"]')).toHaveCount(
    1,
  );
  await expect(
    page.locator('[data-testid="capture-picker-medication"]'),
  ).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 720 });

  // ── Switch both off through the real route. ──
  await setModules(page, false);

  // Insights overview: no Mood or Medications pill, no mood trend slot, the
  // row still fills three slots from the next metric, and nothing errors.
  await page.goto("/insights");
  await expect(
    page.locator('[data-slot="insights-tab-strip-pill"][href="/insights"]'),
  ).toBeVisible({ timeout: 20_000 });
  // The trends row sits below the sections that mount with the page.
  await revealDeferredSections(page);
  await expect(page.locator('[data-slot="trends-row"]')).toBeVisible();
  await expect(page.locator(moodPill)).toHaveCount(0);
  await expect(page.locator(medsPill)).toHaveCount(0);
  await expect(page.locator(trendCard("mood"))).toHaveCount(0);
  await expect(page.locator(trendCard("pulse"))).toHaveCount(1);
  await expect(page.locator('[data-slot="chart-error-state"]')).toHaveCount(0);

  // The nav entry is gone; Insights itself is not a module's and stays.
  await expect(page.locator('[data-tour-id="nav-mood"]')).toHaveCount(0);
  await expect(page.locator('[data-tour-id="nav-insights"]')).toHaveCount(1);

  // A direct visit: the notice, named for mood and for the record's own
  // switch (so it offers Settings), at the same URL, never the page.
  await page.goto("/insights/mood");
  await expect(page).toHaveURL(/\/insights\/mood$/);
  const notice = page.locator(
    '[data-slot="module-disabled-notice"][data-module="mood"]',
  );
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toHaveAttribute("data-module-access", "disabled");
  await expect(
    page.locator('[data-slot="module-off-open-settings"]'),
  ).toBeVisible();
  await expect(page.locator('[data-slot="chart-error-state"]')).toHaveCount(0);

  // The add menu offers a measurement and nothing the modules owned.
  await openCapturePicker(page);
  await expect(page.locator('[data-testid="capture-picker-mood"]')).toHaveCount(
    0,
  );
  await expect(
    page.locator('[data-testid="capture-picker-medication"]'),
  ).toHaveCount(0);

  // Leave the account as the next run expects to find it.
  await setModules(page, true);
});
