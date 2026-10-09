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

  // Before anyone picks a day the bar opens on the newest bucket it has
  // something for, says so in its head, and says how to pick another.
  const bar = page.locator('[data-slot="timeline-selection-bar"]');
  // It sits on the card's own surface under a hairline, not in a grey box,
  // and the legend under it is set off by a hairline of its own.
  const surface = await bar.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      borderTop: style.borderTopWidth,
    };
  });
  expect(surface.background).toBe("rgba(0, 0, 0, 0)");
  expect(surface.borderTop).toBe("1px");
  await expect(page.locator('[data-slot="timeline-legend"]')).toHaveCSS(
    "border-top-width",
    "1px",
  );
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

  // An incoming ?day= selects that day; the selection bar has no separate
  // "Open <day>" link, a chip opens the day it touches.
  await page.goto("/timeline?day=2026-01-03");
  await expect(
    page.locator('[data-slot="timeline-selection"]'),
  ).toHaveAttribute("data-date", "2026-01-03", { timeout: 20_000 });
  await expect(
    page.locator('[data-slot="timeline-zoom"] [data-value="quarter"]'),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-slot="timeline-open-day"]')).toHaveCount(0);
  const chip = page.locator(
    '[data-slot="timeline-selection-chip"][data-item="ill-5"]',
  );
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(/[?&]day=\d{4}-\d{2}-\d{2}/);
});

test("value lines: quarterly means, gaps kept, short ones bridged, as many as the record has", async ({
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

  // The legend explains the dashed stroke and the hollow point.
  await expect(
    page.locator('[data-slot="timeline-legend-gap"] svg'),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="timeline-legend-thin"] svg'),
  ).toBeVisible();

  // The picker is one button that counts the lines; the chosen ones are
  // not listed beside it.
  const trigger = page.locator('[data-slot="timeline-values-trigger"]');
  await expect(trigger).toHaveAttribute("data-count", "3");
  await expect(trigger).toHaveText(/\(3\)/);
  const toolbarHeight = await trigger.evaluate(
    (el) => el.parentElement!.getBoundingClientRect().height,
  );

  // No cap: every series the record has can be chosen, fifteen here.
  await trigger.click();
  const options = page.locator('[data-slot="timeline-values-option"]');
  await expect(options.first()).toBeVisible();
  const count = await options.count();
  expect(count).toBe(15);
  await expect(
    page.locator('[data-slot="timeline-values-option"][data-disabled]'),
  ).toHaveCount(0);
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    if ((await option.getAttribute("aria-checked")) === "true") continue;
    await option.click();
  }
  await expect(
    page.locator('[data-slot="timeline-values-option"][aria-checked="true"]'),
  ).toHaveCount(15);
  // The menu marks each chosen line with its colour.
  const dots = await page
    .locator(
      '[data-slot="timeline-values-option"][aria-checked="true"] [data-slot="timeline-values-dot"]',
    )
    .evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor),
    );
  expect(dots).toHaveLength(15);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => log.timelineQueries.at(-1)?.get("values")?.split(",").length)
    .toBe(15);
  await expect(page.locator("svg [data-series]")).toHaveCount(15);
  await expect(trigger).toHaveAttribute("data-count", "15");
  // The toolbar did not grow with the choice.
  expect(
    await trigger.evaluate(
      (el) => el.parentElement!.getBoundingClientRect().height,
    ),
  ).toBe(toolbarHeight);
  // Each line in one colour, every mark of a line in that colour, the five
  // data colours repeating past the fifth line.
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
  expect(new Set(colours.map((c) => c.colour)).size).toBe(5);
  for (const { colour, marks } of colours) {
    expect(marks.length).toBeGreaterThan(0);
    for (const stroke of marks) expect(stroke).toBe(colour);
  }
  expect(new Set(dots)).toEqual(new Set(colours.map((c) => c.colour)));
  // The rows run on down the page, which scrolls; the last one is reached.
  const last = page.locator("svg [data-series]").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

test("one medication is one row: its doses cut the bar, its pause is a gap in it", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  await mockTimeline(page, "full", TODAY);
  await page.goto("/timeline");
  const lane = page.locator('svg [data-lane="medications"]');
  await expect(lane).toBeVisible({ timeout: 20_000 });
  // The medication's own span is not drawn beside its course.
  await expect(lane.locator('[data-item="mj"]')).toHaveCount(0);
  const pieces = lane.locator('[data-item="mj-course"]');
  await expect(pieces).toHaveCount(3);
  expect(
    await pieces.evaluateAll((els) => els.map((el) => el.dataset.dose)),
  ).toEqual(["2,5 mg", "5 mg", "7,5 mg"]);
  const rowOf = (selector: string) =>
    lane
      .locator(selector)
      .evaluateAll((els) => [...new Set(els.map((el) => el.dataset.row))]);
  const mounjaroRow = await rowOf('[data-item="mj-course"]');
  expect(mounjaroRow).toHaveLength(1);
  expect(await rowOf('[data-kind="pause"][data-item="mj-pause"]')).toEqual(
    mounjaroRow,
  );
  // Three winter courses of one medication share one row of their own.
  const vitamin = await rowOf('[data-item^="c-"]');
  expect(vitamin).toHaveLength(1);
  expect(vitamin).not.toEqual(mounjaroRow);
  // Four medications, four rows.
  const rows = await lane
    .locator("[data-row]")
    .evaluateAll((els) => new Set(els.map((el) => el.dataset.row)).size);
  expect(rows).toBe(4);
  // A zoom change redraws the pieces: none is left behind from the last
  // window (each piece has a key of its own).
  const zoom = (value: string) =>
    page.locator(`[data-slot="timeline-zoom"] [data-value="${value}"]`);
  await zoom("year").click();
  await expect(page).toHaveURL(/zoom=year/);
  await zoom("all").click();
  await expect(page).toHaveURL(/zoom=all/);
  await expect(pieces).toHaveCount(3);
});

/** `days` calendar days before `key`. */
function daysBefore(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

test("a chosen range lives in the URL: reload keeps it, Back returns to it", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  const log = await mockTimeline(page, "full", TODAY);
  await page.goto("/timeline");
  const chart = page.locator('[data-slot="timeline-chart"]');
  await expect(chart).toBeVisible({ timeout: 20_000 });
  const desktop = page.locator('[data-slot="timeline-desktop"]');
  const zoom = (value: string) =>
    page.locator(`[data-slot="timeline-zoom"] [data-value="${value}"]`);

  // Choosing "Range" opens its fields over the page, anchored to the
  // segment: the chart does not move, and the URL waits for "Apply".
  const before = await chart.boundingBox();
  await zoom("range").click();
  const popover = page.locator('[data-slot="timeline-range-popover"]');
  await expect(popover).toBeVisible();
  const fields = popover.locator('[data-slot="timeline-range"]');
  await expect(fields).toBeVisible();
  expect(await chart.boundingBox()).toEqual(before);
  await expect(desktop.locator('[data-slot="timeline-range"]')).toHaveCount(0);
  expect(page.url()).not.toContain("zoom=range");
  const anchor = await zoom("range").boundingBox();
  const box = await popover.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
  expect(Math.abs(box!.x - anchor!.x)).toBeLessThan(24);
  // Starts from what is on screen; "Apply" writes it down.
  await popover.locator('[data-slot="timeline-range-apply"]').click();
  await expect(popover).toHaveCount(0);
  await expect(page).toHaveURL(
    /[?&]zoom=range&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/,
  );

  // Three weeks: daily means, the bar headed by one day.
  const from = daysBefore(TODAY, 20);
  await page.goto(`/timeline?zoom=range&from=${from}&to=${TODAY}`);
  await expect(desktop).toHaveAttribute("data-from", from, {
    timeout: 20_000,
  });
  await expect(desktop).toHaveAttribute("data-to", TODAY);
  await expect(zoom("range")).toHaveAttribute("aria-checked", "true");
  await expect(
    page.locator('[data-slot="timeline-legend-mean"]'),
  ).toHaveAttribute("data-bucket", "day");
  await expect(
    page.locator('[data-slot="timeline-selection-bar"]'),
  ).toHaveAttribute("data-bucket", "day");
  const asked = log.timelineQueries.at(-1)!;
  expect(asked.get("zoom")).toBe("range");
  expect(asked.get("from")).toBe(from);
  expect(asked.get("to")).toBe(TODAY);

  // A reload keeps it.
  await page.reload();
  await expect(desktop).toHaveAttribute("data-from", from, {
    timeout: 20_000,
  });

  // A fixed zoom replaces it; Back brings it back.
  await zoom("year").click();
  await expect(page).toHaveURL(/[?&]zoom=year$/);
  await expect(desktop).not.toHaveAttribute("data-from", from);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`zoom=range&from=${from}`));
  await expect(desktop).toHaveAttribute("data-from", from);

  // Typing a start in the popover moves the range once it is applied.
  const later = daysBefore(TODAY, 10);
  await zoom("range").click();
  const start = popover.locator('[data-testid="timeline-range-from"]');
  await start.fill(later);
  await start.press("Enter");
  expect(page.url()).toContain(`from=${from}`);
  await popover.locator('[data-slot="timeline-range-apply"]').click();
  await expect(page).toHaveURL(new RegExp(`from=${later}&to=${TODAY}`));

  // A parameter it cannot read opens the whole record.
  await page.goto("/timeline?zoom=range&from=nonsense&to=2026-01-01");
  await expect(zoom("all")).toHaveAttribute("aria-checked", "true", {
    timeout: 20_000,
  });
  await expect(desktop).toHaveAttribute("data-zoom", "all");
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

  // One medication, one start: its course and its own span are one row,
  // with the dose taken then.
  const started = chronicle.locator(
    '[data-slot="timeline-chronicle-row"][data-date="2025-01-06"]',
  );
  await expect(started).toHaveCount(1);
  await expect(started).toContainText("Mounjaro");
  await expect(started).toContainText("2,5 mg");
  await expect(chronicle).not.toContainText("·");

  // A range is chosen in a sheet; the list underneath does not move.
  const listTop = (await chronicle.boundingBox())!.y;
  await page.locator('[data-slot="timeline-range-toggle"]').click();
  const sheet = page.locator('[data-slot="responsive-sheet-content"]');
  await expect(sheet.locator('[data-slot="timeline-range"]')).toBeVisible();
  expect((await chronicle.boundingBox())!.y).toBe(listTop);
  await sheet.locator('[data-slot="timeline-range-apply"]').click();
  await expect(page).toHaveURL(/[?&]zoom=range&from=\d{4}-\d{2}-\d{2}/);
  await page.goto("/timeline");
  await expect(chronicle).toBeVisible({ timeout: 20_000 });

  await page
    .locator(
      '[data-slot="timeline-chronicle-row"][data-date="2026-01-03"] button',
    )
    .first()
    .click();
  await expect(page).toHaveURL(/[?&]day=2026-01-03/);
});

/** A calendar date `days` before today, in the account's zone. */
function daysAgo(days: number): string {
  const at = new Date(`${TODAY}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

test("every medication still taken is drawn, from the account's real record", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  // Written through the app's own routes, once: a medication with a start
  // date (it opens a course), one without (its first intake is its start).
  const list = await page.request.get("/api/medications");
  const held = JSON.stringify(await list.json());
  const create = async (body: Record<string, unknown>) => {
    const res = await page.request.post("/api/medications", { data: body });
    expect(res.status()).toBeLessThan(300);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };
  if (!held.includes("E2E Ramipril")) {
    await create({
      name: "E2E Ramipril",
      dose: "5 mg",
      startsOn: daysAgo(40),
      schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
    });
  }
  if (!held.includes("E2E Vitamin D3")) {
    const id = await create({
      name: "E2E Vitamin D3",
      dose: "2000 IU",
      schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
    });
    const intake = await page.request.post(`/api/medications/${id}/intake`, {
      data: { takenAt: new Date(Date.now() - 20 * 86_400_000).toISOString() },
    });
    expect(intake.status()).toBeLessThan(300);
  }

  await page.goto("/timeline?zoom=quarter");
  const lane = page.locator('svg [data-lane="medications"]');
  await expect(lane).toHaveCount(1, { timeout: 20_000 });
  // One row each, and every one of them reaches today.
  for (const name of ["E2E Ramipril", "E2E Vitamin D3"]) {
    const bars = lane.locator("g[data-row]", {
      has: page.locator(`title:text-matches("^${name}")`),
    });
    await expect(bars.first()).toBeAttached();
    const rows = await bars.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-row")),
    );
    expect(new Set(rows).size).toBe(1);
  }
});

test("an open day stays open from the timeline to another page", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  await mockTimeline(page, "full", TODAY);
  await page.setViewportSize({ width: 1440, height: 900 });
  const day = daysAgo(3);
  await page.goto(`/timeline?day=${day}`);
  const panel = page.locator('[data-slot="day-panel"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });

  await page.locator('a[href="/labs"]').first().click();
  await expect(page).toHaveURL(new RegExp(`/labs\\?(.*&)?day=${day}`));
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
    "data-day",
    day,
  );

  // Folded by the person, it stays folded on the next page.
  await page.locator('[data-slot="day-close"]').click();
  await expect(panel).toHaveCount(0);
  await page.locator('a[href="/timeline"]').first().click();
  await expect(page).toHaveURL(/\/timeline$/);
  await expect(page.locator('[data-slot="day-strip"]')).toHaveAttribute(
    "data-state",
    "closed",
  );
  await expect(panel).toHaveCount(0);
});

test("a value point reads on its own, by pointer and by keyboard", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  await mockTimeline(page, "full", TODAY);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/timeline");
  const targets = page.locator('[data-slot="timeline-point-target"]');
  await expect(targets.first()).toBeAttached({ timeout: 20_000 });

  const target = targets.last();
  const series = await target.getAttribute("data-series");
  const t = await target.getAttribute("data-t");
  await target.hover();
  const tip = page.locator('[data-slot="timeline-point-tip"]');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute("data-series", series!);
  await expect(tip).toHaveAttribute("data-t", t!);
  // One line only, never the whole bucket.
  await expect(tip.locator('[data-slot="rich-chart-tooltip-row"]')).toHaveCount(
    1,
  );
  // Inside the chart, and the page does not scroll sideways for it.
  const chart = (await page
    .locator('[data-slot="timeline-chart"]')
    .boundingBox())!;
  const box = (await tip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(chart.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(chart.x + chart.width + 1);

  // The keyboard: focus shows the card, the arrows walk the line.
  await page.mouse.move(0, 0);
  await target.focus();
  await expect(tip).toHaveAttribute("data-t", t!);
  await page.keyboard.press("ArrowLeft");
  await expect(tip).not.toHaveAttribute("data-t", t!);
  await expect(tip).toHaveAttribute("data-series", series!);
});

test("the timeline page ends where its content does, at every desktop width", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  await mockTimeline(page, "full", TODAY);
  for (const width of [1280, 1440, 1920]) {
    for (const day of [null, daysAgo(3)]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(day ? `/timeline?day=${day}` : "/timeline");
      await expect(
        page.locator('[data-slot="timeline-chart"] > svg'),
      ).toBeVisible({ timeout: 20_000 });
      const m = await page.evaluate(() => {
        const main = document.getElementById("main-content")!;
        const page = document.querySelector('[data-slot="timeline-page"]')!;
        const doc = document.scrollingElement!;
        return {
          mainSw: main.scrollWidth,
          mainCw: main.clientWidth,
          docSw: doc.scrollWidth,
          docCw: doc.clientWidth,
          docSh: doc.scrollHeight,
          docCh: doc.clientHeight,
          mainSh: main.scrollHeight,
          contentBottom:
            page.getBoundingClientRect().bottom -
            main.getBoundingClientRect().top +
            main.scrollTop,
        };
      });
      const where = `${width}px ${day ? "with" : "without"} the day`;
      expect(m.mainSw, where).toBeLessThanOrEqual(m.mainCw + 1);
      expect(m.docSw, where).toBeLessThanOrEqual(m.docCw + 1);
      expect(m.docSh, where).toBeLessThanOrEqual(m.docCh + 1);
      // The shell's own buffer below the last card (pb-20 and the top
      // padding), nothing more.
      expect(m.mainSh, where).toBeLessThanOrEqual(m.contentBottom + 104 + 2);
    }
  }
});

test("listing all of a day's values scrolls the panel, never the page", async ({
  page,
}) => {
  await setTimelineModuleOn(page);
  await mockTimeline(page, "full", TODAY);
  const day = daysAgo(3);
  const types = [
    "WEIGHT",
    "BODY_FAT",
    "PULSE",
    "RESTING_HEART_RATE",
    "HEART_RATE_VARIABILITY",
    "RESPIRATORY_RATE",
    "OXYGEN_SATURATION",
    "BODY_TEMPERATURE",
    "MUSCLE_MASS",
    "BONE_MASS",
    "FAT_MASS",
    "VISCERAL_FAT",
    "BLOOD_GLUCOSE",
    "ACTIVITY_STEPS",
  ];
  await page.route(`**/api/day/${day}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          date: day,
          tz: "Europe/Berlin",
          counts: { values: types.length, entries: 0 },
          running: [],
          values: types.map((type, i) => ({
            type,
            value: 10 + i,
            unit: "u",
            at: `${day}T0${i % 10}:00:00.000Z`,
            source: "MANUAL",
            band: null,
          })),
          events: [],
          notable: [],
          scores: [],
          sections: {},
        },
        error: null,
      }),
    }),
  );
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(`/timeline?day=${day}`);
  const all = page.locator('[data-slot="day-values-all"]');
  await expect(all).toBeVisible({ timeout: 20_000 });
  const heights = () =>
    page.evaluate(() => ({
      doc: document.scrollingElement!.scrollHeight,
      main: document.getElementById("main-content")!.scrollHeight,
    }));
  const before = await heights();
  await all.click();
  await expect(all).toHaveAttribute("aria-expanded", "true");
  const after = await heights();
  expect(Math.abs(after.doc - before.doc)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.main - before.main)).toBeLessThanOrEqual(2);
});

test("the day's strip stays at the right edge, opens and closes the day, and never moves", async ({
  page,
}, testInfo) => {
  await setTimelineModuleOn(page);
  await mockTimeline(page, "full", TODAY);
  const strip = page.locator('[data-slot="day-strip"]');
  const toggle = page.locator('[data-slot="day-strip-toggle"]');
  const panel = page.locator('[data-slot="day-panel"]');
  const where = async () => {
    const box = (await strip.boundingBox())!;
    return [box.x, box.y, box.width, box.height].map(Math.round);
  };
  const measure = () =>
    page.evaluate(() => {
      const main = document.getElementById("main-content")!;
      const doc = document.scrollingElement!;
      return {
        docSw: doc.scrollWidth - doc.clientWidth,
        docSh: doc.scrollHeight - doc.clientHeight,
        mainSw: main.scrollWidth - main.clientWidth,
        bar: document
          .querySelector('[data-slot="top-bar"]')!
          .getBoundingClientRect().bottom,
      };
    });

  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/timeline");
    await expect(
      page.locator('[data-slot="timeline-chart"] > svg'),
    ).toBeVisible({ timeout: 20_000 });

    // Closed: the strip is there, at the right edge, below the top bar's
    // band, holding today.
    await expect(strip).toHaveAttribute("data-state", "closed");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const closed = await where();
    expect(closed[0] + closed[2], `${width}px right edge`).toBe(width);
    const before = await measure();
    expect(
      Math.round((await toggle.boundingBox())!.y),
      `${width}px below the band`,
    ).toBe(Math.round(before.bar));
    expect(before.docSw).toBeLessThanOrEqual(0);
    expect(before.mainSw).toBeLessThanOrEqual(0);

    // A click opens the day left of the strip; the strip stays put.
    await toggle.click();
    await expect(panel).toHaveAttribute("data-shell", "docked");
    await expect(strip).toHaveAttribute("data-state", "open");
    await expect(page.locator("#day-docked-panel")).toHaveAttribute(
      "data-state",
      "open",
    );
    await expect
      .poll(async () => {
        const box = (await panel.boundingBox())!;
        return Math.round(box.x + box.width);
      })
      .toBe(closed[0]);
    expect(await where()).toEqual(closed);
    await expect(panel.locator("h2").first()).toBeFocused();
    const open = await measure();
    expect(open.docSw, `${width}px open, sideways`).toBeLessThanOrEqual(0);
    expect(open.mainSw, `${width}px open, sideways`).toBeLessThanOrEqual(0);
    expect(open.docSh, `${width}px open, page height`).toBeLessThanOrEqual(
      before.docSh,
    );
    await testInfo.attach(`day-strip-${width}-open`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // A second click closes it; focus stays on the strip, which stays put.
    await toggle.click();
    await expect(panel).toHaveCount(0);
    await expect(strip).toHaveAttribute("data-state", "closed");
    await expect(toggle).toBeFocused();
    expect(await where()).toEqual(closed);
    await expect(page).toHaveURL(/\/timeline$/);
  }

  // Both themes, open at 1440.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/timeline");
    await toggle.click();
    await expect(panel).toHaveAttribute("data-shell", "docked");
    await testInfo.attach(`day-strip-1440-${colorScheme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await toggle.click();
    await expect(panel).toHaveCount(0);
  }
});
