/**
 * The timeline journey (v1.42, #613), on its own account (`E2E_TIMELINE`).
 *
 *   1. Off by default: no navigation entry, and a deep link to /timeline
 *      lands on the module notice, not the page.
 *   2. Switching it on in Settings opens the readiness inventory; "Open
 *      timeline" goes there and the navigation entry appears.
 *   3. The timeline hands off to the day: "Open 3 Jan." and Enter on the
 *      chart both put `?day=` in the URL; an incoming `?day=` selects that
 *      day.
 *   4. A life event is entered through the sheet and posted in the
 *      contract's shape.
 *   5. The value lines: quarterly means over the years, a missing quarter
 *      left out, a short gap bridged dashed, a thin quarter hollow, and up
 *      to six lines.
 *   6. On a phone the chronicle replaces the chart, says its empty months
 *      out loud, names each quarter's means once, and a row opens its day.
 *
 * The timeline's server routes are mocked with the contract's shapes
 * (`utils/mock-timeline.ts`); the module switch is the real one. Every
 * assertion is addressed to a stable `data-*` attribute. The journey moves
 * its account's module switch, so it runs serially and in one project.
 */
import type { Page } from "@playwright/test";

import { TIMELINE_STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";
import { SYS_MISSING, SYS_THIN, mockTimeline } from "./utils/mock-timeline";

test.use({ storageState: TIMELINE_STORAGE_STATE_PATH });
test.describe.configure({ mode: "serial" });

/** Today in the zone the browser and the account run in. */
const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

async function setTimelineModule(page: Page, on: boolean): Promise<void> {
  const status = await page.evaluate(async (on) => {
    const res = await fetch("/api/auth/me/modules", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeline: on }),
    });
    return res.status;
  }, on);
  expect(status).toBe(200);
}

const navEntry = '[data-tour-id="nav-timeline"]';

test("is off by default: no navigation entry, a deep link meets the notice", async ({
  page,
}) => {
  await page.goto("/settings/modules");
  await setTimelineModule(page, false);
  await page.goto("/timeline");
  await expect(
    page.locator(
      '[data-slot="module-disabled-notice"][data-module="timeline"]',
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-slot="timeline-page"]')).toHaveCount(0);
  await expect(page.locator(navEntry)).toHaveCount(0);
});

test("switching it on opens the readiness inventory, which leads to the timeline", async ({
  page,
}) => {
  await mockTimeline(page, "ready", TODAY);
  await page.goto("/settings/modules");
  const toggle = page.locator("#module-toggle-timeline");
  await expect(toggle).toHaveAttribute("aria-checked", "false", {
    timeout: 20_000,
  });
  await toggle.click();

  const sheet = page.locator('[data-slot="timeline-readiness-sheet"]');
  await expect(sheet).toBeVisible();
  await expect(
    page.locator(
      '[data-slot="timeline-readiness-verdict"][data-verdict="carries"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="timeline-readiness-lane"][data-status="thin"]'),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '[data-slot="timeline-readiness-gap"][data-gap="lifeEventsEmpty"]',
    ),
  ).toHaveAttribute("href", "/timeline?add=lifeEvent");

  await page.locator('[data-slot="timeline-readiness-open"]').click();
  await expect(page).toHaveURL(/\/timeline$/);
  await expect(page.locator('[data-slot="timeline-page"]')).toBeVisible();
  await expect(page.locator(navEntry).first()).toBeAttached();
  // The card carries the open gaps onto the page until it is closed.
  await expect(
    page.locator('[data-slot="timeline-readiness-card"]'),
  ).toBeVisible();
  await page.locator('[data-slot="timeline-readiness-card-dismiss"]').click();
  await expect(
    page.locator('[data-slot="timeline-readiness-card"]'),
  ).toHaveCount(0);
});

test("the timeline hands the selected day to the day view through ?day=", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  const log = await mockTimeline(page, "full", TODAY);
  await page.goto("/timeline");

  const chart = page.locator('[data-slot="timeline-chart"]');
  await expect(chart).toBeVisible({ timeout: 20_000 });
  // Empty lanes are not drawn: the record has no labs.
  await expect(page.locator('svg [data-lane="labs"]')).toHaveCount(0);
  await expect(page.locator('svg [data-lane="illness"]')).toHaveCount(1);
  await expect(
    page.locator('[data-slot="timeline-legend-causality"]'),
  ).toHaveCount(0);
  const asked = log.timelineQueries.at(-1)?.get("values")?.split(",") ?? [];
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.length).toBeLessThanOrEqual(6);

  // Before anyone picks a day the bar opens on the newest bucket it has
  // something for, says so in its head, and says how to pick another.
  const bar = page.locator('[data-slot="timeline-selection-bar"]');
  await expect(bar).toHaveAttribute("data-bucket", "quarter");
  await expect(bar).toHaveAttribute(
    "data-period-from",
    /^\d{4}-(01|04|07|10)-01$/,
  );
  await expect(
    page.locator('[data-slot="timeline-selection-empty"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-slot="timeline-selection-hint"]'),
  ).toBeVisible();

  // The keyboard: one step back and Enter opens that day.
  const before = await page
    .locator('[data-slot="timeline-selection"]')
    .getAttribute("data-date");
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  const after = await page
    .locator('[data-slot="timeline-selection"]')
    .getAttribute("data-date");
  expect(after).not.toBe(before);
  // A day is picked now: the hint has done its job.
  await expect(
    page.locator('[data-slot="timeline-selection-hint"]'),
  ).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`[?&]day=${after}`));

  // "Open <day>" in the selection bar does the same for the selected day.
  await page.goto("/timeline?day=2026-01-03");
  const open = page.locator('[data-slot="timeline-open-day"]');
  await expect(open).toHaveAttribute("data-date", "2026-01-03", {
    timeout: 20_000,
  });
  await expect(
    page.locator('[data-slot="timeline-zoom"] [data-value="quarter"]'),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.locator('[data-slot="timeline-selection-chip"][data-item="ill-5"]'),
  ).toBeVisible();
  await page.goto("/timeline");
  await expect(chart).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-slot="timeline-zoom"] [data-value="year"]').click();
  await open.click();
  await expect(page).toHaveURL(/[?&]day=\d{4}-\d{2}-\d{2}/);
});

test("value lines: quarterly means, gaps kept, short ones bridged, up to six lines", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  const log = await mockTimeline(page, "full", TODAY);
  await page.goto("/timeline");
  const sys = page.locator('svg [data-series="BLOOD_PRESSURE_SYS"]');
  await expect(sys).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-slot="timeline-legend-mean"]'),
  ).toHaveAttribute("data-bucket", "quarter");

  const point = (t: string) =>
    sys.locator(`[data-slot="timeline-series-point"][data-t="${t}"]`);
  // A missing quarter stays missing: no point is drawn for it.
  for (const t of SYS_MISSING) await expect(point(t)).toHaveCount(0);
  // The quarters around Q2 2023 are joined by a dashed bridge; the three
  // missing quarters of 2021 are not (one bridge in the whole line).
  await expect(sys.locator('[data-slot="timeline-series-bridge"]')).toHaveCount(
    1,
  );
  await expect(point("2023-01-01")).toHaveCount(1);
  await expect(point("2023-07-01")).toHaveCount(1);
  // Two readings: drawn hollow; four and more: filled.
  await expect(point(SYS_THIN)).toHaveAttribute("data-thin", "true");
  await expect(point("2023-01-01")).toHaveAttribute("data-thin", "false");

  // The value table keeps the missing quarter as a row of its own.
  await expect(
    page.locator(
      '[data-slot="timeline-series-table"] [data-bucket="2023-04-01"]',
    ),
  ).toBeAttached();

  // Six value lines can be chosen; a seventh cannot.
  await page.locator('[data-slot="timeline-values-trigger"]').click();
  const options = page.locator('[data-slot="timeline-values-option"]');
  await expect(options.first()).toBeVisible();
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const checked = page.locator(
      '[data-slot="timeline-values-option"][aria-checked="true"]',
    );
    if ((await checked.count()) >= 6) break;
    const option = options.nth(i);
    if ((await option.getAttribute("aria-checked")) === "true") continue;
    await option.click();
  }
  await expect(
    page.locator('[data-slot="timeline-values-option"][aria-checked="true"]'),
  ).toHaveCount(6);
  await expect(
    page.locator(
      '[data-slot="timeline-values-option"][aria-checked="false"][data-disabled]',
    ),
  ).toHaveCount(count - 6);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => log.timelineQueries.at(-1)?.get("values")?.split(",").length)
    .toBe(6);
  await expect(page.locator("svg [data-series]")).toHaveCount(6);
  // Each line in its own colour, and every mark of a line in that colour.
  const colours = await page
    .locator("svg [data-series]")
    .evaluateAll((groups) =>
      groups.map((g) => ({
        colour: getComputedStyle(g).color,
        marks: [
          ...g.querySelectorAll(
            '[data-slot="timeline-series-line"], [data-slot="timeline-series-swatch"]',
          ),
        ].map((m) => getComputedStyle(m).stroke),
      })),
    );
  expect(new Set(colours.map((c) => c.colour)).size).toBe(6);
  for (const { colour, marks } of colours) {
    expect(marks.length).toBeGreaterThan(0);
    for (const stroke of marks) expect(stroke).toBe(colour);
  }
  // The menu marks each chosen line with the same colour.
  await page.locator('[data-slot="timeline-values-trigger"]').click();
  const dots = await page
    .locator(
      '[data-slot="timeline-values-option"][aria-checked="true"] [data-slot="timeline-values-dot"]',
    )
    .evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor),
    );
  expect(new Set(dots)).toEqual(new Set(colours.map((c) => c.colour)));
  await page.keyboard.press("Escape");
});

async function setTimelineModuleOn(page: Page) {
  await page.goto("/settings/modules");
  await setTimelineModule(page, true);
}

test("a life event is entered through the sheet, in the contract's shape", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  const log = await mockTimeline(page, "full", TODAY);
  await page.goto("/timeline?add=lifeEvent");
  const form = page.locator('[data-slot="life-event-form"]');
  await expect(form).toBeVisible({ timeout: 20_000 });

  // Saving an empty form says what is missing and sends nothing.
  await page.locator('[data-slot="life-event-save"]').click();
  await expect(form.locator('[aria-invalid="true"]').first()).toBeVisible();
  expect(log.lifeEventPosts).toHaveLength(0);

  await page
    .locator('[data-slot="life-event-title"]')
    .fill("Umzug nach Bochum");
  await page
    .locator('[data-slot="life-event-category"] [data-value="HOME"]')
    .click();
  await page
    .locator('[data-slot="life-event-precision"] [data-value="MONTH"]')
    .click();
  await expect(page.locator('[data-slot="life-event-privacy"]')).toBeVisible();
  await page.locator('[data-slot="life-event-save"]').click();

  await expect(form).toHaveCount(0);
  expect(log.lifeEventPosts).toHaveLength(1);
  const posted = log.lifeEventPosts[0] as Record<string, string | null>;
  expect(posted).toMatchObject({
    title: "Umzug nach Bochum",
    category: "HOME",
    precision: "MONTH",
    endDate: null,
    note: null,
  });
  expect(posted.startDate).toMatch(/^\d{4}-\d{2}-01$/);
  // The parameter left the URL with the sheet.
  await expect(page).toHaveURL(/\/timeline$/);
});

test("on a phone the chronicle replaces the chart and opens a day per row", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  await mockTimeline(page, "full", TODAY);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/timeline");

  const chronicle = page.locator('[data-slot="timeline-chronicle"]');
  await expect(chronicle).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-slot="timeline-chart"]')).toBeHidden();
  await expect(page.locator('[data-slot="timeline-standing"]')).toBeVisible();
  await expect(
    page.locator('[data-slot="timeline-chronicle-gap"]').first(),
  ).toBeVisible();
  // Quarterly means, each quarter named once, at its newest listed month.
  const means = page.locator('[data-slot="timeline-chronicle-means"]');
  await expect(means.first()).toBeVisible();
  const buckets = await means.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-bucket") ?? ""),
  );
  expect(buckets.length).toBeGreaterThan(0);
  expect(new Set(buckets).size).toBe(buckets.length);
  for (const b of buckets) expect(b).toMatch(/^\d{4}-(01|04|07|10)-01$/);
  // Each mean carries its line's colour dot.
  await expect(
    means.first().locator('[data-slot="timeline-series-dot"]').first(),
  ).toBeVisible();

  await page
    .locator(
      '[data-slot="timeline-chronicle-row"][data-date="2026-01-03"] button',
    )
    .first()
    .click();
  await expect(page).toHaveURL(/[?&]day=2026-01-03/);
});
