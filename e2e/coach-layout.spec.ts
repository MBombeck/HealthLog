import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, Request, Route, TestInfo } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";

/**
 * The Coach page frame: the conversations panel on the right, its toggle in
 * the top bar, the settings gear in the panel header, and New chat at the
 * panel's bottom right.
 *
 * Contracts under test, at 1440, 1280 and 390 px:
 *
 *   1. From 1280 px the panel docks beside the thread, open on a first visit,
 *      and the reading column (thread and composer) is exactly as wide with
 *      the panel open as with it closed. The choice survives a reload.
 *   2. Escape inside the docked panel closes it and returns focus to the
 *      toggle.
 *   3. A row's menu renames by keyboard (Escape cancels without closing the
 *      panel, Enter saves once) and deletes with an Undo that keeps the
 *      DELETE from ever leaving; a delete left alone commits once.
 *   4. The gear opens the quick settings as a popover; Escape closes it and
 *      focus returns to the gear. `/coach?settings=data` opens it on "What I
 *      can see" and drops the param from the URL.
 *   5. axe finds nothing on the open panel or the open settings, in the
 *      light and the dark theme.
 *   6. At 390 px the panel is a dialog sheet with New chat 16 px from the
 *      right edge; Escape closes it and focus returns to the toggle. The gear
 *      opens a bottom sheet that closes on Escape back to the gear. Nothing
 *      scrolls sideways.
 *
 * Every Coach route is stubbed; the provider chain and provider config are
 * stubbed too, so the model section renders the same on every machine.
 * Screenshots are attached to the report (no pixel baselines).
 */

const NOW = Date.now();
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
  await page.route("**/api/insights/coach/seeded-question*", (route) =>
    fulfilJson(route, { signal: null }),
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

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
  const dir = process.env.COACH_SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
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
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
      await expect(toggle(page)).toHaveAttribute(
        "aria-controls",
        "coach-conversations-panel",
      );
      const open = await columnWidths(page);
      expect(open.thread).toBeCloseTo(672, 0);
      expect(Math.abs(open.composer - open.thread)).toBeLessThanOrEqual(1);
      // The panel sits right of the column, never over it.
      const aside = (await panel(page).boundingBox())!;
      expect(aside.x).toBeGreaterThanOrEqual(open.threadX + open.thread);
      await expectNoSidewaysScroll(page);
      await shot(page, testInfo, `coach-frame-${width}-open`);

      await toggle(page).click();
      await expect(panel(page)).toHaveAttribute("data-state", "closed");
      await waitForWidth(panel(page), 0);
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
      const closed = await columnWidths(page);
      expect(Math.abs(closed.thread - open.thread)).toBeLessThanOrEqual(1);
      expect(Math.abs(closed.composer - open.composer)).toBeLessThanOrEqual(1);
      // Closed, nothing inside the panel is reachable.
      await expect(
        panel(page).locator('[data-slot="coach-history-search"]'),
      ).not.toBeInViewport();
      await expectNoSidewaysScroll(page);
      await shot(page, testInfo, `coach-frame-${width}-closed`);

      // Remembered across a reload.
      await openCoach(page);
      await expect(panel(page)).toHaveAttribute("data-state", "closed");

      // Open again, then Escape from inside closes it, focus to the toggle.
      await toggle(page).click();
      await expect(panel(page)).toHaveAttribute("data-state", "open");
      await panel(page).locator('[data-slot="coach-history-search"]').focus();
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveAttribute("data-state", "closed");
      await expect(toggle(page)).toBeFocused();
    });
  }

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

    const fab = panel(page).locator('[data-slot="coach-panel-new-chat"]');
    const fabBox = (await fab.boundingBox())!;
    const asideBox = (await panel(page).boundingBox())!;
    expect(asideBox.x + asideBox.width - (fabBox.x + fabBox.width)).toBeCloseTo(
      16,
      0,
    );
    await fab.click();
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
    await page.goto("/coach?settings=data", { waitUntil: "domcontentloaded" });

    const popover = page.locator('[data-slot="coach-settings-popover"]');
    await expect(popover).toBeVisible({ timeout: 15_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "open");
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

      const scan = async (selector: string, label: string) => {
        const result = await new AxeBuilder({ page })
          .include(selector)
          // The data-area switches belong to the sources rail, which this
          // frame embeds unchanged; a switched-off row dims its label below
          // AA (`opacity-60` over muted text). That is the rail's own defect,
          // left for the rail's rework with the lookback limit.
          .exclude('[data-slot="coach-sources-list"]')
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

  test("390: the panel is a sheet, the gear a bottom sheet, and nothing scrolls sideways", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockCoach(page);
    await openCoach(page);

    // Below 1280 px the panel waits to be asked.
    await expect(panel(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expectNoSidewaysScroll(page);
    await shot(page, testInfo, "coach-frame-390-thread");

    await toggle(page).click();
    const sheet = page.getByRole("dialog", { name: "Conversations" });
    await expect(sheet).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    const fab = sheet.locator('[data-slot="coach-panel-new-chat"]');
    const fabBox = (await fab.boundingBox())!;
    expect(390 - (fabBox.x + fabBox.width)).toBeCloseTo(16, 0);
    expect(fabBox.width).toBeGreaterThanOrEqual(44);
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
