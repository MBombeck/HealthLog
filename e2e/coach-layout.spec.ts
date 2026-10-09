import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, Request, Route, TestInfo } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";
import { mockDay } from "./setup/day-mock";

/**
 * The Coach page frame: the conversation, the conversations panel right of
 * it, and the day right of that; New conversation floating in the
 * conversation itself.
 *
 * Contracts under test, at 1920, 1440, 1280 and 390 px:
 *
 *   1. From 1280 px the panel docks beside the thread, open on a first visit.
 *      From 1440 px the reading column (thread and composer) is exactly as
 *      wide with the panel open as folded; at 1280 the two strips leave the
 *      open column below its cap, so folding widens it up to the cap. Its 40 px strip stays at the right edge,
 *      left of the day's, open or not, and never moves: a click opens the
 *      panel left of the strips, a second click shuts it; the choice
 *      survives a reload. The panel is flush with the strips and runs from
 *      the top of the window to the bottom; the top bar ends at its left
 *      edge and the panel's header border is the top bar's. Focus moves
 *      between the fold control and the strip, and Escape inside the open
 *      panel folds it.
 *   2. New conversation is a round 56 px button in the conversation column,
 *      never over the panel, never over the composer's field, and absent
 *      from the panel's header.
 *   3. A row's menu renames by keyboard (Escape cancels without closing the
 *      panel, Enter saves once) and deletes with an Undo that keeps the
 *      DELETE from ever leaving; a delete left alone commits once.
 *   4. The gear opens the quick settings as a popover; Escape closes it and
 *      focus returns to the gear. `/coach?settings=data` opens it on "What I
 *      can see" and drops the param from the URL.
 *   5. axe finds nothing on the open panel or the open settings, in the
 *      light and the dark theme.
 *   6. The day docks right of the panel. At 1440 only one of the two is
 *      open: a day folds the panel, opening the panel folds the day. At 1920
 *      both stay open and the conversation keeps at least 560 px.
 *   7. At 390 px the panel is a dialog sheet opened from the top bar's
 *      toggle; Escape closes it and focus returns to the toggle. The gear
 *      opens a bottom sheet that closes on Escape back to the gear. New
 *      conversation sits above the composer. Nothing scrolls sideways.
 *
 * Every Coach route is stubbed; the provider chain and provider config are
 * stubbed too, so the model section renders the same on every machine.
 * Screenshots are attached to the report (no pixel baselines).
 */

// A fixed midday, pinned in the browser too (see beforeEach): the panel groups
// conversations by the browser's local day, so a run just after midnight in
// the runner's or the profile's zone would move "an hour ago" into yesterday.
const NOW = Date.parse("2026-06-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

function conversations(): Conversation[] {
  return [
    {
      id: "frame-bp",
      title: "Blood pressure this week",
      updatedAt: new Date(NOW - HOUR).toISOString(),
    },
    {
      id: "frame-sleep",
      title: "Sleep since May",
      updatedAt: new Date(NOW - 26 * HOUR).toISOString(),
    },
    {
      id: "frame-weight",
      title: "Weight over the summer",
      updatedAt: new Date(NOW - 10 * 24 * HOUR).toISOString(),
    },
  ];
}

const ANSWER =
  "Your blood pressure held a steady band this week. The mornings ran a little higher than the evenings, which is common and nothing that stands out on its own.";

function fulfilJson(route: Route, data: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

interface CoachMock {
  patches: Array<{ id: string; title: string }>;
  deletes: string[];
}

async function mockCoach(page: Page): Promise<CoachMock> {
  const state = conversations();
  const mock: CoachMock = { patches: [], deletes: [] };

  const dto = (c: Conversation) => ({
    id: c.id,
    title: c.title,
    createdAt: c.updatedAt,
    updatedAt: c.updatedAt,
    messageCount: 2,
    fenced: false,
    attachments: [],
    documentTitle: null,
  });

  await page.route(
    /\/api\/insights\/chat(?:\/[^?]+)?(?:\?.*)?$/,
    async (route: Route, request: Request) => {
      const url = new URL(request.url());
      const match = url.pathname.match(/^\/api\/insights\/chat\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const found = state.find((c) => c.id === id);
        if (request.method() === "PATCH") {
          const { title } = request.postDataJSON() as { title: string };
          mock.patches.push({ id, title });
          if (found) found.title = title;
          return fulfilJson(route, { id, title });
        }
        if (request.method() === "DELETE") {
          mock.deletes.push(id);
          const idx = state.findIndex((c) => c.id === id);
          if (idx >= 0) state.splice(idx, 1);
          return fulfilJson(route, { deleted: true });
        }
        if (!found) return fulfilJson(route, null, 404);
        return fulfilJson(route, {
          ...dto(found),
          attachmentCount: 0,
          summary: null,
          messages: [
            {
              id: `${id}-u`,
              role: "user",
              content: `Tell me about ${found.title.toLowerCase()}.`,
              createdAt: found.updatedAt,
              metricSource: null,
              providerType: null,
              promptVersion: null,
              tokensUsed: null,
              model: null,
            },
            {
              id: `${id}-a`,
              role: "assistant",
              content: ANSWER,
              createdAt: found.updatedAt,
              metricSource: null,
              providerType: "mock",
              promptVersion: "e2e",
              tokensUsed: 640,
              model: "mock",
            },
          ],
        });
      }
      if (url.pathname.startsWith("/api/insights/chat/")) {
        return fulfilJson(route, { results: [] });
      }
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return fulfilJson(route, {
        conversations: state
          .filter((c) => c.title.toLowerCase().includes(q))
          .map(dto),
        nextCursor: null,
      });
    },
  );
  await page.route("**/api/insights/coach/nudge-status*", (route) =>
    fulfilJson(route, { nudgedAt: null, unread: false }),
  );
  await page.route("**/api/coach/about-me/questions*", (route) =>
    fulfilJson(route, { questions: [] }),
  );
  await page.route("**/api/insights/provider-chain", (route) =>
    route.request().method() === "GET"
      ? fulfilJson(route, {
          activeProvider: "local",
          cachedActiveProvider: "local",
          configuredChain: [
            { providerType: "local", enabled: true, available: true },
            { providerType: "admin-openai", enabled: true, available: true },
          ],
        })
      : fulfilJson(route, { saved: true }),
  );
  await page.route("**/api/user/ai-provider", (route) =>
    route.request().method() === "GET"
      ? fulfilJson(route, {
          provider: "LOCAL",
          model: "qwen2.5",
          baseUrl: "http://localhost:11434/v1",
          hasAnthropicKey: false,
          anthropicKeyPreview: null,
          hasLocalKey: false,
          hasOpenaiKey: false,
          openaiKeyPreview: null,
          compatBaseUrl: null,
          compatModel: null,
          hasCompatKey: false,
          responseTimeoutSeconds: null,
          localReasoningEffort: null,
          compatReasoningEffort: null,
        })
      : fulfilJson(route, { updated: true }),
  );
  return mock;
}

const toggle = (page: Page) => page.locator('[data-slot="coach-panel-toggle"]');
const collapse = (page: Page) =>
  page.locator('[data-slot="coach-panel-collapse"]');
const expand = (page: Page) =>
  page.locator('[data-slot="coach-panel-strip-toggle"]');
const strip = (page: Page) => page.locator('[data-slot="coach-panel-strip"]');
const dayStrip = (page: Page) => page.locator('[data-slot="day-strip"]');
const fab = (page: Page) => page.locator('[data-slot="coach-new-chat-fab"]');
const dayPanel = (page: Page) => page.locator('[data-slot="day-panel"]');
const panel = (page: Page) =>
  page.locator('[data-slot="coach-conversations-panel"]');

/** Width of the reading column: the thread's capped inner column. */
async function columnWidths(page: Page) {
  const thread = page.locator('[data-slot="coach-message-thread"] > *').first();
  const composer = page.locator('[data-slot="coach-page-composer"] > div');
  const t = await thread.boundingBox();
  const c = await composer.boundingBox();
  expect(t, "thread column").not.toBeNull();
  expect(c, "composer column").not.toBeNull();
  return { thread: t!.width, composer: c!.width, threadX: t!.x };
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const main = document.getElementById("main-content")!;
    return {
      doc: doc.scrollWidth - doc.clientWidth,
      main: main.scrollWidth - main.clientWidth,
    };
  });
  expect(overflow.doc).toBeLessThanOrEqual(0);
  expect(overflow.main).toBeLessThanOrEqual(0);
}

/**
 * The docked panel is flush with its strips: the conversations' strip sits
 * right of the panel and the day's right of that, against the viewport's
 * right edge (no scrollbar gutter beside them). The panel runs from the top
 * of the window to the bottom, the top bar ends at its left edge, an open
 * panel's header row has the top bar's bottom border, and its own border
 * is the left one only. Both strips start below the top bar's band.
 */
async function expectPanelFlush(page: Page, width: number, height: number) {
  const geometry = await page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const outer = document.querySelector(
      '[data-slot="coach-conversations-panel"]',
    )!;
    const inner = outer.querySelector("aside");
    const style = inner ? getComputedStyle(inner) : null;
    const main = document.getElementById("main-content")!;
    const panel = outer.getBoundingClientRect();
    return {
      panel: {
        left: panel.left,
        right: panel.right,
        top: panel.top,
        bottom: panel.bottom,
      },
      header:
        box('[data-slot="coach-conversations-panel-header"]')?.bottom ?? null,
      bar: box('[data-slot="top-bar"]')!,
      list: box('[data-slot="coach-panel-strip"]')!,
      listButton: box('[data-slot="coach-panel-strip-toggle"]')!,
      day: box('[data-slot="day-strip"]')!,
      dayDock: box("#day-docked-panel")!,
      gutter: main.offsetWidth - main.clientWidth,
      borders: style
        ? [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ]
        : null,
    };
  });
  expect(geometry.day.right).toBe(width);
  expect(geometry.list.right).toBe(geometry.day.left);
  expect(Math.round(geometry.list.width)).toBe(40);
  expect(Math.round(geometry.day.width)).toBe(40);
  // Conversations, then the day (open or slid to nothing), then the strips.
  expect(geometry.panel.right).toBe(geometry.dayDock.left);
  expect(geometry.dayDock.right).toBe(geometry.list.left);
  expect(geometry.panel.top).toBe(0);
  expect(geometry.panel.bottom).toBe(height);
  expect(geometry.bar.right).toBe(geometry.panel.left);
  // The strips start below the band; the palette's corner stays the bar's.
  expect(geometry.listButton.top).toBe(geometry.bar.bottom);
  if (geometry.header !== null) {
    expect(geometry.header).toBe(geometry.bar.bottom);
    expect(geometry.borders).toEqual(["0px", "0px", "0px", "1px"]);
  }
  expect(geometry.gutter).toBe(0);
}

/** Where a strip stands on screen. */
async function stripBox(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: Math.round(box.x), width: Math.round(box.width) };
}

/**
 * New conversation floats in the conversation column: a round 56 px button
 * with a plus and its name, inside the column (never over a docked panel
 * right of it) and clear of the composer's field. The panel's header has no
 * such control.
 */
async function expectNewChatFab(page: Page) {
  await expect(fab(page)).toHaveCount(1);
  await expect(fab(page)).toHaveAttribute("aria-label", "New conversation");
  await expect(fab(page).locator("svg.lucide-plus")).toHaveCount(1);
  await expect(
    panel(page).locator('[data-slot="coach-panel-new-chat"]'),
  ).toHaveCount(0);
  const box = (await fab(page).boundingBox())!;
  expect(Math.round(box.width)).toBe(56);
  expect(Math.round(box.height)).toBe(56);
  const main = (await page
    .locator('[data-slot="coach-page-main"]')
    .boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(main.x);
  expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width);
  const field = (await page
    .locator(
      '[data-slot="coach-page-composer"] [data-slot="coach-input-textarea"]',
    )
    .boundingBox())!;
  const overlaps =
    box.x < field.x + field.width &&
    box.x + box.width > field.x &&
    box.y < field.y + field.height &&
    box.y + box.height > field.y;
  expect(overlaps, "the button leaves the composer's field free").toBe(false);
}

/** Rendered heights of the docked panel's header buttons and first row. */
async function panelControlHeights(page: Page) {
  const height = async (slot: string) =>
    Math.round(
      (await panel(page)
        .locator(`[data-slot="${slot}"]`)
        .first()
        .boundingBox())!.height,
    );
  return {
    collapse: await height("coach-panel-collapse"),
    plans: await height("coach-panel-plans"),
    gear: await height("coach-settings"),
    row: await height("coach-history-select"),
  };
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
  const dir = process.env.COACH_SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/**
 * Record every mount of the conversations sheet from the first byte on.
 * Reads the added nodes rather than the live DOM, so a sheet that mounts and
 * unmounts again before the observer's callback runs is still counted.
 */
async function watchSheetMounts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __coachSheetSeen?: boolean };
    w.__coachSheetSeen = false;
    const sheet = '[role="dialog"][data-slot="coach-conversations-panel"]';
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches(sheet) || node.querySelector(sheet))
          ) {
            w.__coachSheetSeen = true;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function sheetMounted(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __coachSheetSeen?: boolean }).__coachSheetSeen ===
      true,
  );
}

async function openCoach(page: Page, path = "/coach?c=frame-bp") {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-slot="coach-message-thread"]').getByText(ANSWER),
  ).toBeVisible({ timeout: 15_000 });
}

async function waitForWidth(locator: Locator, width: number) {
  await expect
    .poll(async () => Math.round((await locator.boundingBox())?.width ?? -1))
    .toBe(width);
}

test.describe("Coach page frame", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "each case sets its own viewport; the desktop project runs them all",
    );
    await page.clock.setFixedTime(new Date(NOW));
    await serveAiBlock(page, aiBlockAvailable());
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  for (const width of [1440, 1280]) {
    test(`${width}: the panel docks, toggles, persists, and the reading column never changes width`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await mockCoach(page);
      await openCoach(page);

      // First visit: open.
      await expect(panel(page)).toHaveAttribute("data-state", "open");
      await waitForWidth(panel(page), 288);
      // Docked, the fold control lives in the panel; the top bar has none.
      await expect(toggle(page)).toHaveCount(0);
      await expect(collapse(page)).toHaveAttribute("aria-expanded", "true");
      await expect(collapse(page)).toHaveAttribute(
        "aria-controls",
        "coach-conversations-panel",
      );
      const open = await columnWidths(page);
      // The full 672 px column at 1440; at 1280 the two strips take 80 px
      // of it and the column stays well above the 560 px floor.
      if (width === 1440) expect(open.thread).toBeCloseTo(672, 0);
      else expect(open.thread).toBeGreaterThanOrEqual(560);
      expect(Math.abs(open.composer - open.thread)).toBeLessThanOrEqual(1);
      // The panel sits right of the column, never over it.
      const aside = (await panel(page).boundingBox())!;
      expect(aside.x).toBeGreaterThanOrEqual(open.threadX + open.thread);
      await expectPanelFlush(page, width, 900);
      await expectNewChatFab(page);
      // The bar says where the reader is: the page, then the conversation.
      await expect(
        page.locator('[data-slot="coach-top-bar-trail"]'),
      ).toHaveText(/Coach.*Blood pressure this week/);
      await expectNoSidewaysScroll(page);
      await shot(page, testInfo, `coach-frame-${width}-open`);

      // The strip stands still through a fold and an open.
      const stripOpen = await stripBox(strip(page));
      await expect(expand(page)).toHaveAttribute("aria-expanded", "true");

      // Folded: the panel slides to nothing, the strip takes the focus, and
      // the top bar ends at the strips.
      await collapse(page).click();
      await expect(panel(page)).toHaveAttribute("data-state", "closed");
      await waitForWidth(panel(page), 0);
      expect(await stripBox(strip(page))).toEqual(stripOpen);
      await expect(expand(page)).toBeFocused();
      await expect(expand(page)).toHaveAttribute("aria-expanded", "false");
      await expect(expand(page)).toHaveAttribute(
        "aria-label",
        "Show conversations",
      );
      await expect(
        panel(page).locator('[data-slot="coach-history-select"]'),
      ).toHaveCount(0);
      await expectPanelFlush(page, width, 900);
      const closed = await columnWidths(page);
      if (width === 1440) {
        expect(Math.abs(closed.thread - open.thread)).toBeLessThanOrEqual(1);
      } else {
        // At 1280 the strips leave the open column below its 672 px cap, so
        // folding the list gives the column back what it lacked, and no more.
        expect(closed.thread).toBeGreaterThanOrEqual(open.thread);
        expect(closed.thread).toBeLessThanOrEqual(672 + 1);
      }
      expect(Math.abs(closed.composer - closed.thread)).toBeLessThanOrEqual(1);
      await expectNewChatFab(page);
      await expectNoSidewaysScroll(page);
      await shot(page, testInfo, `coach-frame-${width}-closed`);

      // Remembered across a reload.
      await openCoach(page);
      await expect(panel(page)).toHaveAttribute("data-state", "closed");

      // A click on the strip opens it, a second click shuts it, and the
      // strip does not move either time.
      await expand(page).click();
      await expect(panel(page)).toHaveAttribute("data-state", "open");
      expect(await stripBox(strip(page))).toEqual(stripOpen);
      await expand(page).click();
      await expect(panel(page)).toHaveAttribute("data-state", "closed");
      await expect(expand(page)).toBeFocused();
      expect(await stripBox(strip(page))).toEqual(stripOpen);

      // Opened from the keyboard, focus lands on the fold control; Escape
      // from inside folds it again and focus goes back to the strip.
      await expand(page).focus();
      await page.keyboard.press("Enter");
      await expect(panel(page)).toHaveAttribute("data-state", "open");
      await expect(collapse(page)).toBeFocused();
      await panel(page)
        .locator('[data-slot="coach-history-select"]')
        .first()
        .focus();
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveAttribute("data-state", "closed");
      await expect(expand(page)).toBeFocused();
    });
  }

  test("1440: the day and the conversations take turns, focus included", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockCoach(page);
    await mockDay(page);
    const day = "2026-06-01";
    await page.goto(`/coach?c=frame-bp&day=${day}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.locator('[data-slot="coach-message-thread"]').getByText(ANSWER),
    ).toBeVisible({ timeout: 15_000 });

    // The day opens docked, left of the strips, and the conversations
    // close for it; both strips stay.
    await expect(dayPanel(page)).toHaveAttribute("data-shell", "docked");
    await expect(panel(page)).toHaveAttribute("data-state", "closed");
    await waitForWidth(panel(page), 0);
    const dayBox = (await dayPanel(page).boundingBox())!;
    const listStrip = (await strip(page).boundingBox())!;
    expect(Math.round(dayBox.x + dayBox.width)).toBe(Math.round(listStrip.x));
    expect(Math.round(listStrip.x + listStrip.width)).toBe(1400);
    await expect(dayStrip(page)).toHaveAttribute("data-state", "open");
    await expectPanelFlush(page, 1440, 900);
    await expectNewChatFab(page);
    expect(
      (await page.locator('[data-slot="coach-page-main"]').boundingBox())!
        .width,
    ).toBeGreaterThanOrEqual(540);
    await expectNoSidewaysScroll(page);
    await shot(page, testInfo, "coach-frame-1440-day");

    // Opening the conversations closes the day; its strip keeps the day,
    // focus goes to the conversations' fold control, the day is out of the
    // URL, and the conversation stays the same.
    await expand(page).click();
    await expect(panel(page)).toHaveAttribute("data-state", "open");
    await expect(dayPanel(page)).toHaveCount(0);
    await expect(dayStrip(page)).toHaveAttribute("data-day", day);
    await expect(dayStrip(page)).toHaveAttribute("data-state", "closed");
    await expect(collapse(page)).toBeFocused();
    await expect(page).toHaveURL(/\/coach\?c=frame-bp$/);
    await expectNewChatFab(page);
    await shot(page, testInfo, "coach-frame-1440-list");

    // And back: the day's strip opens the day, the conversations close.
    await page.locator('[data-slot="day-strip-toggle"]').click();
    await expect(dayPanel(page)).toHaveAttribute("data-shell", "docked");
    await expect(panel(page)).toHaveAttribute("data-state", "closed");
    await expect(page).toHaveURL(new RegExp(`c=frame-bp&day=${day}$`));

    // Switching conversations keeps the day open.
    await expand(page).click();
    await page.locator('[data-slot="day-strip-toggle"]').click();
    await expect(dayPanel(page)).toBeVisible();
    await fab(page).click();
    await expect(page).toHaveURL(new RegExp(`/coach\\?day=${day}$`));
    await expect(dayPanel(page)).toBeVisible();
  });

  test("1920: the conversations and the day stay open side by side", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await mockCoach(page);
    await mockDay(page);
    await page.goto("/coach?c=frame-bp&day=2026-06-01", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.locator('[data-slot="coach-message-thread"]').getByText(ANSWER),
    ).toBeVisible({ timeout: 15_000 });
    await expect(dayPanel(page)).toHaveAttribute("data-shell", "docked");
    await expect(panel(page)).toHaveAttribute("data-state", "open");
    await waitForWidth(panel(page), 288);
    const list = (await panel(page).boundingBox())!;
    const dayBox = (await dayPanel(page).boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(dayBox.x + 1);
    await expectPanelFlush(page, 1920, 1000);
    expect(
      (await page.locator('[data-slot="coach-page-main"]').boundingBox())!
        .width,
    ).toBeGreaterThanOrEqual(560);
    await expectNewChatFab(page);
    await expectNoSidewaysScroll(page);
    await shot(page, testInfo, "coach-frame-1920-both");

    // Folding one leaves the other alone.
    await collapse(page).click();
    await expect(panel(page)).toHaveAttribute("data-state", "closed");
    await expect(dayPanel(page)).toBeVisible();
    await expand(page).click();
    await expect(panel(page)).toHaveAttribute("data-state", "open");
    await expect(dayPanel(page)).toBeVisible();
  });

  test("1280 fine pointer: compact header buttons and rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockCoach(page);
    await openCoach(page);
    expect(await panelControlHeights(page)).toEqual({
      collapse: 28,
      plans: 28,
      gear: 28,
      row: 36,
    });
  });

  test.describe("touch", () => {
    // A touch tablet in landscape docks the panel too; the controls keep the
    // 44 px floor because the size follows the input, not the width.
    test.use({ hasTouch: true });

    test("1280 touch: header buttons and rows keep the 44 px floor", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await mockCoach(page);
      await openCoach(page);
      await expect(panel(page)).toHaveAttribute("data-state", "open");
      expect(await panelControlHeights(page)).toEqual({
        collapse: 44,
        plans: 44,
        gear: 44,
        row: 44,
      });
    });
  });

  test("1440: picking a row opens it and New chat clears it, both in the URL", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockCoach(page);
    await openCoach(page);

    const rows = panel(page).locator('[data-slot="coach-history-select"]');
    await expect(rows).toHaveCount(3);
    await expect(panel(page).locator('[data-group="today"]')).toContainText(
      "Blood pressure this week",
    );
    await expect(panel(page).locator('[data-group="yesterday"]')).toContainText(
      "Sleep since May",
    );
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

    await rows.nth(1).click();
    await expect(page).toHaveURL(/\/coach\?c=frame-sleep$/);
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");

    await fab(page).click();
    await expect(page).toHaveURL(/\/coach$/);
    await expect(
      page.locator('[data-slot="coach-input-textarea"]'),
    ).toBeVisible();
    await expect(panel(page).locator('[aria-current="true"]')).toHaveCount(0);
  });

  test("1440: rename by keyboard and delete with undo from the row menu", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const mock = await mockCoach(page);
    await openCoach(page);

    const row = panel(page)
      .locator('[data-slot="coach-history-item"]')
      .filter({ hasText: "Sleep since May" });
    const menu = row.locator('[data-slot="coach-history-row-menu"]');
    await expect(menu).toHaveAttribute(
      "aria-label",
      "Actions for Sleep since May",
    );

    // Keyboard: focus the menu button, open it, pick Rename.
    await menu.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const input = row.locator('[data-slot="coach-conversation-rename-input"]');
    await expect(input).toBeFocused();
    await input.fill("Discard this");
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(panel(page)).toHaveAttribute("data-state", "open");
    await expect(row).toContainText("Sleep since May");
    await expect(menu).toBeFocused();
    expect(mock.patches).toHaveLength(0);

    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await expect(input).toBeFocused();
    await input.fill("Sleep since spring");
    await page.keyboard.press("Enter");
    const renamed = panel(page)
      .locator('[data-slot="coach-history-item"]')
      .filter({ hasText: "Sleep since spring" });
    await expect(renamed).toHaveCount(1);
    await expect(input).toHaveCount(0);
    expect(mock.patches).toEqual([
      { id: "frame-sleep", title: "Sleep since spring" },
    ]);

    // Delete, then Undo: the row returns and no DELETE leaves.
    await renamed.hover();
    await renamed.locator('[data-slot="coach-history-row-menu"]').click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(renamed).toHaveCount(0);
    await shot(page, testInfo, "coach-frame-1440-delete-toast");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(renamed).toHaveCount(1);
    await page.waitForTimeout(6_500);
    expect(mock.deletes).toEqual([]);

    // Delete left alone commits once, after the undo window.
    await renamed.hover();
    await renamed.locator('[data-slot="coach-history-row-menu"]').click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(renamed).toHaveCount(0);
    await expect
      .poll(() => mock.deletes, { timeout: 10_000 })
      .toEqual(["frame-sleep"]);
  });

  test("1440: the gear opens the quick settings as a popover; Escape returns to the gear", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockCoach(page);
    await openCoach(page);

    const gear = panel(page).locator('[data-slot="coach-settings"]');
    await gear.click();
    const popover = page.locator('[data-slot="coach-settings-popover"]');
    await expect(popover).toBeVisible();
    await expect(popover).toHaveAttribute("role", "dialog");
    await expect(
      popover.locator('[data-slot="coach-quick-provider"]'),
    ).toHaveValue("local");
    await expect(
      popover.locator('[data-slot="coach-quick-model"]'),
    ).toHaveValue("qwen2.5");
    await expect(
      popover.locator('[data-slot="coach-sources-window"]'),
    ).toBeVisible();
    // The popover stays inside the viewport.
    const box = (await popover.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(1440);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    await shot(page, testInfo, "coach-frame-1440-settings");

    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(gear).toBeFocused();
    // Escape on the popover does not also close the panel.
    await expect(panel(page)).toHaveAttribute("data-state", "open");
  });

  test("1440: /coach?settings=data opens the settings on what the Coach sees", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockCoach(page);
    // A closed panel is revealed for the deep link.
    await page.addInitScript(() => {
      window.localStorage.setItem("healthlog.coach.panelOpen", "false");
    });
    // The hydration render does not know the viewport yet; the phone sheet
    // must not mount on a desktop even for a moment.
    await watchSheetMounts(page);
    await page.goto("/coach?settings=data", { waitUntil: "domcontentloaded" });

    const popover = page.locator('[data-slot="coach-settings-popover"]');
    await expect(popover).toBeVisible({ timeout: 15_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "open");
    expect(
      await sheetMounted(page),
      "the phone sheet flashed on a desktop deep link",
    ).toBe(false);
    await expect(
      popover.locator('[data-slot="coach-settings-data"]'),
    ).toBeFocused();
    await expect(page).toHaveURL(/\/coach$/);

    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`1440 ${theme}: axe finds nothing on the panel or the quick settings`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((value: string) => {
        window.localStorage.setItem("healthlog-theme", value);
      }, theme);
      await mockCoach(page);
      await openCoach(page);
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`(^|\\s)${theme}(\\s|$)`),
      );
      await expect(panel(page)).toHaveAttribute("data-state", "open");
      await shot(page, testInfo, `coach-frame-1440-${theme}`);

      const scan = async (selector: string, label: string) => {
        const result = await new AxeBuilder({ page })
          .include(selector)
          .withTags([
            "wcag2a",
            "wcag2aa",
            "wcag21a",
            "wcag21aa",
            "best-practice",
          ])
          .analyze();
        expect(
          result.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target.join(" ")),
          })),
          `${label} accessibility violations`,
        ).toEqual([]);
      };

      await scan('[data-slot="coach-conversations-panel"]', "panel");
      await shot(page, testInfo, `coach-frame-1440-${theme}-panel`);

      await panel(page).locator('[data-slot="coach-settings"]').click();
      const popover = page.locator('[data-slot="coach-settings-popover"]');
      await expect(
        popover.locator('[data-slot="coach-quick-provider"]'),
      ).toBeVisible();
      await scan('[data-slot="coach-settings-popover"]', "settings");
      await shot(page, testInfo, `coach-frame-1440-${theme}-settings`);
    });
  }

  test("390: /coach?settings=data opens the sheet and the settings on what the Coach sees", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockCoach(page);
    await watchSheetMounts(page);
    await page.goto("/coach?settings=data", { waitUntil: "domcontentloaded" });

    // The settings bottom sheet opens over the conversations sheet and
    // hides it from the accessibility tree, so the sheet is found by slot.
    await expect(page.locator('[data-slot="coach-settings-data"]')).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(
      page.locator('[role="dialog"][data-slot="coach-conversations-panel"]'),
    ).toBeVisible();
    // The positive control for the desktop case: the same watcher sees the
    // sheet mount where it belongs.
    expect(await sheetMounted(page)).toBe(true);
    await expect(page).toHaveURL(/\/coach$/);
  });

  test("390: the panel is a sheet, the gear a bottom sheet, and nothing scrolls sideways", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockCoach(page);
    await openCoach(page);

    // Below 1280 px the panel waits to be asked.
    await expect(panel(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    // New conversation sits above the composer, clear of its field.
    await expectNewChatFab(page);
    const fabBox = (await fab(page).boundingBox())!;
    const composerBox = (await page
      .locator('[data-slot="coach-page-composer"]')
      .boundingBox())!;
    expect(fabBox.y + fabBox.height).toBeLessThanOrEqual(composerBox.y);
    await expectNoSidewaysScroll(page);
    await shot(page, testInfo, "coach-frame-390-thread");

    await toggle(page).click();
    const sheet = page.getByRole("dialog", { name: "Conversations" });
    await expect(sheet).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(
      sheet.locator('[data-slot="coach-panel-new-chat"]'),
    ).toHaveCount(0);
    // The title keeps its whole word beside four header controls.
    const title = sheet.locator(
      '[data-slot="coach-conversations-panel-header"] h2',
    );
    expect(
      await title.evaluate((el) => el.scrollWidth <= el.clientWidth),
      "the sheet title is not truncated",
    ).toBe(true);
    await shot(page, testInfo, "coach-frame-390-panel");

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(toggle(page)).toBeFocused();

    // The gear in the sheet opens a bottom sheet over it.
    await toggle(page).click();
    await expect(sheet).toBeVisible();
    const gear = sheet.locator('[data-slot="coach-settings"]');
    await gear.click();
    const settings = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(settings).toHaveAttribute("data-variant", "sheet");
    await expect(
      settings.locator('[data-slot="coach-quick-provider"]'),
    ).toBeVisible();
    const box = (await settings.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
    await shot(page, testInfo, "coach-frame-390-settings");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(gear).toBeFocused();
    await expect(sheet).toBeVisible();

    // Picking a conversation closes the sheet and opens the thread.
    await sheet
      .locator('[data-slot="coach-history-select"]')
      .filter({ hasText: "Weight over the summer" })
      .click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\/coach\?c=frame-weight$/);
    await expectNoSidewaysScroll(page);
  });
});
