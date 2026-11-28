/**
 * #1430 — the leaflet section on the medication detail, in the browser.
 *
 * The detail read is stubbed with a medication that carries a saved leaflet
 * link and a registry search, so the spec writes nothing to the shared
 * account. It asserts what the browser will open: the hosts of both links,
 * that they open in a new tab without an opener, and that nothing embeds a
 * registry page. Addressed by `data-slot` / `data-*`, never by copy.
 */
import type { Route } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";

const ID = "med_e2e_leaflet";
const SAVED =
  "https://rejestry.ezdrowie.gov.pl/api/rpl/medicinal-products/1/leaflet";

const snapshot = {
  id: ID,
  name: "Ramipril",
  dose: "5mg",
  category: "BLOOD_PRESSURE",
  categoryLabel: null,
  treatmentClass: "GENERIC",
  deliveryForm: "ORAL",
  active: true,
  notificationsEnabled: true,
  pausedAt: null,
  startsOn: null,
  endsOn: null,
  oneShot: false,
  asNeeded: false,
  trackIntake: true,
  note: null,
  leafletUrl: SAVED,
  leafletSearch: {
    registry: "PL",
    authority: "Rejestr Produktów Leczniczych",
    url: "https://rejestry.ezdrowie.gov.pl/rpl/search?name=Ramipril",
    host: "rejestry.ezdrowie.gov.pl",
    prefill: "name",
    searchTerm: "Ramipril",
  },
  schedules: [
    {
      id: "sch_e2e_leaflet",
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
  related: [],
};

test.describe("medication leaflet (#1430)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("opens the registry search and the saved leaflet in a new tab", async ({
    page,
  }) => {
    await page.route(`**/api/medications/${ID}`, async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: snapshot, error: null }),
      });
    });

    await page.goto(`/medications/${ID}`);
    const row = page.locator('[data-slot="medication-leaflet"]');
    await expect(row).toBeVisible();
    // The saved leaflet is the row's chip; the registry search, the
    // reminder and the editor sit behind "More".
    await row.locator('[data-slot="medication-leaflet-more"]').click();
    const section = page.locator(
      '[data-slot="medication-leaflet"], [data-slot="medication-leaflet-more-content"]',
    );

    const find = section.locator('[data-slot="medication-leaflet-find-link"]');
    await expect(find).toHaveAttribute("data-registry", "PL");
    await expect(find).toHaveAttribute("target", "_blank");
    await expect(find).toHaveAttribute("rel", "noopener noreferrer");
    const findHref = await find.getAttribute("href");
    expect(new URL(findHref!).protocol).toBe("https:");
    expect(new URL(findHref!).host).toBe("rejestry.ezdrowie.gov.pl");

    const saved = section.locator(
      '[data-slot="medication-leaflet-saved-link"]',
    );
    await expect(saved).toHaveAttribute("target", "_blank");
    await expect(saved).toHaveAttribute("rel", "noopener noreferrer");
    expect(new URL((await saved.getAttribute("href"))!).host).toBe(
      "rejestry.ezdrowie.gov.pl",
    );

    await expect(
      section.locator('[data-slot="medication-leaflet-disclaimer"]'),
    ).toBeVisible();
    // A leaflet is linked, never embedded.
    await expect(section.locator("iframe, embed, object")).toHaveCount(0);
  });
});
