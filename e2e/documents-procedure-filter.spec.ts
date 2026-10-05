/**
 * Document vault — the procedure filter.
 *
 * The facet beside the condition filter: it lists the procedures that hold a
 * document, labelled the way the visits page heads them, narrows the list to
 * one procedure's documents through the real `encounterId` filter, writes the
 * choice to the URL (`?encounter=`), comes back from a deep link, and clears
 * with the one clear control. Run at a 1440 px desktop and a 390 px phone,
 * where the filter row must stay a single line with no sideways scroll.
 *
 * Fixture: `ensureProcedureFixture` (two procedures over a namespaced trio of
 * documents), upserted before every test because the visits spec clears the
 * account's visits; the dates sit far outside that spec's ±7-day window.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  ensureProcedureFixture,
  ensureVaultFixture,
  PROCEDURE_DOC_PREFIX,
  PROCEDURE_KNEE_ID,
} from "./setup/vault-fixture";

function card(page: Page, n: number) {
  return page
    .getByRole("button", {
      name: `Open ${PROCEDURE_DOC_PREFIX} ${String(n).padStart(3, "0")}`,
    })
    .first();
}

/** The filter row is one line and never scrolls sideways. */
async function expectOneRow(page: Page) {
  const bar = page.locator('[data-slot="document-filter-bar"]');
  const row = bar.locator("> div").first();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(48);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string, isMobile: boolean) {
  const dir = process.env.E2E_SHOT_DIR;
  if (!dir) return;
  await page.screenshot({
    path: `${dir}/${name}-${isMobile ? "390" : "1440"}.png`,
    animations: "disabled",
  });
}

test.describe("document vault — procedure filter", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeAll(async () => {
    await ensureVaultFixture();
  });

  test.beforeEach(async ({ page, isMobile }) => {
    await ensureProcedureFixture();
    await page.setViewportSize(
      isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
  });

  test("picks a procedure, narrows to its documents, and clears", async ({
    page,
    isMobile,
  }) => {
    await page.goto(`/documents?q=${PROCEDURE_DOC_PREFIX}`);
    await expect(card(page, 3)).toBeVisible();
    await expect(card(page, 1)).toBeVisible();

    const trigger = page.locator('[data-slot="document-procedure-filter"]');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-label", "All procedures");
    await expectOneRow(page);
    await shot(page, "procedure-filter-idle", isMobile);

    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Procedures and surgeries");
    // Headed like the visits page, with the body site and side beneath.
    const knee = menu.getByRole("menuitemcheckbox", {
      name: /Knee arthroscopy/,
    });
    await expect(knee).toContainText("Knee · Left");
    await expect(
      menu.getByRole("menuitemcheckbox", { name: /Appendectomy/ }),
    ).toBeVisible();
    await shot(page, "procedure-filter-menu", isMobile);
    await knee.click();

    await expect(page).toHaveURL(new RegExp(`encounter=${PROCEDURE_KNEE_ID}`));
    await expect(card(page, 1)).toBeVisible();
    await expect(card(page, 2)).toBeVisible();
    await expect(card(page, 3)).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-label", "Knee arthroscopy");
    // Picked: the label shows at every width, phone included.
    await expect(trigger).toContainText("Knee arthroscopy");
    await expectOneRow(page);
    // The search field never collapses under the facets.
    const search = await page
      .getByRole("searchbox", { name: "Search documents" })
      .boundingBox();
    expect(search!.width).toBeGreaterThanOrEqual(48);
    await shot(page, "procedure-filter-active", isMobile);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/encounter=/);
    await expect(trigger).toHaveAttribute("aria-label", "All procedures");
  });

  test("a deep link lands filtered and the facet names the procedure", async ({
    page,
  }) => {
    await page.goto(
      `/documents?q=${PROCEDURE_DOC_PREFIX}&encounter=${PROCEDURE_KNEE_ID}`,
    );
    await expect(card(page, 2)).toBeVisible();
    await expect(card(page, 3)).toHaveCount(0);
    await expect(
      page.locator('[data-slot="document-procedure-filter"]'),
    ).toHaveAttribute("aria-label", "Knee arthroscopy");
  });
});
