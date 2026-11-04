import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Settings → Export & Import + Gesundheitsakte UI smoke.
 *
 * Validates that:
 *   1. The Export & Import surfaces (`/settings/export`) render with their
 *      stable testids: the four CSV/JSON tiles and the import cards.
 *   2. The import surfaces (v1.15.7, issue #281) render: the Apple Health
 *      and generic-JSON cards.
 *   3. The full health-record export panel lives on its own top-level
 *      `/settings/gesundheitsakte` section (v1.18.0 S5) — including the
 *      "included data" disclosure, which a first run opens and which stays
 *      operable in both directions.
 *   4. The scope picker mounts twice on that page (the export panel and the
 *      share-link create form) and each mount is separately addressable.
 *   5. Clicking the Measurements CSV download button fires a real
 *      browser download — proving the `/api/export/measurements`
 *      endpoint is reachable from the browser end-to-end.
 *
 * The other CSV / JSON cards share the same code path; one happy-path
 * download is enough to lock in the wiring without doubling the e2e
 * runtime.
 */

/**
 * Open Settings → Gesundheitsakte and wait until the page is actually live.
 *
 * Everything on that page is server-rendered, so the rows are visible long
 * before the client boundary that owns them has hydrated — a click or a
 * `boundingBox()` taken on `domcontentloaded` alone hits inert or replaced
 * markup often enough to matter. `GesundheitsakteSection` is one client
 * boundary carrying both the export panel and the sharing card, and the
 * sharing card's query only runs once that boundary is live, so its request is
 * the signal that the whole surface is wired.
 */
async function openGesundheitsakte(page: Page): Promise<void> {
  const boundaryHydrated = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/share-links",
  );
  await page.goto("/settings/gesundheitsakte", {
    waitUntil: "domcontentloaded",
  });
  await boundaryHydrated;
}

test.describe("Settings → Export & Import", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("renders all export surfaces with stable testids", async ({ page }) => {
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    // v1.18.0 — the full health-record export moved to its own
    // `/settings/gesundheitsakte` section. The Export & Import page keeps
    // the four CSV/backup tiles with the `export-card-*` shape.
    for (const id of [
      "export-card-measurements-csv",
      "export-card-medications-csv",
      "export-card-mood-csv",
      "export-card-full-backup",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("renders the health-record export panel on its own section", async ({
    page,
  }) => {
    // v1.18.0 — the health-record export is the hero of the
    // dedicated, module-gated Gesundheitsakte section.
    await openGesundheitsakte(page);
    await expect(page.getByTestId("health-record-export-panel")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("gives each scope-picker mount its own test ids", async ({ page }) => {
    // The Gesundheitsakte page carries two mounts of the same picker: the
    // export panel at the top and the share-link create form under `#sharing`.
    // Every id inside the picker ends with the surface that mounts it, so an
    // assertion binds to one mount instead of resolving to both.
    await openGesundheitsakte(page);
    await expect(page.getByTestId("report-scope-picker-export")).toHaveCount(1);
    await expect(page.getByTestId("report-scope-picker-share")).toHaveCount(1);
    for (const id of [
      "report-group-row-vitals",
      "report-group-check-vitals",
      "report-sensitive-tier",
      "report-scope-summary",
    ]) {
      await expect(page.getByTestId(`${id}-export`)).toHaveCount(1);
      await expect(page.getByTestId(`${id}-share`)).toHaveCount(1);
    }
  });

  test("opens the scope picker expanded on a first run, fenced tier and all", async ({
    page,
  }) => {
    // The three panel states are the release's whole point, and on the first
    // one nothing is selected at all. The picker still opens without a click,
    // because with an empty scope the standard-report button and the named
    // groups are exactly what the person needs in front of them. Asserted
    // against the export mount; the share form runs its own picker.
    await openGesundheitsakte(page);
    await expect(page.getByTestId("report-scope-picker-export")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId("report-group-row-vitals-export"),
    ).toBeVisible();
    await expect(
      page.getByTestId("report-group-row-sensitive-export"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("report-sensitive-tier-export"),
    ).toBeVisible();
    // The fenced tier has no group control — there is no single click that
    // turns on more than one sensitive leaf.
    await expect(
      page.getByTestId("report-group-check-sensitive-export"),
    ).toHaveCount(0);
    await expect(page.getByTestId("report-scope-summary-export")).toBeVisible();
  });

  test("first run selects nothing and refuses to generate until it does", async ({
    page,
  }) => {
    // The rule the whole surface exists for: nothing reaches the report that
    // was not ticked. So a first run starts empty, Generate refuses the press
    // and says why, and the one-click action is what makes that cost nothing —
    // it fills the standard set and the control comes alive.
    await openGesundheitsakte(page);
    const generate = page.getByTestId("health-record-generate");
    await expect(generate).toBeVisible({ timeout: 10_000 });
    await expect(generate).toBeDisabled();
    await expect(
      page.getByTestId("report-group-row-vitals-export"),
    ).toContainText("0/7");
    await expect(page.getByTestId("report-scope-summary-export")).toContainText(
      "Nothing selected yet",
    );

    await page.getByTestId("report-apply-standard-export").click();

    await expect(generate).toBeEnabled();
    // Exactly the shipped set: the three classic vitals, weight and BMI, the
    // two heart-rate-variability rows, and nothing at all from the groups the
    // template leaves alone.
    await expect(
      page.getByTestId("report-group-row-vitals-export"),
    ).toContainText("3/7");
    await expect(
      page.getByTestId("report-group-row-body-export"),
    ).toContainText("2/12");
    await expect(
      page.getByTestId("report-group-row-cardio-export"),
    ).toContainText("2/16");
    await expect(
      page.getByTestId("report-group-row-mobility-export"),
    ).toContainText("0/11");
    // The fenced tier is not part of any one-click set.
    await expect(
      page.getByTestId("report-scope-summary-export"),
    ).not.toContainText("incl.");
  });

  test("a share link cannot be minted on an empty scope either", async ({
    page,
  }) => {
    await openGesundheitsakte(page);
    const create = page.getByTestId("share-create-submit");
    await expect(create).toBeVisible({ timeout: 10_000 });
    await page.locator("#share-label").fill("Cardiology");
    // A label alone is not a scope: the link would serve a page with nothing
    // on it, so the control stays shut until something is chosen.
    await expect(create).toBeDisabled();
    await expect(page.getByTestId("report-scope-summary-share")).toContainText(
      "Nothing selected yet",
    );
    await page.getByTestId("report-apply-standard-share").click();
    await expect(create).toBeEnabled();
  });

  test("clears the tap floor on the group rows at 390 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGesundheitsakte(page);
    const row = page.getByTestId("report-group-row-vitals-export");
    await expect(row).toBeVisible({ timeout: 10_000 });
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("opens a group's leaf grid from its chevron", async ({ page }) => {
    await openGesundheitsakte(page);
    const row = page.getByTestId("report-group-row-vitals-export");
    await expect(row).toBeVisible({ timeout: 10_000 });
    // Collapsed: the leaves are behind the disclosure, which is what makes a
    // repeat run two interactions.
    await expect(page.getByTestId("report-leaf-PULSE-export")).toHaveCount(0);
    await row.getByRole("button", { expanded: false }).click();
    await expect(page.getByTestId("report-leaf-PULSE-export")).toBeVisible();
  });

  test("renders the import surfaces with stable testids", async ({ page }) => {
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    // v1.15.7 (issue #281) — the Apple Health and generic-JSON import
    // cards live in the same section, below the export options.
    for (const id of ["import-card-apple-health", "import-card-json"]) {
      await expect(page.getByTestId(id)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("JSON import 'Download example' fires a real download", async ({
    page,
  }) => {
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    const exampleBtn = page.getByTestId("import-json-download-example");
    await expect(exampleBtn).toBeVisible({ timeout: 10_000 });

    const a11y = await new AxeBuilder({ page })
      .include('[data-testid="import-card-json"]')
      .analyze();
    expect(
      a11y.violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);

    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await exampleBtn.click();
    const download = await downloadPromise;

    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(path!);
    const parsed = JSON.parse(buf.toString("utf8"));
    expect(Array.isArray(parsed.measurements)).toBe(true);
    expect(Array.isArray(parsed.moodEntries)).toBe(true);
  });

  test("included-data disclosure opens on a first run and still collapses", async ({
    page,
  }) => {
    // The disclosure that fronts the scope picker on
    // `/settings/gesundheitsakte`. An account with no saved selection is a
    // first run, and a first run opens it: that is the only place the standard
    // template is applied, and a template hidden behind a closed disclosure
    // would be opt-out wearing a hat.
    //
    // Opening by default must not turn the disclosure into decoration, so the
    // operable part is asserted in both directions — it closes, taking the
    // panel with it, and it reopens.
    await page.route("**/api/share-links", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], error: null, meta: null }),
      });
    });
    await openGesundheitsakte(page);
    const toggle = page.getByTestId("health-record-included-data-toggle");
    const panel = page.getByTestId("health-record-included-data-panel");
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    // Open on first render, with the checklist panel behind it.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    // Collapses on demand, and the panel goes with it.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toHaveCount(0);
    // And back — the disclosure stays a disclosure.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
  });

  test("Measurements CSV download fires a real download event", async ({
    page,
    isMobile,
  }) => {
    // See the JSON-download test above: mobile emulation does not emit a
    // `download` event for the anchor click. Covered on chromium-desktop.
    test.skip(isMobile, "downloads aren't observable under mobile emulation");
    // Stub the API so we don't need 90 days of seeded data — the
    // browser-side wiring is what we're validating, not the route's
    // DB query.
    await page.route("**/api/export/measurements*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition":
            'attachment; filename="healthlog-measurements-test.csv"',
        },
        body: "type,value,unit,measuredAt,source,notes,glucoseContext\nWEIGHT,80,kg,2026-05-01T08:00:00.000Z,MANUAL,,\n",
      }),
    );

    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    const downloadBtn = page.getByTestId("export-action-measurements-csv");
    await expect(downloadBtn).toBeVisible({ timeout: 10_000 });

    const downloadPromise = page.waitForEvent("download", {
      timeout: 30_000,
    });
    await downloadBtn.click();
    const download = await downloadPromise;

    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(path!);
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.toString("utf8")).toContain("WEIGHT,80,kg");
  });
});
