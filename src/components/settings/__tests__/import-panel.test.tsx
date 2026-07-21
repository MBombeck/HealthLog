/**
 * v1.15.7 — Settings → Export & Import → `<ImportPanel>` contract suite.
 *
 * Project convention is SSR-only component tests (vitest runs in the
 * `node` environment; `@testing-library/react` is not installed). The
 * panel's interactive paths (upload, poll, paste-and-import) are
 * exercised end-to-end by the e2e suite; here we pin:
 *
 *   1. The page-level shape — both import cards render with their stable
 *      testids, localised copy, and the accessible controls (labelled
 *      file inputs, keyboard-operable drop area, aria-live status slot).
 *   2. The "Download example" payload — the inline example JSON the
 *      button mints must parse and carry the documented field shape (the
 *      two arrays, the German-anchored mood enum), so the docs and the
 *      button never drift from the route.
 *   3. The error guard — the JSON import refuses an unparseable paste
 *      before it ever hits the network (validated through the exported
 *      helper).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

import type { Locale } from "@/lib/i18n/config";
import { AppleHealthEstimateWarning } from "../import-panel/apple-health-import-card";
import { I18nProvider } from "@/lib/i18n/context";
import {
  ImportPanel,
  EXAMPLE_IMPORT,
  EXAMPLE_CSV,
  parseImportJson,
} from "../import-panel";

import { parseCsvMeasurements } from "@/lib/import/csv-measurements";

function render(node: React.ReactElement, locale: Locale = "en") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<ImportPanel> — SSR smoke", () => {
  it("renders the import heading and both cards", () => {
    const html = render(<ImportPanel />);
    expect(html).toContain('id="settings-section-import-title"');
    expect(html).toContain('data-testid="import-card-apple-health"');
    expect(html).toContain('data-testid="import-card-json"');
    expect(html).toContain('data-testid="import-card-csv"');
    // Raw i18n keys never leak past the provider.
    expect(html).not.toContain("settings.sections.export.import.");
  });

  it("exposes the action controls with stable testids", () => {
    const html = render(<ImportPanel />);
    for (const id of [
      "import-action-apple-health",
      "import-json-textarea",
      "import-json-choose-file",
      "import-json-download-example",
      "import-action-json",
      "import-csv-textarea",
      "import-csv-choose-file",
      "import-csv-download-example",
      "import-csv-preview",
      "import-action-csv",
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it("gives the Apple Health drop area a keyboard-operable role", () => {
    const html = render(<ImportPanel />);
    // A div masquerading as a button must be focusable + role=button so a
    // keyboard user can trigger the file picker.
    expect(html).toContain('role="button"');
    expect(html).toContain("aria-live");
  });

  it("labels the hidden file inputs for assistive tech", () => {
    const html = render(<ImportPanel />);
    // Both file inputs are visually hidden (sr-only) but must carry an
    // accessible name.
    expect(html).toContain('type="file"');
    expect(html).toContain("aria-label");
  });

  it("renders the German copy under the de locale", () => {
    const html = render(<ImportPanel />, "de");
    expect(html).toContain("Import");
    expect(html).not.toContain("settings.sections.export.import.");
  });
});

describe("<AppleHealthEstimateWarning>", () => {
  it.each(["en", "de", "es", "fr", "it", "pl"] as const)(
    "renders localized estimate disclosure for %s",
    (locale) => {
      const html = render(<AppleHealthEstimateWarning days={3} />, locale);
      expect(html).toContain('data-testid="apple-health-estimate-warning"');
      expect(html).toContain("3");
      expect(html).not.toContain(
        "settings.sections.export.import.appleHealth.estimateWarning",
      );
    },
  );
});

describe("EXAMPLE_IMPORT payload", () => {
  it("round-trips through JSON and stays parseable", () => {
    const serialised = JSON.stringify(EXAMPLE_IMPORT, null, 2);
    const parsed = parseImportJson(serialised);
    expect(parsed.ok).toBe(true);
  });

  it("carries both arrays with the documented field shape", () => {
    expect(Array.isArray(EXAMPLE_IMPORT.measurements)).toBe(true);
    expect(Array.isArray(EXAMPLE_IMPORT.moodEntries)).toBe(true);
    const m = EXAMPLE_IMPORT.measurements[0]!;
    expect(m).toHaveProperty("type");
    expect(m).toHaveProperty("value");
    expect(m).toHaveProperty("unit");
    expect(m).toHaveProperty("measuredAt");
    const mood = EXAMPLE_IMPORT.moodEntries[0]!;
    expect(mood).toHaveProperty("date");
    expect(mood).toHaveProperty("mood");
    expect(mood).toHaveProperty("score");
    // The mood enum values must be the German-anchored server enum.
    expect(["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]).toContain(
      mood.mood,
    );
  });
});

describe("EXAMPLE_CSV", () => {
  it("parses entirely to ok rows (example must not drift from the schema)", () => {
    // Pin the clock well past the fixture timestamps so the entry-instant
    // bound never rejects the example as future-dated.
    const out = parseCsvMeasurements(EXAMPLE_CSV, {
      now: new Date("2026-06-01T00:00:00Z").getTime(),
    });
    expect(out.fatal).toBeUndefined();
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.rows.every((r) => r.status === "ok")).toBe(true);
  });
});

describe("parseImportJson guard", () => {
  it("rejects an unparseable string before any network call", () => {
    const result = parseImportJson("{ not json");
    expect(result.ok).toBe(false);
  });

  it("accepts a minimal valid body", () => {
    const result = parseImportJson('{"measurements":[]}');
    expect(result.ok).toBe(true);
  });
});
