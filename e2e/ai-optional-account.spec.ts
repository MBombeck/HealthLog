/**
 * What happens to stored AI text and stored Coach rows, against the real
 * server, on an account of its own (`E2E_AI_OPTIONAL`).
 *
 * J5 — consent withdrawn. The account has a local model (an address nothing
 *      listens on: presence is all the capability reads, nothing here calls
 *      it), a daily briefing a model wrote earlier, and an AI consent. The
 *      briefing is on the overview; the consent is withdrawn in Settings, AI
 *      through the real control; the briefing is gone, because the server
 *      deleted the notes written under that consent.
 * J4 — Coach hidden. With Hide Coach on, Settings, Coach is out of reach, so
 *      Settings, AI lists what the Coach stored; one stored conversation is
 *      deleted from there and is gone from the database.
 *
 * Both journeys move the same account's state, so they run serially, in one
 * project (see `playwright.config.ts`).
 */
import type { Page } from "@playwright/test";

import { AI_OPTIONAL_STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  coachConversationCount,
  resetAiOptionalAccount,
  seedHiddenCoachWithConversation,
  seedStoredBriefing,
} from "./setup/ai-optional-fixture";
import { expect, test } from "./setup/test";
import { revealDeferredSectionsSettled } from "./utils/deferred-sections";

test.use({ storageState: AI_OPTIONAL_STORAGE_STATE_PATH });
test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await resetAiOptionalAccount();
});
test.afterAll(async () => {
  await resetAiOptionalAccount();
});

/**
 * The overview with every section mounted. Sections past the first three
 * render as an empty sentinel until they near the viewport, so a count of
 * zero taken before they mount would pass whatever they paint.
 */
async function openOverview(page: Page): Promise<void> {
  await page.goto("/insights");
  await expect(page.locator('[data-slot="insights-hero-strip"]')).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForLoadState("networkidle");
  await revealDeferredSectionsSettled(page);
}

test("J5: withdrawing AI consent deletes the notes written under it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marker = `Stored briefing ${Date.now()}`;
  await seedStoredBriefing(marker);

  // Positive control: the stored briefing is what the overview shows.
  await openOverview(page);
  await expect(page.locator('[data-slot="daily-briefing"]')).toHaveCount(1);
  await expect(page.getByText(marker).first()).toBeVisible();

  // Withdraw through the real control. The confirm names what goes and what
  // stays before anything happens.
  await page.goto("/settings/ai");
  await page.locator('[data-slot="ai-consent-withdraw"]').click();
  const withdrawn = page.waitForResponse(
    (res) =>
      res.url().includes("/api/consent/ai/latest") &&
      res.request().method() === "DELETE",
  );
  await page.locator('[data-slot="ai-consent-withdraw-confirm"]').click();
  expect((await withdrawn).status()).toBe(200);
  await expect(page.locator('[data-slot="ai-consent-grant"]')).toBeVisible();

  await openOverview(page);
  await expect(page.getByText(marker)).toHaveCount(0);
});

test("J4: the Coach memory stays readable and deletable with the Coach hidden", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const title = `Stored conversation ${Date.now()}`;
  await seedHiddenCoachWithConversation(title);

  // Hide Coach takes the Coach page, its launcher and every per-card
  // hand-off away...
  await openOverview(page);
  await expect(page.locator('[data-slot="coach-fab"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="ask-coach-action"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="ask-coach-icon"]')).toHaveCount(0);

  // ...and Settings, AI lists what the Coach stored.
  await page.goto("/settings/ai");
  const card = page.locator(
    '[data-testid="settings-coach-conversations-card"]',
  );
  await expect(card).toBeVisible({ timeout: 20_000 });
  const row = card
    .locator('[data-testid="settings-coach-conversation"]')
    .filter({ hasText: title });
  await expect(row).toHaveCount(1);

  // Readable: the row opens its transcript in place.
  await row.locator('[data-slot="settings-coach-conversation-open"]').click();
  await expect(
    row.locator('[data-slot="settings-coach-conversation-open"]'),
  ).toHaveAttribute("aria-expanded", "true");

  // Deletable: the row goes at once, and the delete reaches the server once
  // the undo window closes.
  const deleted = page.waitForResponse(
    (res) =>
      /\/api\/insights\/chat\/[^/]+$/.test(new URL(res.url()).pathname) &&
      res.request().method() === "DELETE",
    { timeout: 30_000 },
  );
  await row.locator('[data-slot="settings-coach-conversation-delete"]').click();
  await expect(row).toHaveCount(0);
  expect((await deleted).ok()).toBe(true);
  expect(await coachConversationCount()).toBe(0);
});
