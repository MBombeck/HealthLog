import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { buildWatchActivity, zipOne } from "../tests/fixtures/fit/build-fit";

/**
 * Several activity files in one selection, against the real server and its
 * worker: each file is uploaded only after the one before it finished, and
 * the card gives every file its own row. A new activity is imported, the same
 * activity zipped is recognised by its workout, the same bytes again by the
 * upload, and a file that is no FIT file fails with a short reason.
 *
 * The files are synthetic (`tests/fixtures/fit/build-fit.ts`), with a start
 * time of their own per run, so a retry imports a fresh activity.
 */
test.describe.configure({ mode: "serial" });

/** Four files, each a queue hop and a two-second status poll. */
test.setTimeout(180_000);

/**
 * The upload route allows five uploads a minute per account and kind; a
 * retry inside the window would otherwise wait it out. Same channel as the
 * Apple Health journey.
 */
async function clearFitUploadBucket(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is unset; the import journey needs the database the app runs against.",
    );
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DELETE FROM rate_limits WHERE key LIKE 'import:fit:%'`);
  } finally {
    await client.end();
  }
}

async function openFitCard(page: Page) {
  await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("import-card-fit");
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.describe("activity file import, several files", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await clearFitUploadBucket();
  });

  test("imports files one after the other and skips what is already there", async ({
    page,
  }) => {
    // A start time no earlier run used: yesterday, to the second.
    const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 86_400_000);
    const activity = buildWatchActivity({ start, seconds: 600 });
    const card = await openFitCard(page);
    await card.locator('input[type="file"]').setInputFiles([
      {
        name: "run.fit",
        mimeType: "application/octet-stream",
        buffer: activity,
      },
      {
        name: "run.zip",
        mimeType: "application/zip",
        buffer: zipOne("1_ACTIVITY.fit", activity),
      },
      {
        name: "run-copy.fit",
        mimeType: "application/octet-stream",
        buffer: activity,
      },
      {
        name: "notes.fit",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("not a fit file at all"),
      },
    ]);

    const rows = card.getByTestId("import-fit-file");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(3)).toHaveAttribute("data-status", "failed", {
      timeout: 150_000,
    });
    await expect(rows.nth(0)).toHaveAttribute("data-status", "imported");
    await expect(rows.nth(1)).toHaveAttribute("data-status", "duplicate");
    await expect(rows.nth(2)).toHaveAttribute("data-status", "duplicate");
    await expect(card.getByTestId("import-fit-batch-progress")).toContainText(
      "4",
    );
    // Once the run is over the card takes the next selection.
    await expect(card.getByTestId("import-action-fit")).toBeEnabled();
  });
});
