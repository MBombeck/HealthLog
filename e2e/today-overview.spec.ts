import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  mockDashboardSnapshot,
  POPULATED_SUMMARIES,
} from "./utils/mock-dashboard-snapshot";
import type { DailyDigest } from "@/lib/daily/digest";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

/**
 * The Today overview on the dashboard hero, at a desktop and a phone width.
 *
 * What it proves is geometry, because that is what the unit suites cannot
 * see: the facts sit beside the ring on a wide screen and above it on a
 * phone, a phone shows four facts and a wide screen five, nothing pushes the
 * page sideways, the hero keeps the width of the cards around it, and the
 * ring keeps its size. Each state is also captured as an element screenshot
 * under `test-results/today-overview/` for a visual check.
 *
 * The digests are what the server would publish for each state. They carry
 * the pre-overview fields too (`briefingLead`, `line`), with the values the
 * old server sent, so the same fixtures render the previous hero on an older
 * build for a before/after comparison.
 *
 * Assertions anchor on `data-slot` / `data-kind`, never on visible text.
 */
test.use({ storageState: STORAGE_STATE_PATH });

const SHOTS = join(process.cwd(), "test-results", "today-overview");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const BASE: DailyDigest = {
  generatedAt: new Date().toISOString(),
  ai: DIGEST_AI_AVAILABLE,
  phase: "final",
  sleepPending: false,
  score: {
    value: 94,
    band: "green",
    delta: null,
    deltaReason: "first_eligibility_window",
    steadyWeeks: 4,
  },
  topSignal: null,
  briefingLead: null,
  lead: null,
  today: [],
  restMode: null,
  line: "Your health score today is 94.",
  worthALook: [],
  justIn: null,
  reactionLine: null,
};

const FACTS: DailyDigest["today"] = [
  {
    kind: "medications",
    label: "Medications",
    value: "1 of 3 taken",
    href: "/medications",
    moduleKey: "medications",
  },
  {
    kind: "appointment",
    label: "Appointment",
    value: "Tomorrow 09:30, Routine visit",
    href: "/checkups",
  },
  {
    kind: "sleep",
    label: "Last night",
    value: "7h 20m, close to your usual",
    href: "/insights/sleep",
    moduleKey: "sleep",
  },
  {
    kind: "vitals",
    label: "Vitals",
    value: "6 checked, all in your range",
    href: "/insights",
  },
  {
    kind: "cycle",
    label: "Cycle",
    value: "Follicular, day 12",
    href: "/cycle",
    moduleKey: "cycle",
  },
];

const STATES: Record<string, DailyDigest> = {
  // AI on. The old server led with the briefing's first sentence, which was
  // the greeting.
  "ai-on": {
    ...BASE,
    briefingLead: "Good morning.",
    line: "Good morning.",
    topSignal: {
      sourceMetric: "bp",
      tone: "good",
      headline: "Blood pressure is sitting in the optimal band",
      nudge: "",
      delta: "↓ ~10 mmHg systolic vs the start of the window",
    },
    lead: {
      text: "Your latest blood pressure is sitting in the optimal band.",
      source: "briefing",
    },
    today: FACTS,
    worthALook: [
      {
        kind: "dose_window",
        title: "Medication due",
        body: "Ramipril is due soon.",
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
    ],
  },
  // AI off. The old server had only the score sentence, which the hero then
  // removed again, leaving the ring and "Nothing needs your attention".
  "ai-off": {
    ...BASE,
    ai: {
      ...DIGEST_AI_AVAILABLE,
      briefing: {
        available: false,
        reason: "no_provider",
        onDeviceAllowed: false,
      },
    },
    lead: {
      text: "Resting heart rate is at 61 bpm, above your usual range of 50 to 58 bpm.",
      source: "signal",
    },
    today: [FACTS[0], FACTS[2], FACTS[4]],
  },
  // A quiet day: one calm sentence and no facts beyond it.
  quiet: {
    ...BASE,
    lead: {
      text: "All 6 of your latest vitals sit inside their usual range.",
      source: "signal",
    },
  },
};

async function openDashboard(page: Page, digest: DailyDigest) {
  await mockDashboardSnapshot(page, { summaries: POPULATED_SUMMARIES });
  await page.route(/\/api\/daily\/digest(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: digest, error: null }),
    }),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const hero = page.locator('[data-slot="today-hero"]');
  await expect(hero).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-slot="dashboard-tile-strip"]')).toBeVisible({
    timeout: 15_000,
  });
  return hero;
}

test.describe("Today overview geometry", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-driven spec; desktop project only",
    );
  });

  for (const viewport of VIEWPORTS) {
    for (const [state, digest] of Object.entries(STATES)) {
      test(`${state} at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const hero = await openDashboard(page, digest);

        mkdirSync(SHOTS, { recursive: true });
        await hero.screenshot({
          path: join(SHOTS, `${viewport.name}-${state}.png`),
        });

        // Nothing pushes the page sideways.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);

        // The hero spans the same column as the tile strip below it.
        const heroBox = (await hero.boundingBox())!;
        const stripBox = (await page
          .locator('[data-slot="dashboard-tile-strip"]')
          .boundingBox())!;
        expect(Math.abs(heroBox.x - stripBox.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(heroBox.width - stripBox.width)).toBeLessThanOrEqual(1);

        // The ring keeps its size: the same 168 px dial as before.
        const ring = hero.locator('[data-slot="score-ring"]').first();
        const ringBox = (await ring.boundingBox())!;
        expect(Math.round(ringBox.width)).toBe(168);
        expect(Math.round(ringBox.height)).toBe(168);

        const lead = hero.locator('[data-slot="today-hero-lead"]');
        await expect(lead).toBeVisible();
        await expect(lead).toHaveAttribute("data-source", digest.lead!.source);
        const leadBox = (await lead.boundingBox())!;

        const facts = hero.locator('[data-slot="today-hero-fact"]');
        const expected = digest.today.length;
        await expect(facts).toHaveCount(expected);
        const visible = await facts.evaluateAll(
          (items) =>
            items.filter((el) => (el as HTMLElement).offsetParent !== null)
              .length,
        );
        expect(visible).toBe(
          viewport.width < 768 ? Math.min(expected, 4) : expected,
        );

        // The all-clear sentence never sits under a lead or facts.
        await expect(
          hero.locator('[data-slot="today-hero-all-clear"]'),
        ).toHaveCount(0);

        if (expected === 0) {
          await expect(
            hero.locator('[data-slot="today-hero-today"]'),
          ).toHaveCount(0);
          // A quiet day keeps the full composition: lead beside the ring.
          await expect(hero).toHaveAttribute("data-layout", "narrative");
          return;
        }

        const block = hero.locator('[data-slot="today-hero-today"]');
        const blockBox = (await block.boundingBox())!;
        // The facts follow the lead.
        expect(blockBox.y).toBeGreaterThanOrEqual(
          leadBox.y + leadBox.height - 1,
        );
        if (viewport.width >= 768) {
          // Beside the ring on a wide screen, never under it.
          expect(blockBox.x + blockBox.width).toBeLessThanOrEqual(
            ringBox.x + 1,
          );
          expect(blockBox.y).toBeLessThan(ringBox.y + ringBox.height);
        } else {
          // Above the ring on a phone, so the day reads before the dial.
          expect(blockBox.y + blockBox.height).toBeLessThanOrEqual(
            ringBox.y + 1,
          );
        }

        // No fact line overflows its own box.
        const clipped = await facts.evaluateAll(
          (items) =>
            items.filter((el) => {
              const link = el.querySelector("a");
              return link ? link.scrollWidth > link.clientWidth + 1 : false;
            }).length,
        );
        expect(clipped).toBe(0);
      });
    }
  }

  test("the hero width does not move when the overview arrives", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let calls = 0;
    await mockDashboardSnapshot(page, { summaries: POPULATED_SUMMARIES });
    await page.route(/\/api\/daily\/digest(\?|$)/, async (route) => {
      calls += 1;
      // First paint: a quiet digest. Every later read carries the overview.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: calls > 1 ? STATES["ai-on"] : STATES.quiet,
          error: null,
        }),
      });
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const hero = page.locator('[data-slot="today-hero"]');
    await expect(hero).toBeVisible({ timeout: 15_000 });
    const before = (await hero.boundingBox())!;

    // The tab becomes visible again: the signal TanStack Query's focus
    // manager refetches on, as `today-just-in.spec.ts` uses.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(hero.locator('[data-slot="today-hero-today"]')).toBeVisible({
      timeout: 15_000,
    });
    const after = (await hero.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  });
});
