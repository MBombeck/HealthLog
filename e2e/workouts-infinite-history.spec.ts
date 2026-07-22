import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

interface MockWorkout {
  id: string;
  sportType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  distanceM: null;
  activeEnergyKcal: null;
  avgHr: null;
  maxHr: null;
  source: string;
  externalId: string;
}

function workout(id: number): MockWorkout {
  return {
    id: `workout-${id}`,
    sportType: "running",
    startedAt: "2026-07-20T08:00:00.000Z",
    endedAt: "2026-07-20T08:30:00.000Z",
    durationSec: 1800,
    distanceM: null,
    activeEnergyKcal: null,
    avgHr: null,
    maxHr: null,
    source: "APPLE_HEALTH",
    externalId: `external-${id}`,
  };
}

test.describe("workout history pagination", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("loads canonical rows beyond 100 once without duplicate ids", async ({
    page,
  }) => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      workout(index + 1),
    );
    const secondPage = [
      workout(100),
      ...Array.from({ length: 99 }, (_, index) => workout(index + 101)),
    ];
    const thirdPage = [workout(200), workout(201)];
    const observedOffsets: number[] = [];
    let releaseFirstPage!: () => void;
    const firstPageGate = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    let releaseSecondPage!: () => void;
    const secondPageGate = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });

    await page.route(/\/api\/workouts(?:\?|$)/, async (route) => {
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const offset = Number(url.searchParams.get("offset") ?? "0");

      if (limit !== 100) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              workouts: firstPage.slice(0, limit),
              meta: {
                total: 201,
                limit,
                offset,
                droppedDuplicates: 0,
              },
            },
            error: null,
          }),
        });
        return;
      }

      observedOffsets.push(offset);
      if (offset === 0) await firstPageGate;
      if (offset === 100) await secondPageGate;
      const workouts =
        offset === 0 ? firstPage : offset === 100 ? secondPage : thirdPage;

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workouts,
            meta: {
              total: 201,
              limit,
              offset,
              droppedDuplicates: 0,
            },
          },
          error: null,
        }),
      });
    });

    await page.goto("/insights/workouts");
    await expect(page.locator('[data-slot="workouts-loading"]')).toBeVisible();
    await expect(page.locator('[data-slot="workout-list-row"]')).toHaveCount(0);
    releaseFirstPage();

    const rows = page.locator('[data-slot="workout-list-row"]');
    await expect(rows).toHaveCount(100);
    await expect(page.locator('[data-slot="workouts-loading"]')).toHaveCount(0);

    const loadMore = page.getByRole("button", { name: "Load more workouts" });
    await loadMore.click();
    await expect(
      page.getByRole("button", { name: "Loading more workouts" }),
    ).toBeDisabled();
    releaseSecondPage();

    await expect(
      page.locator('a[href="/insights/workouts/workout-101"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('a[href="/insights/workouts/workout-100"]'),
    ).toHaveCount(1);
    await expect(rows).toHaveCount(199);

    await page.getByRole("button", { name: "Load more workouts" }).click();
    await expect(
      page.locator('a[href="/insights/workouts/workout-201"]'),
    ).toHaveCount(1);
    await expect(rows).toHaveCount(201);
    await expect(
      page.getByRole("button", { name: "Load more workouts" }),
    ).toHaveCount(0);
    expect(observedOffsets).toEqual([0, 100, 200]);
  });
});
