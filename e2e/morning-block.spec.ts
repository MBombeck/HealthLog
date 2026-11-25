import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import type { DailyDigest } from "@/lib/daily/digest";
import type { DailyMorning } from "@/lib/daily/morning";

/**
 * The morning block on `/`: the sentence, the health score beside it, and
 * the three cards. The two reads are mocked so the states are exact; the
 * e2e server renders the dashboard without the SSR prefetch, so these client
 * mocks govern what paints.
 *
 * Every assertion is on a `data-slot` / `data-kind`, never on viewport text,
 * except the one action label a person taps.
 *
 * Round trips (T15): answering a coach check-in and dismissing an
 * observation from "To do today" reach their routes; a due dose opens the
 * intake sheet in one tap. Nothing the old "Worth a look" rail offered is
 * gone.
 */

const MORNING: DailyMorning = {
  lead: {
    rank: 8,
    key: "in_range",
    text: "All 3 of today's values are in their usual range.",
    language: "en",
  },
  cards: [
    {
      kind: "night",
      titleKey: "daily.morningCard.title.night",
      title: "Last night",
      ring: { score: 76, band: "green", fresh: true, asOfDay: "2026-11-25" },
      lines: [{ text: "7 h 20 min, about as usual", href: null }],
      sourceValues: [],
      href: "/insights/scores/sleep",
    },
    {
      kind: "today_different",
      titleKey: "daily.morningCard.title.todayDifferent",
      title: "Different today",
      ring: { score: null, band: null, fresh: false, asOfDay: "2026-11-24" },
      lines: [{ text: "Last 81 on 24 Nov", href: null }],
      sourceValues: [],
      href: "/insights/scores/readiness",
    },
  ],
  toDo: { titleKey: "daily.morningCard.title.toDo", title: "To do today" },
  generatedAt: new Date().toISOString(),
};

function digest(): DailyDigest {
  return {
    generatedAt: new Date().toISOString(),
    phase: "final",
    sleepPending: false,
    score: {
      value: 82,
      band: "green",
      delta: 2,
      deltaReason: null,
      scoreVersion: 4,
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    },
    topSignal: null,
    signalLine: null,
    briefingLead: null,
    lead: { text: "All 3 of today's values are in range.", source: "signal" },
    today: [
      {
        kind: "medications",
        label: "Medications",
        value: "1 of 2 taken",
        href: "/medications",
      },
      {
        kind: "cycle",
        label: "Cycle",
        value: "Follicular phase, day 9",
        href: "/cycle",
      },
    ],
    restMode: null,
    line: null,
    worthALook: [
      {
        kind: "dose_window",
        title: "Medication due",
        body: "Ramipril is due.",
        status: "info",
        actions: [
          {
            labelKey: "daily.action.logDose",
            intent: "dose.log",
            href: "/medications",
          },
        ],
        moduleKey: "medications",
      },
      {
        kind: "coach_checkin",
        title: "Check in on your plan",
        body: "Ten minutes of walking after lunch.",
        status: "info",
        actions: [
          {
            labelKey: "daily.action.checkinKeep",
            intent: "coach.checkin.keep:e2e-plan",
          },
          {
            labelKey: "daily.action.checkinLetGo",
            intent: "coach.checkin.letgo:e2e-plan",
          },
        ],
      },
      {
        kind: "milestone",
        title: "30 days logged",
        body: "A month of mornings.",
        status: "success",
        actions: [],
        itemKey: "milestone:e2e-30d",
      },
    ],
    justIn: null,
    reactionLine: null,
  } as unknown as DailyDigest;
}

async function serveToday(
  page: Page,
  morning: { status: number; body?: DailyMorning } = {
    status: 200,
    body: MORNING,
  },
) {
  await page.route(/\/api\/daily\/digest(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: digest(), error: null }),
    }),
  );
  await page.route(/\/api\/daily\/morning(\?|$)/, (route) =>
    route.fulfill({
      status: morning.status,
      contentType: "application/json",
      body: JSON.stringify(
        morning.body
          ? { data: morning.body, error: null }
          : { data: null, error: "Not found" },
      ),
    }),
  );
}

test.describe("morning block", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("paints the sentence, the health score and three cards, axe clean", async ({
    page,
  }) => {
    await serveToday(page);
    await page.goto("/");
    const block = page.locator('[data-slot="morning-block"]');
    await expect(block).toBeVisible({ timeout: 20_000 });
    await expect(block).toHaveAttribute("data-lead", "in_range");
    await expect(block.locator('[data-slot="morning-lead"]')).toHaveCount(1);
    await expect(block.locator('[data-slot="morning-score"]')).toHaveCount(1);
    const cards = block.locator('[data-slot="morning-card"]');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toHaveAttribute("data-kind", "night");
    await expect(cards.nth(1)).toHaveAttribute("data-kind", "today_different");
    await expect(cards.nth(2)).toHaveAttribute("data-kind", "to_do");
    // A stale readiness is the empty ring, never a number.
    await expect(
      cards.nth(1).locator('[data-slot="morning-card-ring"]'),
    ).toHaveAttribute("data-fresh", "false");
    await expect(
      cards.nth(1).locator('[data-slot="score-ring"]'),
    ).toHaveAttribute("data-provisional", "true");
    // One list only: the old hero and its rail are not drawn beside it.
    await expect(page.locator('[data-slot="today-hero"]')).toHaveCount(0);

    // Three rows show, the fourth and fifth open in place.
    const toDo = cards.nth(2);
    const more = toDo.locator('[data-slot="morning-more"]');
    await expect(more).toHaveCount(1);
    await expect(more).not.toHaveAttribute("open", "");
    await more.locator("summary").click();
    await expect(more).toHaveAttribute("open", "");
    await expect(
      more.locator('[data-slot="morning-row"][data-kind="cycle"]'),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-slot="morning-block"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  test("a due dose opens the intake sheet in one tap", async ({ page }) => {
    await serveToday(page);
    await page.goto("/");
    const dose = page.locator(
      '[data-slot="morning-row"][data-kind="dose_window"]',
    );
    await expect(dose).toBeVisible({ timeout: 20_000 });
    await dose.getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Still on the dashboard: the sheet opened here.
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("answers a coach check-in and dismisses an observation from To do today", async ({
    page,
  }) => {
    await serveToday(page);
    const patched: string[] = [];
    await page.route(/\/api\/coach\/plans\/e2e-plan$/, async (route) => {
      patched.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { id: "e2e-plan" }, error: null }),
      });
    });
    const dismissed: string[] = [];
    await page.route(/\/api\/daily\/digest\/dismiss$/, async (route) => {
      dismissed.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { ok: true }, error: null }),
      });
    });
    await page.goto("/");

    const checkin = page.locator(
      '[data-slot="morning-row"][data-kind="coach_checkin"]',
    );
    await expect(checkin).toBeVisible({ timeout: 20_000 });
    await checkin.getByRole("button").first().click();
    await expect.poll(() => patched.length).toBeGreaterThan(0);

    const more = page.locator('[data-slot="morning-more"]');
    await more.locator("summary").click();
    await page
      .locator('[data-slot="morning-row"][data-kind="milestone"]')
      .locator('[data-slot="priority-card-dismiss"]')
      .click();
    await expect.poll(() => dismissed.length).toBeGreaterThan(0);
    expect(dismissed[0]).toContain("milestone:e2e-30d");
  });

  test("falls back to the Today hero when the morning read is missing", async ({
    page,
  }) => {
    await serveToday(page, { status: 404 });
    await page.goto("/");
    await expect(page.locator('[data-slot="today-hero"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('[data-slot="morning-block"]')).toHaveCount(0);
  });

  test("the top-card switch hides the whole block", async ({ page }) => {
    await serveToday(page);
    await page.route(/\/api\/dashboard\/snapshot/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.layout = { ...json.data.layout, todayCardVisible: false };
      await route.fulfill({ response, json });
    });
    await page.goto("/");
    await expect(page.locator('[data-today-card="off"]')).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(page.locator('[data-slot="morning-block"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="morning-skeleton"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="today-hero"]')).toHaveCount(0);
  });
});
