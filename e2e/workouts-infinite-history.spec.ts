import { expect, test } from "./setup/test";

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

  test("pages 8 at a time through one 'show more' row without duplicate ids", async ({
    page,
  }) => {
    const firstPage = Array.from({ length: 8 }, (_, index) =>
      workout(index + 1),
    );
    // The second page overlaps the first by one canonical row.
    const secondPage = [
      workout(8),
      ...Array.from({ length: 7 }, (_, index) => workout(index + 9)),
    ];
    const thirdPage = [workout(16), workout(17)];
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

      observedOffsets.push(offset);
      if (offset === 0) await firstPageGate;
      if (offset === 8) await secondPageGate;
      const workouts =
        offset === 0 ? firstPage : offset === 8 ? secondPage : thirdPage;

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workouts,
            meta: { total: 17, limit, offset, droppedDuplicates: 0 },
            ...(offset === 0
              ? {
                  sports: [{ sportType: "running", count: 17 }],
                  sources: ["APPLE_HEALTH"],
                }
              : {}),
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
    await expect(rows).toHaveCount(8);
    await expect(page.locator('[data-slot="workouts-loading"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="workout-list-count"]')).toHaveText(
      "17",
    );

    const more = page.locator('[data-slot="list-more"] button');
    await expect(more).toHaveText("Show 8 more");
    await more.click();
    await expect(more).toBeDisabled();
    releaseSecondPage();

    await expect(
      page.locator('a[href="/insights/workouts/workout-9"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('a[href="/insights/workouts/workout-8"]'),
    ).toHaveCount(1);
    await expect(rows).toHaveCount(15);

    await expect(more).toHaveText("Show 2 more");
    await more.click();
    await expect(
      page.locator('a[href="/insights/workouts/workout-17"]'),
    ).toHaveCount(1);
    await expect(rows).toHaveCount(17);
    await expect(page.locator('[data-slot="list-more"]')).toHaveCount(0);
    expect(observedOffsets).toEqual([0, 8, 16]);
  });
});
