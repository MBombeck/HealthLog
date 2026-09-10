/**
 * The doctor report, generated in a browser and read back as a real PDF.
 *
 * The surface had unit coverage for the renderer and route coverage for the
 * envelope, and nothing that pressed the button. What that leaves untested is
 * the part a self-hoster actually meets: a person with a few weeks of readings
 * opens Settings → Gesundheitsakte, picks a window, presses Generate, and gets
 * a document a practice can file. Every link in that chain — the panel's own
 * `fetch`, the selection it sends, the aggregator's window, the renderer, the
 * download — is proved here once, end to end.
 *
 * What the assertions are about:
 *
 *   1. The response IS a PDF: `application/pdf`, a `%PDF` magic, a byte length
 *      no empty document could reach, and a `Content-Length` that agrees with
 *      the bytes.
 *   2. The document says what it contains. The bytes are parsed back to text,
 *      so the period line, the blood-pressure section and the medication the
 *      account carries are read out of the artefact rather than inferred from a
 *      200.
 *   3. The window travelled. The period line names two dates, and their span is
 *      the window the select offered — not the server's default.
 *
 * And the refusing control, in the same file because it is the same button: a
 * window with nothing in it still produces a valid, readable PDF that names the
 * period and simply carries no blood-pressure section. An empty report is a
 * true statement about an empty window; a truncated or unopenable file is not.
 *
 * The fixture is seeded through the PAGE's own `fetch` under the session the
 * spec is already authenticated as — not through a second Playwright request
 * context — so the rows are written by exactly the credential that later reads
 * them back. Seeding is idempotent: a re-post of the same reading collides on
 * the measurement's natural key and answers 409, which is why `--repeat-each`
 * and a second local run both stay green.
 *
 * The delegate half of the story — a READ-level delegate cannot generate the
 * owner's report — lives in `doctor-report-delegate.spec.ts`, which needs its
 * own session row because it moves the record selector.
 */
import { readFile } from "node:fs/promises";

import type { Page, Response } from "@playwright/test";
import { PDFParse } from "pdf-parse";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";

/** The allergy and the drug the report has to name. Both plain ASCII: the
 *  PDF's built-in Helvetica is WinAnsi-encoded and the assertions read the
 *  extracted text back, so a fixture that needs transliteration would be
 *  testing the sanitiser rather than the report. */
const ALLERGY_SUBSTANCE = "Amoxicillin";
const MEDICATION_NAME = "Ramipril";
const MEDICATION_DOSE = "5 mg";

/** Day offsets for the seeded readings — a few weeks of history, inside the
 *  30-day window the spec selects and well inside the 90-day default, so a
 *  window that failed to travel would still find them. */
const READING_DAY_OFFSETS = [2, 5, 9, 13, 17, 21] as const;

/** The window the spec chooses in the panel. Deliberately NOT the 90-day
 *  fallback the panel opens with, so the period line proves a choice. */
const RANGE_DAYS = 30;

/** The section heading the PDF prints only when both blood-pressure series
 *  have readings in the window. Quoted without its em dash: the expectation is
 *  about the section being there, not about how a parser renders punctuation. */
const BP_SECTION = "ESH classification";

/** Byte floor for "a real document". A cover page with charts is far above
 *  this; a truncated stream or an error body is far below it. */
const MIN_PDF_BYTES = 10_000;

interface SeedOutcome {
  measurements: number[];
  allergy: number;
  medication: number;
  emergency: number;
}

/**
 * Write the record this report is about, through the page's own `fetch`.
 *
 * Each per-day POST carries the day's systolic, diastolic and weight as one
 * array body — the route's batch arm — so a repeat run collides as a whole day
 * and answers 409 rather than half-inserting. The allergy and the medication
 * are read before they are written, because neither has a natural key that
 * would make a second create a no-op.
 *
 * The emergency profile matters more than it looks: the drug list reaches the
 * PDF through the emergency sheet, and that sheet only renders once the profile
 * holds something. One blood type is the smallest honest way to say so.
 */
async function seedReportFixture(page: Page): Promise<SeedOutcome> {
  return page.evaluate(
    async (fixture) => {
      const send = async (
        method: string,
        path: string,
        body: unknown,
      ): Promise<number> => {
        const res = await fetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return res.status;
      };

      const readList = async (path: string): Promise<unknown[]> => {
        const res = await fetch(path);
        if (!res.ok) return [];
        const payload = (await res.json()) as { data: unknown };
        return Array.isArray(payload.data) ? payload.data : [];
      };

      /** 09:00 UTC on the day `offset` days back — a fixed instant, so a
       *  second run inside the same day reproduces the same natural key. */
      const instantFor = (offset: number): string => {
        const day = new Date();
        day.setUTCDate(day.getUTCDate() - offset);
        return `${day.toISOString().slice(0, 10)}T09:00:00.000Z`;
      };

      const measurements: number[] = [];
      for (const [index, offset] of fixture.dayOffsets.entries()) {
        const measuredAt = instantFor(offset);
        measurements.push(
          await send("POST", "/api/measurements", [
            {
              type: "BLOOD_PRESSURE_SYS",
              value: 118 + index,
              measuredAt,
            },
            {
              type: "BLOOD_PRESSURE_DIA",
              value: 74 + index,
              measuredAt,
            },
            {
              type: "WEIGHT",
              value: 82.4 - index * 0.2,
              measuredAt,
            },
          ]),
        );
      }

      const allergies = (await readList("/api/allergies")) as Array<{
        substance?: string;
      }>;
      const allergy = allergies.some(
        (row) => row.substance === fixture.allergySubstance,
      )
        ? 200
        : await send("POST", "/api/allergies", {
            substance: fixture.allergySubstance,
            category: "MEDICATION",
            type: "ALLERGY",
            severity: "MODERATE",
          });

      const drugs = (await readList("/api/medications")) as Array<{
        name?: string;
      }>;
      const medication = drugs.some(
        (row) => row.name === fixture.medicationName,
      )
        ? 200
        : await send("POST", "/api/medications", {
            name: fixture.medicationName,
            dose: fixture.medicationDose,
            // No schedule: an as-needed drug is active indefinitely and needs
            // no dose ledger, which keeps the fixture about the drug LIST.
            asNeeded: true,
          });

      const emergency = await send("PATCH", "/api/anamnesis/emergency", {
        bloodType: "O_POS",
      });

      return { measurements, allergy, medication, emergency };
    },
    {
      dayOffsets: [...READING_DAY_OFFSETS],
      allergySubstance: ALLERGY_SUBSTANCE,
      medicationName: MEDICATION_NAME,
      medicationDose: MEDICATION_DOSE,
    },
  );
}

/**
 * Open the panel and wait until the client boundary that owns it is live.
 *
 * `GesundheitsakteSection` carries the export panel and the sharing card in one
 * boundary, and the sharing card's query only runs once that boundary has
 * hydrated — so its request is the signal that the Generate button is wired
 * rather than merely painted. Same gate `settings-export.spec.ts` uses, for the
 * same reason.
 */
async function openReportPanel(page: Page): Promise<void> {
  const boundaryHydrated = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/share-links",
  );
  await page.goto("/settings/gesundheitsakte", {
    waitUntil: "domcontentloaded",
  });
  await boundaryHydrated;
  await expect(page.getByTestId("health-record-export-panel")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Put the panel into a known state: PDF format, the standard scope.
 *
 * The account carries a saved selection the moment it has generated once, so
 * the panel a second run opens is the "repeat run" state with the picker
 * collapsed. Both states are handled by opening the disclosure when it is shut
 * and then applying the named template, which is also the only thing in the
 * product that fills a selection — so the scope this report is generated under
 * is a scope somebody pressed a button for, exactly as the panel intends.
 */
async function chooseStandardPdfScope(page: Page): Promise<void> {
  const panel = page.getByTestId("health-record-export-panel");

  const formats = panel.locator('[role="radiogroup"] [role="radio"]');
  // PDF is the first of the three formats the panel offers.
  await formats.first().click();
  await expect(formats.first()).toHaveAttribute("aria-checked", "true");

  const picker = page.getByTestId("health-record-included-data-panel");
  if ((await picker.count()) === 0) {
    await page.getByTestId("health-record-included-data-toggle").click();
  }
  await expect(picker).toBeVisible();

  await page.getByTestId("report-apply-standard-export").click();
  await expect(page.getByTestId("health-record-generate")).toBeEnabled();
}

interface GeneratedReport {
  status: number;
  contentType: string;
  contentLength: string | undefined;
  bytes: Buffer;
  text: string;
  filename: string;
}

/**
 * Press Generate and take the artefact apart.
 *
 * Both ends of the press are observed: the response carries the bytes the
 * assertions are about, and the download event is the state the person sees.
 * Waiting on the response ALONE would pass on a build that produced a perfect
 * PDF and never handed it to the browser.
 */
async function generateReport(page: Page): Promise<GeneratedReport> {
  const responseArrived = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/export/health-record",
    { timeout: 60_000 },
  );
  const downloadStarted = page.waitForEvent("download", { timeout: 60_000 });

  const generate = page.getByTestId("health-record-generate");
  await generate.click();

  const response = await responseArrived;
  const download = await downloadStarted;

  // The bytes come off the DOWNLOAD, not off the response. The panel reads the
  // response into a Blob, and a body a page has already consumed is not one
  // Playwright can hand back — `response.body()` answers zero bytes here. The
  // saved file is also the better subject: it is the artefact the person ends
  // up with, so a build that produced a perfect response and saved something
  // else would still be caught.
  const saved = await download.path();
  expect(saved, "the panel saved the generated report").toBeTruthy();
  const bytes = await readFile(saved!);

  // The control comes back, and nothing on the panel is complaining. The error
  // paragraph is the panel's only failure surface, so its absence is the
  // statement that the press succeeded rather than failed quietly.
  await expect(generate).toBeEnabled({ timeout: 30_000 });
  await expect(
    page.getByTestId("health-record-export-panel").getByRole("alert"),
  ).toHaveCount(0);

  // Asserted BEFORE the parse: a parser fed an error envelope reports "not a
  // PDF", which is a true statement about the bytes and a useless one about
  // what went wrong. The status and the content type say that.
  expect(response.status(), await failureDetail(response)).toBe(200);
  expect(response.headers()["content-type"] ?? "").toContain("application/pdf");
  expect(bytes.byteLength).toBeGreaterThan(MIN_PDF_BYTES);

  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  let text: string;
  try {
    text = (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }

  return {
    status: response.status(),
    contentType: response.headers()["content-type"] ?? "",
    contentLength: response.headers()["content-length"],
    bytes,
    text,
    filename: download.suggestedFilename(),
  };
}

/** What the route said, when it did not say "PDF". */
async function failureDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "<no readable body>";
  }
}

/** Every assertion that is about "this is a PDF", said once. */
function expectRealPdf(report: GeneratedReport): void {
  expect(report.status).toBe(200);
  expect(report.contentType).toContain("application/pdf");
  expect(report.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(report.bytes.byteLength).toBeGreaterThan(MIN_PDF_BYTES);
  // The route declares the length it sent; a disagreement means the body was
  // truncated on the way out, which a magic-number check alone would miss.
  expect(report.contentLength).toBe(String(report.bytes.byteLength));
  expect(report.filename).toMatch(/\.pdf$/);
}

/**
 * The two dates the period line names, as UTC midnights.
 *
 * The line is rendered in the account's locale (English → MM/DD/YYYY) and its
 * timezone, so the dates are read structurally and compared as a SPAN. A span
 * is timezone-proof in a way an absolute date is not: both ends move together.
 */
function periodSpanDays(text: string): number {
  const match =
    /Reporting period:\s*(\d{2})\/(\d{2})\/(\d{4})\s*\D{1,3}\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(
      text,
    );
  expect(match, "the report prints a reporting period with two dates").not.toBe(
    null,
  );
  const [, sm, sd, sy, em, ed, ey] = match!;
  const start = Date.UTC(Number(sy), Number(sm) - 1, Number(sd));
  const end = Date.UTC(Number(ey), Number(em) - 1, Number(ed));
  return Math.round((end - start) / 86_400_000);
}

test.describe.serial("the doctor report", () => {
  // The seeded account owns the readings, the allergy and the drug, and the
  // page's own `fetch` writes them under its session.
  test.use({ storageState: STORAGE_STATE_PATH });

  test("generates a PDF that names the period, the vitals and the medication", async ({
    page,
  }) => {
    // A production build rendering a charted PDF over a seeded window is well
    // past the 30 s default, and a timeout here would report a failure that
    // says nothing about the report.
    test.setTimeout(120_000);

    await openReportPanel(page);
    const seeded = await seedReportFixture(page);
    // 201 on a first run, 409 on a repeat — both mean the readings are there.
    for (const status of seeded.measurements) {
      expect([201, 409]).toContain(status);
    }
    expect([200, 201]).toContain(seeded.allergy);
    expect([200, 201]).toContain(seeded.medication);
    expect(seeded.emergency).toBe(200);

    // Reload so the panel is looking at the record that now exists.
    await openReportPanel(page);
    await chooseStandardPdfScope(page);

    // The period: a window the panel offers, and not the one it defaults to.
    await page.locator("#hr-range").selectOption({ value: String(RANGE_DAYS) });
    await expect(page.locator("#hr-range")).toHaveValue(String(RANGE_DAYS));

    const report = await generateReport(page);
    expectRealPdf(report);

    // The document says what it is about.
    expect(report.text).toContain("Reporting period");
    const span = periodSpanDays(report.text);
    expect(span).toBeGreaterThanOrEqual(RANGE_DAYS - 1);
    expect(span).toBeLessThanOrEqual(RANGE_DAYS + 1);

    // The blood-pressure section only prints when both series carried readings
    // in the window, so its presence is the seeded history arriving.
    expect(report.text).toContain(BP_SECTION);
    // And the record the clinician reads first: the drug and the allergy.
    expect(report.text).toContain(MEDICATION_NAME);
    expect(report.text).toContain(ALLERGY_SUBSTANCE);
  });

  test("a window with no readings is an empty report, not a broken one", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await openReportPanel(page);
    await chooseStandardPdfScope(page);

    // A custom window a year back: inside the route's span bounds, and holding
    // none of this account's readings.
    await page.locator("#hr-range").selectOption({ value: "custom" });
    const panel = page.getByTestId("health-record-export-panel");
    const dateFields = panel.locator(
      '[data-slot="date-field"] input[type="text"]',
    );
    await expect(dateFields).toHaveCount(2);

    const dayBack = (offset: number): string => {
      const day = new Date();
      day.setUTCDate(day.getUTCDate() - offset);
      return day.toISOString().slice(0, 10);
    };
    // The field commits a clean ISO string whatever the locale's field order is.
    await dateFields.first().fill(dayBack(400));
    await dateFields.first().press("Enter");
    await dateFields.nth(1).fill(dayBack(380));
    await dateFields.nth(1).press("Enter");

    const report = await generateReport(page);
    // Still a document: the empty window is answered with a report, not with a
    // truncated file and not with an error the panel swallows.
    expectRealPdf(report);
    expect(report.text).toContain("Reporting period");

    // Nothing was measured in it, so the section that needs readings is gone.
    expect(report.text).not.toContain(BP_SECTION);

    // The positive control for that absence: the reference data that is NOT
    // window-scoped is still in the document. Without this, a renderer that
    // produced a blank page would pass the line above.
    expect(report.text).toContain(MEDICATION_NAME);
    expect(report.text).toContain(ALLERGY_SUBSTANCE);
  });
});
