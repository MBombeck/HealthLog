/**
 * Settings → Export & Import: the page is two lists in one column, a row
 * per import source and a row per export, each opening a sheet. SSR smoke:
 * the sheets are closed, so the page is the rows alone. The sheets are
 * exercised by the e2e suite.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

vi.mock("@tanstack/react-query", () => ({
  // The cycle-export card and the Apple-Health status poll both call
  // `useQuery`; `data: null` keeps the gated cycle card hidden and the
  // import poll idle, which is the correct default-render state.
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SettingsSectionFrame } from "./section-frame-harness";
import { ExportSection } from "../export-section";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<ExportSection> — SSR smoke", () => {
  it("renders the section heading + description", () => {
    // v1.18.6 — the page heading comes from the shared frame the route
    // wraps the section in.
    const html = render(
      <SettingsSectionFrame slug="export">
        <ExportSection />
      </SettingsSectionFrame>,
    );
    // v1.15.7 — the section was relabelled "Export & Import" (issue #281).
    expect(html).toContain("Export &amp; import");
    // Raw key never leaks past i18n.
    expect(html).not.toContain("settings.sections.export.");
  });

  it("lists every import source as a row with Choose", () => {
    const html = render(<ExportSection />);
    expect(html).toContain('id="settings-section-import-title"');
    const ids = [
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
    ];
    for (const id of ids) expect(html).toContain(`data-testid="${id}"`);
    // Nothing runs and nothing failed: every row offers Choose.
    expect(html.match(/>Choose</g)?.length ?? 0).toBe(ids.length);
    expect(html).not.toContain('data-slot="status-chip"');
  });

  it("lists the exports as rows that open, the doctor's report as a link", () => {
    const html = render(<ExportSection />);
    for (const id of [
      "export-card-full-backup",
      "export-card-measurements-csv",
      "export-card-medications-csv",
      "export-card-mood-csv",
    ])
      expect(html).toContain(`data-testid="${id}"`);
    expect(html).toMatch(
      /data-testid="export-card-doctor-report"[\s\S]*?href="\/settings\/health-record"/,
    );
    // The download sits in each row's sheet, not on the page.
    expect(html).not.toContain('data-testid="export-action-');
  });

  it("is one column of two lists, no card grid", () => {
    const html = render(<ExportSection />);
    expect(html.match(/data-slot="list-group"/g)?.length).toBe(2);
    expect(html).not.toContain("grid-cols");
    expect(html).not.toContain("health-record-export-panel");
  });

  it("German locale renders the DE headings", () => {
    const html = render(<ExportSection />, "de");
    expect(html).toContain("Importieren");
    expect(html).toContain("Exportieren");
    expect(html).toContain("Auswählen");
    expect(html).not.toContain("settings.sections.export.");
  });
});
