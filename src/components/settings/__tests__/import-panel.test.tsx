/**
 * v1.15.7 — Settings → Export & Import → `<ImportPanel>` contract suite.
 *
 * Project convention is SSR-only component tests (vitest runs in the
 * `node` environment; `@testing-library/react` is not installed). The
 * panel's interactive paths (upload, poll, paste-and-import) are
 * exercised end-to-end by the e2e suite; here we pin:
 *
 *   1. The list's shape — one row per source with its stable testid, its
 *      localised copy and a real Choose button; the file sources hold a
 *      labelled file input in their row. The sheets are closed in SSR and
 *      are exercised by the e2e suite.
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
import {
  AppleHealthEstimateWarning,
  AppleHealthSkipLines,
  appleHealthDoneSummaryKind,
  appleHealthFailureKind,
  summarizeAppleHealthSkips,
} from "../import-panel/apple-health-import-card";
import { I18nProvider } from "@/lib/i18n/context";
import { ListGroup } from "@/components/ui/list-row";
import {
  ImportSources,
  EXAMPLE_IMPORT,
  EXAMPLE_IMPORT_DOWNLOAD_HREF,
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

function ImportPanel() {
  return (
    <ListGroup>
      <ImportSources />
    </ListGroup>
  );
}

describe("<ImportSources> — SSR smoke", () => {
  it("renders one row per source", () => {
    const html = render(<ImportPanel />);
    for (const id of [
      "import-card-apple-health",
      "import-card-health-connect",
      "import-card-fit",
      "import-card-gadgetbridge",
      "import-card-fhir-bundle",
      "import-card-csv",
      "import-card-json",
      "import-card-dose-history",
      "import-card-labs-csv",
      "import-card-medications-csv",
    ])
      expect(html).toContain(`data-testid="${id}"`);
    // Raw i18n keys never leak past the provider.
    expect(html).not.toContain("settings.sections.export.import.");
  });

  it("puts a real Choose button on every idle row", () => {
    const html = render(<ImportPanel />);
    for (const id of [
      "import-choose-apple-health",
      "import-choose-health-connect",
      "import-choose-fit",
      "import-card-gadgetbridge-open",
      "import-card-fhir-bundle-open",
      "import-choose-csv",
      "import-choose-json",
      "import-choose-dose-history",
    ])
      expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain('data-slot="record-import-open-labs"');
    expect(html).toContain('data-slot="record-import-open-medications"');
    expect(html).not.toContain('role="button"');
  });

  it("holds a labelled file input in each file source's row", () => {
    const html = render(<ImportPanel />);
    // Apple Health, Health Connect, FIT, Gadgetbridge and FHIR open the
    // file dialog straight from the row, so the input lives there.
    expect(html.match(/type="file"/g)?.length).toBe(5);
    const inputs = html.match(/<input[^>]*type="file"[^>]*>/g) ?? [];
    for (const input of inputs) expect(input).toContain("aria-label");
    // The FIT row takes several files at once.
    expect(inputs.filter((i) => i.includes("multiple")).length).toBe(1);
  });

  it("renders the German copy under the de locale", () => {
    const html = render(<ImportPanel />, "de");
    expect(html).toContain("Auswählen");
    expect(html).not.toContain("settings.sections.export.import.");
  });
});

describe("<AppleHealthEstimateWarning>", () => {
  it.each(["en", "de", "es", "fr", "it", "pl", "ko", "nl", "pt-BR"] as const)(
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

// (issue #775) — the worker writes two machine-readable failure
// reasons (the reconcile's `interrupted_by_restart` code and the memory
// preflight's `insufficient_memory` prefix). The card must translate
// them instead of echoing a raw code at the user; honest free-text
// reasons keep passing through verbatim.
/**
 * A6 — the worker has computed, persisted and served per-class skip
 * counters since v1.15; the card hardcoded `skipped: 0` and rendered
 * none of them. These pin the fold and the render.
 *
 * Watched red: with `summarizeAppleHealthSkips` gutted to return zeros
 * (the pre-fix card behaviour) the fold tests fail; with the
 * `<AppleHealthSkipLines>` mount removed the render test fails on the
 * missing test ids.
 */
describe("appleHealthDoneSummaryKind", () => {
  it("never heads a labs-only archive with zero imported samples", () => {
    expect(appleHealthDoneSummaryKind(0, 4)).toBe("auxOnly");
    expect(appleHealthDoneSummaryKind(12, 4)).toBe("samples");
    expect(appleHealthDoneSummaryKind(12, 0)).toBe("samples");
    expect(appleHealthDoneSummaryKind(0, 0)).toBe("nothing");
  });
});

describe("summarizeAppleHealthSkips", () => {
  it("splits deliberate exclusions from genuine refusals", () => {
    const summary = summarizeAppleHealthSkips({
      unknown: {
        HKQuantityTypeIdentifierFutureTypeXYZ: 40, // unsupported type
        "HKQuantityTypeIdentifierBodyMass::unparseable": 3, // refusal
        "WEIGHT::upsert_failed": 2, // refusal
        "element::UnknownElement": 99, // structural, not a sample
      },
      deferred: { HKQuantityTypeIdentifierDietaryWater: 10 },
    });
    expect(summary.unsupported).toBe(50);
    expect(summary.refused).toBe(5);
    // Largest first; the structural element never appears.
    expect(summary.breakdown.map((entry) => entry.key)).toEqual([
      "HKQuantityTypeIdentifierFutureTypeXYZ",
      "HKQuantityTypeIdentifierDietaryWater",
      "HKQuantityTypeIdentifierBodyMass::unparseable",
      "WEIGHT::upsert_failed",
    ]);
  });

  it("returns zeros for an empty / missing result", () => {
    expect(summarizeAppleHealthSkips(null)).toEqual({
      unsupported: 0,
      refused: 0,
      breakdown: [],
    });
  });
});

describe("<AppleHealthSkipLines>", () => {
  it("renders every populated skip class", () => {
    const html = render(
      <AppleHealthSkipLines
        skips={summarizeAppleHealthSkips({
          unknown: { "HKQuantityTypeIdentifierBodyMass::out_of_range": 2 },
          deferred: { HKQuantityTypeIdentifierDietaryWater: 7 },
        })}
        cycle={{
          samplesConsumed: 12,
          samplesSkippedModuleDisabled: 0,
          daysUpserted: 4,
          daysFailed: 1,
          firstFailureReason: "colliding day",
        }}
      />,
    );
    expect(html).toContain('data-testid="apple-health-skip-unsupported"');
    expect(html).toContain('data-testid="apple-health-skip-refused"');
    expect(html).toContain('data-testid="apple-health-cycle-summary"');
    expect(html).toContain('data-testid="apple-health-cycle-days-failed"');
    expect(html).toContain("colliding day");
    expect(html).toContain('data-testid="apple-health-skip-breakdown"');
  });

  it("names the module-disabled cycle drop", () => {
    const html = render(
      <AppleHealthSkipLines
        skips={summarizeAppleHealthSkips(null)}
        cycle={{ samplesSkippedModuleDisabled: 21 }}
      />,
    );
    expect(html).toContain('data-testid="apple-health-cycle-module-off"');
    expect(html).toContain("21");
  });

  it("renders nothing when there is nothing to explain", () => {
    const html = render(
      <AppleHealthSkipLines
        skips={summarizeAppleHealthSkips(null)}
        cycle={undefined}
      />,
    );
    expect(html).toBe("");
  });
});

describe("appleHealthFailureKind", () => {
  it("maps the reconcile code onto translated copy", () => {
    expect(appleHealthFailureKind("interrupted_by_restart")).toBe(
      "interrupted",
    );
  });

  it("maps the memory-preflight refusal onto translated copy", () => {
    expect(
      appleHealthFailureKind(
        "insufficient_memory: export.xml declares 8192 MiB uncompressed; " +
          "parsing it needs roughly 320 MiB of heap but the Node.js heap " +
          "limit is 256 MiB.",
      ),
    ).toBe("insufficientMemory");
  });

  it("passes honest free-text reasons through verbatim", () => {
    expect(
      appleHealthFailureKind("Import staging file is no longer available"),
    ).toBe("raw");
  });

  it("returns null when the job has no failure reason", () => {
    expect(appleHealthFailureKind(null)).toBeNull();
    expect(appleHealthFailureKind("")).toBeNull();
  });
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

  it("exposes a self-contained, inert JSON download target", () => {
    expect(EXAMPLE_IMPORT_DOWNLOAD_HREF).toMatch(
      /^data:application\/json;charset=utf-8,/,
    );
    expect(EXAMPLE_IMPORT_DOWNLOAD_HREF).not.toMatch(
      /(?:javascript:|blob:|<script)/i,
    );

    const encoded = EXAMPLE_IMPORT_DOWNLOAD_HREF.split(",", 2)[1];
    expect(encoded).toBeTruthy();
    expect(JSON.parse(decodeURIComponent(encoded!))).toEqual(EXAMPLE_IMPORT);

    const html = render(<ImportPanel />);
    expect(html).toContain('download="healthlog-import-example.json"');
    expect(html).toContain('href="data:application/json;charset=utf-8,');
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

  it("carries a contextless glucose reading, the shape a sensor export has", () => {
    const out = parseCsvMeasurements(EXAMPLE_CSV, {
      now: new Date("2026-06-01T00:00:00Z").getTime(),
    });
    const glucose = out.rows
      .map((r) => r.row)
      .filter((row) => row?.type === "BLOOD_GLUCOSE");
    expect(glucose.length).toBeGreaterThanOrEqual(2);
    expect(glucose.some((row) => row?.glucoseContext === undefined)).toBe(true);
    expect(glucose.some((row) => row?.glucoseContext === "FASTING")).toBe(true);
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
