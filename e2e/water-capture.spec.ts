import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  mockDashboardSnapshot,
  WEIGHT_ONLY_SUMMARIES,
} from "./utils/mock-dashboard-snapshot";

test.describe("water capture", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("opens globally, waits for success, and retains failed input", async ({
    page,
  }, testInfo) => {
    await mockDashboardSnapshot(page, { summaries: WEIGHT_ONLY_SUMMARIES });
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
          error: null,
        }),
      }),
    );
    await page.route("**/api/mood/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { entries: [], summary: { count: 0 } },
          error: null,
        }),
      }),
    );

    let writeCount = 0;
    let confirmSuccess: (() => void) | undefined;
    const successConfirmed = new Promise<void>((resolve) => {
      confirmSuccess = resolve;
    });
    await page.route("**/api/nutrients/water", async (route) => {
      writeCount += 1;
      if (writeCount === 1) {
        await successConfirmed;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { amountMl: 250 }, error: null }),
        });
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ data: null, error: "write failed" }),
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    const openWater = async (toastMayOverlap = false) => {
      if (testInfo.project.name === "chromium-mobile") {
        const capture = page.getByTestId("bottom-nav-capture");
        if (toastMayOverlap) {
          await capture.dispatchEvent("click");
        } else {
          await capture.click();
        }
        const option = page.getByTestId("capture-picker-water");
        await expect(option).toBeVisible();
        const box = await option.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        if (toastMayOverlap) {
          await option.dispatchEvent("click");
        } else {
          await option.click();
        }
      } else {
        await page.locator('[data-tour-id="dashboard-quick-add"]').click();
        await page.getByRole("menuitem", { name: "Log water" }).click();
      }
      await expect(
        page.getByRole("heading", { name: "Add water" }),
      ).toBeVisible();
      if (testInfo.project.name === "chromium-mobile") {
        const actions = page
          .getByRole("dialog")
          .locator(
            '[data-slot="water-quick-add-chips"] button, form button[type="submit"]',
          );
        await expect(actions).toHaveCount(4);
        for (const action of await actions.all()) {
          await expect(action).toHaveAccessibleName(/.+/);
          const actionBox = await action.boundingBox();
          expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
      }
    };

    await openWater();
    const amount = page.getByRole("spinbutton", {
      name: "Custom amount (mL)",
    });
    await amount.fill("250");
    const submit = page
      .getByRole("dialog")
      .getByRole("button", { name: "Add", exact: true });
    await amount.press("Enter");

    await expect(submit).toBeDisabled();
    await expect(amount).toHaveValue("250");
    await expect(page.getByText("250 mL water added.")).toHaveCount(0);

    confirmSuccess?.();
    await expect(page.getByText("250 mL water added.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add water" })).toHaveCount(
      0,
    );
    expect(writeCount).toBe(1);

    await openWater(true);
    const failedAmount = page.getByRole("spinbutton", {
      name: "Custom amount (mL)",
    });
    await expect(failedAmount).toHaveValue("");
    await failedAmount.fill("375");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add", exact: true })
      .click();

    await expect(
      page.getByText("Couldn't save that — try again."),
    ).toBeVisible();
    await expect(failedAmount).toHaveValue("375");
    await expect(
      page.getByRole("heading", { name: "Add water" }),
    ).toBeVisible();
    await expect(page.getByText("375 mL water added.")).toHaveCount(0);
    expect(writeCount).toBe(2);
  });
});
