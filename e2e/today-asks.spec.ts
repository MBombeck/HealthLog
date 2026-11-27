import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import type { DailyAsk } from "@/lib/daily/asks";
import type { DailyDigest } from "@/lib/daily/digest";
import type { DailyMorning } from "@/lib/daily/morning";

/**
 * The top of `/`: the ask card (only when today asks something) and the
 * score row, on the tile strip's grid. The two reads are mocked so the states
 * are exact; the e2e server renders the dashboard without the SSR prefetch,
 * so these client mocks govern what paints.
 *
 * Every assertion is on a `data-slot` / `data-kind`, never on viewport text,
 * except the one action label a person taps.
 *
 * Round trips: a dose opens the intake sheet in one tap, a coach check-in
 * is answered in place. The policy itself (which rows, how many, in which
 * order) is the server's and is pinned in `asks.test.ts`; here the card
 * renders what it is given.
 */

const MORNING: DailyMorning = {
  lead: { rank: 10, key: "nothing", text: "", language: "en" },
  cards: [],
  scores: {
    sleep: {
      ring: { score: 76, band: "green", fresh: true, asOfDay: "2026-11-25" },
      line: "7h 20m",
      href: "/insights/scores/sleep",
    },
    readiness: {
      ring: { score: null, band: null, fresh: false, asOfDay: "2026-11-24" },
      line: "Last 81 on Nov 24",
      href: "/insights/scores/readiness",
    },
  },
  toDo: { titleKey: "daily.morningCard.title.toDo", title: "To do today" },
  generatedAt: new Date().toISOString(),
};

const DOSE: DailyAsk = {
  kind: "dose_window",
  tier: "safety",
  itemKey: "dose_window:e2e-med:2026-11-26T07:00:00.000Z",
  title: "Medication overdue",
  body: "Ramipril is past due.",
  subject: "Ramipril",
  learnMore: null,
  actions: [
    {
      labelKey: "daily.action.logDose",
      intent: "dose.log",
      href: "/medications",
    },
    { labelKey: "daily.action.later", intent: "dose.snooze:e2e-med" },
  ],
};

const CHECKIN: DailyAsk = {
  kind: "coach_checkin",
  tier: "decision",
  itemKey: "coach_checkin:e2e-plan",
  title: "Check in on your plan",
  body: "Ten minutes of walking after lunch.",
  subject: null,
  learnMore: null,
  actions: [
    {
      labelKey: "daily.action.answer",
      intent: "coach.checkin.adjust",
      href: "/coach?ask=e2e",
    },
    {
      labelKey: "daily.action.later",
      intent: "ask.later:ask-later:2026-11-27:coach_checkin:e2e-plan",
    },
  ],
};

function digest(asks: DailyAsk[]): DailyDigest {
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
    lead: null,
    today: [],
    restMode: null,
    line: "",
    worthALook: [],
    asks,
    justIn: null,
    reactionLine: null,
  } as unknown as DailyDigest;
}

async function serveToday(
  page: Page,
  {
    asks = [],
    morning = { status: 200, body: MORNING },
  }: {
    asks?: DailyAsk[];
    morning?: { status: number; body?: DailyMorning };
  } = {},
) {
  await page.route(/\/api\/daily\/digest(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: digest(asks), error: null }),
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

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('[data-slot="today-scores"]')
    .include('[data-slot="today-asks"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.nodes.length}`);
}

test.describe("the top of the dashboard", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const theme of ["light", "dark"] as const) {
    test(`no asks, no card; three score tiles on the strip's grid (${theme}), axe clean`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await serveToday(page);
      await page.goto("/");
      const scores = page.locator('[data-slot="today-scores"]');
      await expect(scores).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-slot="today-asks"]')).toHaveCount(0);
      const tiles = scores.locator('[data-slot="today-score-tile"]');
      await expect(tiles).toHaveCount(3);
      // A stale readiness is the bare track, never a number.
      await expect(
        tiles.nth(2).locator('[data-slot="score-ring"]'),
      ).toHaveAttribute("data-provisional", "true");

      // Each score tile spans exactly two strip columns: its outer edges sit
      // on the strip's own edges and gutters.
      const strip = page.locator('[data-slot="dashboard-tile-strip"]');
      await expect(strip).toBeVisible();
      const cells = strip.locator(":scope > *:visible");
      if ((await cells.count()) >= 6) {
        const edges = async (i: number) => (await cells.nth(i).boundingBox())!;
        for (let i = 0; i < 3; i++) {
          const tile = (await tiles.nth(i).boundingBox())!;
          const left = await edges(2 * i);
          const right = await edges(2 * i + 1);
          expect(Math.abs(tile.x - left.x)).toBeLessThanOrEqual(1);
          expect(
            Math.abs(tile.x + tile.width - (right.x + right.width)),
          ).toBeLessThanOrEqual(1);
        }
      }
      expect(await axe(page)).toEqual([]);
    });

    test(`two asks in one card, primary action last (${theme}), axe clean`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await serveToday(page, { asks: [DOSE, CHECKIN] });
      await page.goto("/");
      const card = page.locator('[data-slot="today-asks"]');
      await expect(card).toBeVisible({ timeout: 20_000 });
      const rows = card.locator('[data-slot="today-ask"]');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toHaveAttribute("data-kind", "dose_window");
      await expect(rows.nth(1)).toHaveAttribute("data-kind", "coach_checkin");
      // The card sits above the score row.
      const cardBox = (await card.boundingBox())!;
      const scoresBox = (await page
        .locator('[data-slot="today-scores"]')
        .boundingBox())!;
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(scoresBox.y);
      expect(await axe(page)).toEqual([]);
    });
  }

  test("five asks all show, nothing folds, one button width", async ({
    page,
  }) => {
    const more = (n: number): DailyAsk => ({
      kind: "preventive_care",
      tier: "due",
      itemKey: `preventive_care:e2e-${n}`,
      title: `Check-up ${n} due`,
      body: "Dental check-up is due.",
      subject: null,
      learnMore: null,
      actions: [
        {
          labelKey: "daily.action.open",
          intent: "checkup.view",
          href: "/checkups",
        },
        {
          labelKey: "daily.action.later",
          intent: `ask.later:ask-later:2026-11-27:preventive_care:e2e-${n}`,
        },
      ],
    });
    await serveToday(page, {
      asks: [DOSE, CHECKIN, more(1), more(2), more(3)],
    });
    await page.goto("/");
    const card = page.locator('[data-slot="today-asks"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('[data-slot="today-ask"]:visible')).toHaveCount(
      5,
    );
    await expect(card.locator("details")).toHaveCount(0);
    // Every button in the card is one width.
    const widths = await card
      .locator('[data-slot="today-ask-action"]:visible')
      .evaluateAll((els) => [
        ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().width))),
      ]);
    expect(widths).toHaveLength(1);
  });

  test("a due dose opens the intake sheet in one tap", async ({ page }) => {
    await serveToday(page, { asks: [DOSE] });
    await page.goto("/");
    const dose = page.locator(
      '[data-slot="today-ask"][data-kind="dose_window"]',
    );
    await expect(dose).toBeVisible({ timeout: 20_000 });
    await dose.getByRole("button", { name: "Take" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Still on the dashboard: the sheet opened here.
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("Later sets the ask aside through the dismiss ledger", async ({
    page,
  }) => {
    await serveToday(page, { asks: [CHECKIN] });
    const dismissed: string[] = [];
    await page.route(/\/api\/daily\/digest\/dismiss$/, async (route) => {
      dismissed.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { dismissed: true }, error: null }),
      });
    });
    await page.goto("/");
    const checkin = page.locator(
      '[data-slot="today-ask"][data-kind="coach_checkin"]',
    );
    await expect(checkin).toBeVisible({ timeout: 20_000 });
    // Two actions: Later, then the primary that opens the Coach.
    await expect(checkin.locator('[data-slot="today-ask-action"]')).toHaveCount(
      2,
    );
    await expect(checkin.getByRole("link", { name: "Answer" })).toHaveAttribute(
      "href",
      "/coach?ask=e2e",
    );
    await checkin.getByRole("button", { name: "Later" }).click();
    await expect.poll(() => dismissed.length).toBeGreaterThan(0);
    expect(dismissed[0]).toContain(
      "ask-later:2026-11-27:coach_checkin:e2e-plan",
    );
  });

  test("on a phone: the card full width, the scores in one tile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveToday(page, { asks: [DOSE] });
    await page.goto("/");
    const card = page.locator('[data-slot="today-asks"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    const compact = page.locator('[data-slot="today-scores-compact"]');
    await expect(compact).toBeVisible();
    await expect(
      compact.locator('[data-slot="today-score-compact"]'),
    ).toHaveCount(3);
    await expect(
      page.locator('[data-slot="today-score-tile"]').first(),
    ).toBeHidden();
    const cardBox = (await card.boundingBox())!;
    const compactBox = (await compact.boundingBox())!;
    expect(Math.abs(cardBox.width - compactBox.width)).toBeLessThanOrEqual(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test("shows the Health score alone when the morning read is missing", async ({
    page,
  }) => {
    await serveToday(page, { morning: { status: 404 } });
    await page.goto("/");
    const scores = page.locator('[data-slot="today-scores"]');
    await expect(scores).toBeVisible({ timeout: 20_000 });
    await expect(scores).toHaveAttribute("data-tile-count", "1");
  });

  test("the top-card switch hides the score row, never the asks", async ({
    page,
  }) => {
    await serveToday(page, { asks: [DOSE] });
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
    await expect(page.locator('[data-slot="today-asks"]')).toBeVisible();
    await expect(page.locator('[data-slot="today-scores"]')).toHaveCount(0);
    await expect(
      page.locator('[data-slot="today-scores-skeleton"]'),
    ).toHaveCount(0);
  });
});
