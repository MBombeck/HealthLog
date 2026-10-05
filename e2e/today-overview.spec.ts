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
 * see: the facts sit beside the ring on a wide screen; on a phone the ring is
 * a compact dial at the top right beside the lead and the facts run the full
 * card width under both; a phone shows four facts and a wide screen five,
 * nothing pushes the page sideways, the hero keeps the width of the cards
 * around it, and the ring keeps its size per breakpoint. Each state is also
 * captured as an element screenshot, in both themes, under
 * `test-results/today-overview/` for a visual check.
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
  { name: "narrow", width: 360, height: 780 },
] as const;

const THEMES = ["dark", "light"] as const;

/** The dial's edge per breakpoint: compact on a phone, md from 768 px. */
const RING_PX = { phone: 80, wide: 168 } as const;

/** Below this the lead beside the ring would read as a column of words. */
const MIN_LEAD_WIDTH = 180;

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
  signalLine: null,
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
    // The lead already talks about blood pressure, so the server keeps only
    // the delta under it.
    signalLine: {
      headline: null,
      delta: "↓ ~10 mmHg systolic vs the start of the window",
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
  // AI on with a long lead and a long sleep value: the phone case the ring
  // used to fall under the facts for.
  "ai-on-long": {
    ...BASE,
    score: {
      value: 63,
      band: "yellow",
      delta: -6,
      deltaReason: null,
      steadyWeeks: null,
    },
    lead: {
      text: "Your pulse sits well above its usual level this evening, after a shorter night than you normally get; a quieter evening would suit it.",
      source: "briefing",
    },
    signalLine: { headline: null, delta: "+34 bpm vs your 30-day average" },
    today: [
      FACTS[0],
      {
        kind: "sleep",
        label: "Last night",
        value: "5h 45m, 42m less than usual",
        href: "/insights/sleep",
        moduleKey: "sleep",
      },
      {
        kind: "vitals",
        label: "Vitals",
        value: "Pulse above your range",
        href: "/insights",
      },
    ],
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
    for (const theme of THEMES) {
      for (const [state, digest] of Object.entries(STATES)) {
        test(`${state} at ${viewport.width}px, ${theme}`, async ({ page }) => {
          // The app paints from its own stored preference, not the media
          // query, so both are set.
          await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: "reduce",
          });
          await page.addInitScript((value: string) => {
            window.localStorage.setItem("healthlog-theme", value);
          }, theme);
          await page.setViewportSize(viewport);
          const hero = await openDashboard(page, digest);
          const phone = viewport.width < 768;

          // Late banners (the key-backup nudge) insert above the hero; let
          // the page settle so the capture shows one stable layout.
          await page.waitForLoadState("networkidle");
          mkdirSync(SHOTS, { recursive: true });
          await hero.screenshot({
            path: join(SHOTS, `${viewport.name}-${theme}-${state}.png`),
          });
          // The viewport as a reader sees it, bottom navigation included.
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({
            path: join(
              SHOTS,
              `${viewport.name}-${theme}-${state}-viewport.png`,
            ),
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
          expect(Math.abs(heroBox.width - stripBox.width)).toBeLessThanOrEqual(
            1,
          );

          // The ring keeps its size: a compact dial on a phone, the same
          // 168 px dial as before from md up.
          const ring = hero.locator('[data-slot="score-ring"]').first();
          const ringBox = (await ring.boundingBox())!;
          const edge = phone ? RING_PX.phone : RING_PX.wide;
          expect(Math.round(ringBox.width)).toBe(edge);
          expect(Math.round(ringBox.height)).toBe(edge);

          const lead = hero.locator('[data-slot="today-hero-lead"]');
          await expect(lead).toBeVisible();
          await expect(lead).toHaveAttribute(
            "data-source",
            digest.lead!.source,
          );
          const leadBox = (await lead.boundingBox())!;

          // The ring sits at the top right, beside the lead, and the lead
          // keeps a readable width next to it.
          expect(ringBox.x).toBeGreaterThanOrEqual(leadBox.x + leadBox.width);
          expect(ringBox.y).toBeLessThan(leadBox.y + leadBox.height);
          expect(Math.abs(ringBox.y - leadBox.y)).toBeLessThanOrEqual(8);
          expect(leadBox.width).toBeGreaterThanOrEqual(MIN_LEAD_WIDTH);
          // Symmetric insets: the ring's right edge mirrors the lead's left.
          const leftInset = leadBox.x - heroBox.x;
          const rightInset =
            heroBox.x + heroBox.width - (ringBox.x + ringBox.width);
          expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(1);

          const facts = hero.locator('[data-slot="today-hero-fact"]');
          const expected = digest.today.length;
          await expect(facts).toHaveCount(expected);
          const visible = await facts.evaluateAll(
            (items) =>
              items.filter((el) => (el as HTMLElement).offsetParent !== null)
                .length,
          );
          expect(visible).toBe(phone ? Math.min(expected, 4) : expected);

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
          if (!phone) {
            // Beside the ring on a wide screen, never under it.
            expect(blockBox.x + blockBox.width).toBeLessThanOrEqual(
              ringBox.x + 1,
            );
            expect(blockBox.y).toBeLessThan(ringBox.y + ringBox.height);
          } else {
            // Under the dial on a phone, across the full card width.
            expect(blockBox.y).toBeGreaterThanOrEqual(
              ringBox.y + ringBox.height - 1,
            );
            expect(
              Math.abs(
                blockBox.x + blockBox.width - (ringBox.x + ringBox.width),
              ),
            ).toBeLessThanOrEqual(1);
            // Each tappable fact keeps the 44 px floor, label over value,
            // both on the reading edge.
            const rows = await facts.evaluateAll((items) =>
              items
                .filter((el) => (el as HTMLElement).offsetParent !== null)
                .map((el) => {
                  const link = el.querySelector("a")!;
                  const [label, value] = Array.from(link.children).map((c) =>
                    c.getBoundingClientRect(),
                  );
                  return {
                    height: link.getBoundingClientRect().height,
                    stacked: value.top >= label.bottom - 1,
                    sameEdge: Math.abs(value.left - label.left) <= 1,
                  };
                }),
            );
            for (const row of rows) {
              expect(row.height).toBeGreaterThanOrEqual(44);
              expect(row.stacked).toBe(true);
              expect(row.sameEdge).toBe(true);
            }
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
