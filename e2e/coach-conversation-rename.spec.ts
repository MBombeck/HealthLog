import { expect, test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

const CONVERSATION_ID = "conversation-rename-e2e";
const INITIAL_TITLE = "Morning check-in";
const RENAMED_TITLE = "Weekly health review";

test.describe("Coach conversation rename", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("renames by keyboard once and survives reload on desktop and mobile", async ({
    page,
  }) => {
    let persistedTitle = INITIAL_TITLE;
    let patchCount = 0;

    await page.route(
      /\/api\/insights\/chat(?:\/[^?]+)?(?:\?|$)/,
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          request.method() === "PATCH" &&
          url.pathname === `/api/insights/chat/${CONVERSATION_ID}`
        ) {
          patchCount += 1;
          const payload = JSON.parse(request.postData() ?? "{}") as {
            title: string;
          };
          persistedTitle = payload.title;
          await delay(150);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              data: { id: CONVERSATION_ID, title: persistedTitle },
              error: null,
            }),
          });
          return;
        }

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              conversations: [
                {
                  id: CONVERSATION_ID,
                  title: persistedTitle,
                  createdAt: "2026-07-20T10:00:00.000Z",
                  updatedAt: "2026-07-20T10:00:00.000Z",
                  messageCount: 2,
                  fenced: false,
                  attachments: [],
                  documentTitle: null,
                },
              ],
              nextCursor: null,
            },
            error: null,
          }),
        });
      },
    );

    await page.goto("/coach/conversations", {
      waitUntil: "domcontentloaded",
    });

    const item = page.locator('[data-slot="coach-conversations-item"]');
    await expect(item).toContainText(INITIAL_TITLE, { timeout: 10_000 });

    const renameButton = item.locator(
      '[data-slot="coach-conversation-rename"]',
    );
    await renameButton.click();
    const input = item.locator('[data-slot="coach-conversation-rename-input"]');
    await expect(input).toBeFocused();

    await input.fill("Discard this draft");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(item).toContainText(INITIAL_TITLE);
    expect(patchCount).toBe(0);

    await renameButton.click();
    const activeInput = item.locator(
      '[data-slot="coach-conversation-rename-input"]',
    );
    await activeInput.fill(`  ${RENAMED_TITLE}  `);
    await activeInput.evaluate((element) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    await expect(activeInput).toBeDisabled();
    await expect(item).toContainText(RENAMED_TITLE);
    await expect(activeInput).toHaveCount(0, { timeout: 10_000 });
    expect(patchCount).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-slot="coach-conversations-item"]'),
    ).toContainText(RENAMED_TITLE, { timeout: 10_000 });
    expect(patchCount).toBe(1);
  });
});
