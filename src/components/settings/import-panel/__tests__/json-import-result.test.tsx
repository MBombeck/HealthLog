/**
 * What the JSON import card says once a file is in.
 *
 * SSR-only, like the sibling card tests: the markup each result renders. The
 * claim worth pinning is the one the counts cannot make. A mood entry whose
 * tag the account does not have lands without that link, and the card names
 * the tag rather than reporting a clean import.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import {
  JsonImportResultView,
  readJsonImportResult,
} from "../json-import-card";

function render(data: Parameters<typeof readJsonImportResult>[0]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <JsonImportResultView result={readJsonImportResult(data)} />
    </I18nProvider>,
  );
}

describe("<JsonImportResultView>", () => {
  it("names the tags an import could not link", () => {
    const html = render({
      measurements: 3,
      moodEntries: 2,
      skipped: 0,
      droppedTagKeys: ["custom:long_walk"],
      droppedFactorKeys: ["retired_factor"],
    });
    expect(html).toContain('data-testid="import-json-dropped-links"');
    expect(html).toContain("custom:long_walk, retired_factor");
    expect(html).toContain("Imported 3 measurements and 2 mood entries");
  });

  it("names the account's own tags it kept rather than renamed", () => {
    const html = render({
      measurements: 0,
      moodEntries: 2,
      skipped: 0,
      keptMoodTagKeys: ["custom:walk"],
      keptMoodCategoryKeys: ["customcat:outdoors"],
    });
    expect(html).toContain('data-testid="import-json-kept-labels"');
    expect(html).toContain("custom:walk, customcat:outdoors");
  });

  it("says nothing about links when every one landed", () => {
    const html = render({ measurements: 3, moodEntries: 2, skipped: 0 });
    expect(html).not.toContain("import-json-dropped-links");
    expect(html).not.toContain("import-json-kept-labels");
  });

  it("reads a missing count as none", () => {
    expect(readJsonImportResult(null)).toEqual({
      measurements: 0,
      moodEntries: 0,
      skipped: 0,
      droppedLinkKeys: [],
      keptLabelKeys: [],
    });
  });
});
