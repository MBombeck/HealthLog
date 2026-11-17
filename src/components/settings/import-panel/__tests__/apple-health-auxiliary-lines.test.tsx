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
    expect(html).not.toContain("import-apple-health-ecg-result");
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
