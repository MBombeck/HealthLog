/**
 * The ECG and lab-result lines under a finished Apple Health import.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { MessageBundle } from "@/lib/i18n/load-locale";
import en from "../../../../../messages/en.json";
import de from "../../../../../messages/de.json";

import { AppleHealthAuxiliaryLines } from "../apple-health-auxiliary-lines";

function render(
  props: Parameters<typeof AppleHealthAuxiliaryLines>[0],
  locale: "en" | "de" = "en",
): string {
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={(locale === "en" ? en : de) as unknown as MessageBundle}
    >
      <AppleHealthAuxiliaryLines {...props} />
    </I18nProvider>,
  );
}

describe("<AppleHealthAuxiliaryLines>", () => {
  it("renders nothing for an archive with neither", () => {
    expect(render({})).toBe("");
    expect(render({ ecg: { discovered: 0 }, labs: { discovered: 0 } })).toBe(
      "",
    );
  });

  it("renders the lab line with every count", () => {
    const html = render({
      labs: { discovered: 7, imported: 4, duplicate: 1, skipped: 1, failed: 1 },
    });
    expect(html).toContain('data-testid="import-apple-health-labs-result"');
    expect(html).toContain(
      "Lab results from health records: 7 found, 4 imported, 1 already in your record, 1 skipped, 1 failed.",
    );
    expect(html).toContain(
      "A lab result that fails does not discard anything else from the archive.",
    );
    expect(html).not.toContain("import-apple-health-ecg-result");
  });

  it("names what the skipped and failed results are made of", () => {
    const html = render({
      labs: {
        discovered: 9,
        imported: 2,
        skipped: 3,
        failed: 4,
        reasons: { not_lab: 3, unit_mismatch: 4, bogus: 7 },
      },
    });
    expect(html).toContain(
      "Not imported: unit does not match the marker (4), not a lab result (3).",
    );
    expect(html).not.toContain("bogus");
    expect(render({ labs: { discovered: 1, imported: 1 } })).not.toContain(
      "Not imported",
    );
  });

  it("keeps the failure reassurance off a clean run and links to Labs", () => {
    const html = render({
      labs: { discovered: 3, imported: 3, markersCreated: 2 },
    });
    expect(html).not.toContain("does not discard");
    expect(html).toContain("2 new markers were added to Labs.");
    expect(html).toContain('href="/labs"');
  });

  it("offers no Labs link when nothing reached the record", () => {
    const html = render({ labs: { discovered: 2, skipped: 2 } });
    expect(html).not.toContain('href="/labs"');
    expect(html).not.toContain("new marker");
  });

  it("formats the counts for the locale", () => {
    expect(render({ labs: { discovered: 1240, imported: 1240 } })).toContain(
      "1,240 found, 1,240 imported",
    );
    expect(
      render({ labs: { discovered: 1240, imported: 1240 } }, "de"),
    ).toContain("1.240 gefunden, 1.240 importiert");
  });

  it("renders the ECG line beside it", () => {
    const html = render({
      ecg: { discovered: 2, imported: 2 },
      labs: { discovered: 1, imported: 1 },
    });
    expect(html).toContain("import-apple-health-ecg-result");
    expect(html).toContain("import-apple-health-labs-result");
  });

  it("speaks the active locale", () => {
    expect(render({ labs: { discovered: 2, imported: 2 } }, "de")).toContain(
      "Laborwerte aus Gesundheitsakten: 2 gefunden, 2 importiert",
    );
  });
});
