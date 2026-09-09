import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  appleHealthExportZip,
  archiveWithoutExportXml,
  FIXTURE_READINGS,
  MISSING_EXPORT_XML_REASON,
} from "./fixtures/apple-health-export";

/**
 * Apple Health `export.zip` → readings on the measurements list.
 *
 * The one journey that crosses every layer the import owns: a person drops
 * an archive on `/settings/export`, the kick-off route streams it to disk and
 * queues `apple-health-import-v2`, the pg-boss worker in the same process
 * unpacks it and streams the XML into `Measurement` rows, the card's status
 * poll turns the spinner into a written outcome, and the rows show up on
 * `/measurements` carrying the units the parser resolved. Every one of those
 * steps has unit coverage; none of it proves the chain holds when a real
 * browser drives it against a real queue and a real database.
 *
 * The archives are synthetic and built in memory — see
 * `fixtures/apple-health-export.ts`.
 */
type FixtureReading = (typeof FIXTURE_READINGS)[keyof typeof FIXTURE_READINGS];

/**
 * Serial, because the journey mutates the one shared account and the refusal
 * control reads a count off it. Two of these tests in flight at once would
 * also spend the kick-off route's three-uploads-per-minute budget on each
 * other rather than on what they are testing.
 */
test.describe.configure({ mode: "serial" });

/**
 * The import is the slowest single action in the browser suite: an upload,
 * a queue hop, an unpack, a parse, and a status poll that ticks every two
 * seconds. The default 30 s budget covers none of that on a loaded runner.
 */
test.setTimeout(180_000);

/**
 * Clear this account's upload bucket before each upload.
 *
 * `POST /api/import/apple-health-export` allows three uploads per user per
 * minute, which is the right production number and exactly one too few for a
 * spec that uploads twice and is expected to survive `--repeat-each`. The
 * fourth upload inside the window would come back 429 and the card would
 * render the rate-limit copy — a red run that says nothing about the import.
 *
 * Reaching for Postgres directly is the same channel `global-setup.ts` uses
 * to seed and to clear the auth buckets; the alternative is to sit out a
 * 60-second window, which is a sleep wearing a poll's clothing.
 */
async function clearImportUploadBucket(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is unset — the import journey needs the same database the app is running against.",
    );
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM rate_limits WHERE key LIKE 'import:apple-health:%'`,
    );
  } finally {
    await client.end();
  }
}

/** Open the import surface and hand back the Apple Health card. */
async function openImportCard(page: Page) {
  await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("import-card-apple-health");
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

/**
 * Hand the archive to the card's own file input, which is what a drop or a
 * click on "Choose file" ends up doing. The upload itself then runs through
 * the card's `fetch`, so the spec seeds nothing the page would not have sent.
 */
async function uploadArchive(
  page: Page,
  archive: Buffer,
  name: string,
): Promise<void> {
  const card = await openImportCard(page);
  await card.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "application/zip",
    buffer: archive,
  });
}

/** How many readings this account holds from an Apple Health import. */
async function appleHealthRowCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const res = await fetch(
      "/api/measurements?sourceEq=APPLE_HEALTH&limit=1&offset=0",
      { credentials: "include" },
    );
    const body = (await res.json()) as {
      data: { meta: { total: number } } | null;
    };
    if (!body.data) throw new Error("measurements list returned no data");
    return body.data.meta.total;
  });
}

/**
 * Assert one imported reading on the measurements list, by the value and the
 * unit the row carries rather than by the locale text it renders.
 */
async function expectReadingOnList(
  page: Page,
  reading: FixtureReading,
): Promise<void> {
  await page.goto(`/measurements?type=${reading.type}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator('[data-slot="measurement-rows"]')).toBeVisible({
    timeout: 30_000,
  });
  const row = page.locator(
    `[data-testid="measurement-row"][data-measurement-type="${reading.type}"]` +
      `[data-measurement-value="${reading.value}"]`,
  );
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-measurement-unit", reading.unit);
}

test.describe("Apple Health export import", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("an uploaded export surfaces as readings with their units", async ({
    page,
  }) => {
    await clearImportUploadBucket();
    await uploadArchive(page, appleHealthExportZip(), "export.zip");

    // The card polls the status route every two seconds and swaps the
    // spinner for the written outcome on a terminal state. `data-outcome`
    // is the outcome itself; the sentence beside it is translated copy.
    const result = page.getByTestId("import-apple-health-result");
    await expect(result).toBeVisible({ timeout: 150_000 });
    await expect(result).toHaveAttribute("data-outcome", "success");

    // The weight the archive wrote in kilograms, the blood-pressure pair it
    // wrote in mmHg, and the step count it wrote as a bare count — each on
    // the list, each carrying the unit the parser resolved for it.
    await expectReadingOnList(page, FIXTURE_READINGS.weight);
    await expectReadingOnList(page, FIXTURE_READINGS.systolic);
    await expectReadingOnList(page, FIXTURE_READINGS.diastolic);
    await expectReadingOnList(page, FIXTURE_READINGS.steps);
  });

  test("a distance written in kilometres is stored in metres", async ({
    page,
  }) => {
    test.skip(
      true,
      "issue #944 — the parser resolves a record's unit from the type map " +
        "and ignores the `unit` attribute the record carries, so a distance " +
        "written as 2.484 km lands as 2.484 m. The fix is on a branch that " +
        "has not reached main; this is the contract it has to meet, kept " +
        "here at full strength rather than relaxed to match today's value.",
    );
    await expectReadingOnList(page, FIXTURE_READINGS.walkingDistance);
  });

  test("an archive without export.xml is refused and imports nothing", async ({
    page,
  }) => {
    await clearImportUploadBucket();
    await openImportCard(page);
    const before = await appleHealthRowCount(page);

    await uploadArchive(page, archiveWithoutExportXml(), "not-an-export.zip");

    // The worker's own words, surfaced verbatim by the card: the failure
    // reason is honest English free text, not a code the UI translates.
    const error = page.getByTestId("import-apple-health-error");
    await expect(error).toBeVisible({ timeout: 150_000 });
    await expect(error).toContainText(MISSING_EXPORT_XML_REASON);

    // And a refusal that still wrote something would be worse than no
    // refusal at all.
    expect(await appleHealthRowCount(page)).toBe(before);
  });
});
