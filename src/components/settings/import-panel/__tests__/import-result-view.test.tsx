/**
 * #640 — the CSV import result renders what actually happened.
 *
 * Project convention is SSR-only component tests (vitest runs `node`;
 * `@testing-library/react` is not installed), so the view takes the result as
 * a prop and each state is rendered directly.
 *
 * The states pinned here are the ones the report separated: a file where
 * everything was refused must not carry the success icon or success wording,
 * a mixed file reads as a warning, a clean file reads as a success, and a
 * file with no data rows gets its own message rather than either. Skip
 * reasons render grouped with a count, in plain language, inside the card's
 * `aria-live` region so a screen reader hears the outcome too.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  CsvImportResultView,
  type CsvImportResult,
} from "../import-result-view";
import { ImportPasteBody } from "../import-paste";

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function result(over: Partial<CsvImportResult> = {}): CsvImportResult {
  return {
    inserted: 0,
    updated: 0,
    skipped: 0,
    total: 0,
    dryRun: false,
    rows: [],
    ...over,
  };
}

/** The production envelope from the report: nothing written, everything refused. */
const ALL_SKIPPED = result({
  skipped: 1597,
  total: 1597,
  rows: Array.from({ length: 1597 }, (_, i) => ({
    line: i + 2,
    status: "skipped",
    reason: "invalid_glucose_context",
  })),
});

describe("<CsvImportResultView> — result states", () => {
  it("renders an all-skipped import as a failure, not a success", () => {
    const html = render(<CsvImportResultView result={ALL_SKIPPED} />);
    expect(html).toContain('data-outcome="failed"');
    expect(html).not.toContain('data-outcome="success"');
    expect(html).not.toContain("text-success");
    expect(html).toContain("Nothing was imported");
    expect(html).toContain("All 1597 rows were skipped");
  });

  it("renders a mixed import as a warning", () => {
    const html = render(
      <CsvImportResultView
        result={result({
          inserted: 3,
          skipped: 2,
          total: 5,
          rows: [
            { line: 2, status: "inserted" },
            { line: 3, status: "inserted" },
            { line: 4, status: "inserted" },
            { line: 5, status: "skipped", reason: "unknown_unit" },
            { line: 6, status: "skipped", reason: "duplicate" },
          ],
        })}
      />,
    );
    expect(html).toContain('data-outcome="partial"');
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-success");
  });

  it("renders a clean import as a success", () => {
    const html = render(
      <CsvImportResultView
        result={result({
          inserted: 4,
          updated: 1,
          total: 5,
          rows: [
            { line: 2, status: "inserted" },
            { line: 3, status: "inserted" },
            { line: 4, status: "inserted" },
            { line: 5, status: "inserted" },
            { line: 6, status: "updated" },
          ],
        })}
      />,
    );
    expect(html).toContain('data-outcome="success"');
    expect(html).toContain("text-success");
    expect(html).toContain("Imported 4 new and updated 1");
    expect(html).not.toContain("skipped");
  });

  it("gives a file with no data rows its own message", () => {
    const html = render(<CsvImportResultView result={result()} />);
    expect(html).toContain('data-outcome="empty"');
    expect(html).not.toContain("text-success");
    expect(html).toContain("no data rows");
  });

  it("reports a preview that would import nothing as a failure", () => {
    const html = render(
      <CsvImportResultView result={{ ...ALL_SKIPPED, dryRun: true }} />,
    );
    expect(html).toContain('data-outcome="failed"');
    expect(html).toContain("nothing would import");
  });
});

describe("<CsvImportResultView> — skip reasons", () => {
  it("groups a repeated reason into one counted line, in plain language", () => {
    const html = render(<CsvImportResultView result={ALL_SKIPPED} />);
    expect(html).toContain(
      "1597 rows skipped: glucose context is not one of the allowed values",
    );
    // One grouped line, not 1 597 (and not the old first-fifty list).
    const groups = html.split('data-testid="import-csv-skip-groups"')[1] ?? "";
    expect(groups.split("</li>").length - 1).toBeGreaterThan(0);
    expect(html.match(/1597 rows skipped/g)).toHaveLength(1);
  });

  it("keeps the per-line detail behind a disclosure", () => {
    const html = render(
      <CsvImportResultView
        result={result({
          skipped: 1,
          total: 1,
          rows: [{ line: 2, status: "skipped", reason: "unknown_unit" }],
        })}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("Show every skipped row");
    expect(html).toContain("Line 2: unit not recognized for this type");
  });

  it("labels a reason it does not know rather than leaking the raw token", () => {
    const html = render(
      <CsvImportResultView
        result={result({
          skipped: 1,
          total: 1,
          rows: [{ line: 2, status: "skipped", reason: "brand_new_reason" }],
        })}
      />,
    );
    expect(html).not.toContain("brand_new_reason");
    expect(html).toContain("1 row skipped: skipped");
  });
});

describe("<ImportPasteBody> — announcement", () => {
  it("keeps the result slot inside the polite live region", () => {
    const html = render(
      <ImportPasteBody
        slug="csv"
        fileMeta=".csv"
        accept=".csv"
        fileInputLabel="CSV file"
        placeholder=""
        text=""
        onTextChange={() => {}}
        onReadFailed={() => {}}
        guideTitle="Example and columns"
        guide={null}
        status={null}
      />,
    );
    expect(html).toContain('aria-live="polite"');
    // No result yet: the region is present and empty, so the first outcome to
    // land is announced rather than being read as initial content.
    expect(html).not.toContain('data-testid="import-csv-result"');
    // File, paste and the guide row, in that order.
    expect(html).toContain('data-testid="import-csv-choose-file"');
    expect(html).toContain('data-testid="import-csv-textarea"');
    expect(html).toContain('data-testid="import-csv-guide"');
  });
});
