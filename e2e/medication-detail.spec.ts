/**
 * The medication detail page in the browser: four tabs, the overview's three
 * cards and their button pairs, the history one row per day, the settings
 * one line per setting, the old `?tab=` links, and axe on every tab in both
 * themes.
 *
 * Every read the page makes about the medication is stubbed, so the spec
 * writes nothing to the shared account. Addressed by `data-slot` and
 * `role`, never by copy.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";
import {
  expectNoHorizontalOverflow,
  settleForOverflowMeasurement,
} from "./utils/horizontal-overflow";

const ID = "med_e2e_detail";
const DAY_MS = 86_400_000;

function dayKey(offset: number): string {
  return new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
}

const snapshot = {
  id: ID,
  // A name no effect target resolves for: the effect tab stays away.
  name: "E2E Detail",
  dose: "5mg",
  category: "BLOOD_PRESSURE",
  categoryLabel: null,
  treatmentClass: "GENERIC",
  deliveryForm: "ORAL",
  active: true,
  notificationsEnabled: true,
  pausedAt: null,
  startsOn: "2023-10-24T00:00:00.000Z",
  endsOn: null,
  oneShot: false,
  asNeeded: false,
  trackIntake: true,
  note: "Before breakfast",
  leafletUrl: null,
  leafletSearch: null,
  nextDueAt: null,
  canEndCourse: true,
  canStartCourse: false,
  courses: [],
  schedules: [
    {
      id: "sch_e2e_detail",
      windowStart: "08:00",
      windowEnd: "10:00",
      label: null,
      dose: null,
      daysOfWeek: null,
      timesOfDay: ["08:00", "20:00"],
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      reminderGraceMinutes: 30,
    },
  ],
  related: [],
};

/** Fourteen days of two doses, one evening missed, the last evening open. */
function ledgerRows() {
  const rows = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    for (const time of ["08:00", "20:00"]) {
      const at = `${dayKey(offset)}T${time === "08:00" ? "07" : "19"}:00:00.000Z`;
      const missed = offset === 5 && time === "20:00";
      const open = offset === 0 && time === "20:00";
      rows.push({
        kind: "slot",
        at,
        timeOfDay: time,
        status: open ? "upcoming" : missed ? "missed" : "taken_on_time",
        state: open ? "upcoming" : null,
        takenLate: false,
        intake:
          open || missed
            ? null
            : {
                id: `in_${offset}_${time}`,
                scheduledFor: at,
                takenAt: at.replace(":00:00.000Z", ":12:00.000Z"),
                skipped: false,
                autoMissed: false,
              },
      });
    }
  }
  return rows;
}

function fulfil(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null, meta: { total: 27 } }),
  });
}

async function stubMedication(page: Page) {
  await page.route(`**/api/medications/${ID}**`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const path = new URL(route.request().url()).pathname;
    const rest = path.slice(`/api/medications/${ID}`.length);
    if (rest === "") return fulfil(route, snapshot);
    if (rest === "/dose-history") {
      return fulfil(route, {
        from: new Date(Date.now() - 90 * DAY_MS).toISOString(),
        to: new Date().toISOString(),
        family: "daily",
        hasExpectedSlots: true,
        rows: ledgerRows(),
      });
    }
    if (rest === "/compliance") {
      return fulfil(route, {
        applicable: true,
        notApplicableReason: null,
        compliance7: { rate: 100, streak: 5 },
        compliance30: { rate: 98 },
        dailyCompliance: {},
        complianceDisplay: null,
      });
    }
    if (rest === "/inventory") return fulfil(route, { items: [] });
    if (rest === "/intake") return fulfil(route, []);
    return fulfil(route, null);
  });
}

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .include('[data-slot="medication-detail-page"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
    `axe on ${label}`,
  ).toEqual([]);
}

test.describe("medication detail page", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await stubMedication(page);
  });

  test("the overview: three-card row without an effect target, button pairs, the plan", async ({
    page,
  }) => {
    await page.goto(`/medications/${ID}`);
    const tabs = page.locator(
      '[data-slot="medication-detail-tabs"] [role=tab]',
    );
    await expect(tabs).toHaveCount(3);
    await expect(
      page.locator('[data-slot="medication-tab-overview"]'),
    ).toHaveAttribute("data-state", "active");
    const today = page.locator('[data-slot="medication-overview-today"]');
    const intake = page.locator('[data-slot="medication-overview-intake"]');
    await expect(today).toBeVisible();
    await expect(intake).toBeVisible();
    await expect(
      intake.locator(
        '[data-slot="medication-overview-grid"] [data-tone="missed"]',
      ),
    ).toHaveCount(1);
    // Every pair is two buttons of one width.
    for (const card of [today, intake]) {
      const buttons = card.locator(
        '[data-slot="overview-action-pair"] > button',
      );
      await expect(buttons).toHaveCount(2);
      const [a, b] = await Promise.all([
        buttons.nth(0).boundingBox(),
        buttons.nth(1).boundingBox(),
      ]);
      expect(Math.abs(a!.width - b!.width)).toBeLessThan(1);
    }
    await expect(
      page.locator('[data-slot="medication-overview-plan-note"]'),
    ).toBeVisible();
    // The header menu carries edit, pause and end.
    await page.locator('[data-slot="medication-detail-menu"]').click();
    await expect(
      page.locator('[data-slot="medication-detail-menu-edit"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="medication-detail-menu-pause"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="medication-detail-menu-end"]'),
    ).toBeVisible();
  });

  test("the history is one row per day with one menu per day", async ({
    page,
  }) => {
    await page.goto(`/medications/${ID}?tab=history`);
    const days = page.locator('[data-slot="ledger-day"]');
    await expect(days).toHaveCount(14);
    await expect(
      page.locator('[data-slot="ledger-table"] thead th[scope=col]'),
    ).toHaveCount(4);
    // Today's open evening dose keeps its visible take; the rest sits in
    // the day menu.
    await expect(page.locator('[data-slot="ledger-mark-taken"]')).toHaveCount(
      1,
    );
    await expect(page.locator('[data-slot="ledger-row-menu"]')).toHaveCount(14);
    await days.first().locator('[data-slot="ledger-row-menu"]').click();
    await expect(page.locator('[data-slot="ledger-open-day"]')).toBeVisible();
  });

  test("the settings: four groups, one line per setting", async ({ page }) => {
    await page.goto(`/medications/${ID}?tab=settings`);
    for (const slot of [
      "medication-settings-plan",
      "medication-settings-period",
      "medication-settings-data",
      "erweitert-group-danger",
    ]) {
      await expect(page.locator(`[data-slot="${slot}"]`)).toBeVisible();
    }
    await expect(
      page.locator('[data-slot="medication-notifications-switch"]'),
    ).toBeVisible();
    // No folded explanations on the tab.
    await expect(
      page.locator('[data-slot="medication-settings-tab"] details'),
    ).toHaveCount(0);
    await page
      .locator('[data-slot="medication-settings-times"] button')
      .click();
    await expect(
      page.locator('[data-slot="medication-settings-sheet-times"]'),
    ).toBeVisible();
  });

  test("old ?tab= links open the tab that holds their controls", async ({
    page,
  }) => {
    for (const legacy of ["advanced", "schedule", "erweitert", "zeitplan"]) {
      await page.goto(`/medications/${ID}?tab=${legacy}`);
      await expect(
        page.locator('[data-slot="medication-tab-settings"]'),
        legacy,
      ).toHaveAttribute("data-state", "active");
    }
    await page.goto(`/medications/${ID}?tab=supply`);
    await expect(
      page.locator('[data-slot="medication-settings-sheet-supply"]'),
    ).toBeVisible();
    await page.goto(`/medications/${ID}?tab=verlauf`);
    await expect(
      page.locator('[data-slot="medication-tab-history"]'),
    ).toHaveAttribute("data-state", "active");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axe finds nothing serious on any tab (${theme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((t: string) => {
        window.localStorage.setItem("healthlog-theme", t);
      }, theme);
      for (const tab of ["overview", "history", "settings"]) {
        await page.goto(`/medications/${ID}?tab=${tab}`);
        await expect(
          page.locator(`[data-slot="medication-tab-${tab}"]`),
        ).toHaveAttribute("data-state", "active");
        await page.waitForLoadState("networkidle").catch(() => {});
        await scan(page, `${tab} ${theme}`);
      }
    });
  }

  test("no tab scrolls sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["overview", "history", "settings"]) {
      await page.goto(`/medications/${ID}?tab=${tab}`);
      await expect(
        page.locator(`[data-slot="medication-tab-${tab}"]`),
      ).toHaveAttribute("data-state", "active");
      await settleForOverflowMeasurement(page);
      await expectNoHorizontalOverflow(page, `medication ${tab} at 390`);
    }
  });
});
