/**
 * v1.4.16 Phase B7 — Settings → Export section.
 *
 * The acceptance criterion for the consolidated Export menu was "five
 * cards":
 *   1. Doctor Report (PDF) — promoted to the hero in v1.4.37 W7a;
 *      now lives at the top of the page, NOT in the grid
 *   2. Measurements CSV
 *   3. Medications CSV (with optional intake-history toggle)
 *   4. Mood CSV
 *   5. Full JSON Backup
 *
 * Each card must surface a title, a 1-line description, and a
 * download/generate button. SSR-only smoke test — interaction is
 * exercised by the e2e suite.
 *
 * v1.4.37 W7a — the doctor-report card was extracted into
 * `<ArztberichtHeroCard>` and rendered above the grid. The remaining
 * four cards stay under a "Weitere Export-Optionen" / "Other export
 * options" sub-heading. The hero owns its own contract test; this
 * suite pins the page-level shape.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

vi.mock("@tanstack/react-query", () => ({
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
import { ExportSection } from "../export-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<ExportSection> — SSR smoke", () => {
  it("renders the section heading + description", () => {
    const html = render(<ExportSection />);
    expect(html).toContain("Export");
    // Raw key never leaks past i18n.
    expect(html).not.toContain("settings.sections.export.");
  });

  it("renders the Arztbericht hero card at the top of the page", () => {
    const html = render(<ExportSection />);
    // The hero owns its own contract suite; here we pin that the page
    // mounts it, and that the legacy in-grid doctor-report card is
    // gone (v1.4.37 W7a moved it into the hero).
    expect(html).toContain('data-testid="export-hero-doctor-report"');
    expect(html).not.toContain('data-testid="export-card-doctor-report"');
  });

  it("renders the 'Other export options' sub-heading above the grid", () => {
    const html = render(<ExportSection />);
    expect(html).toContain("Other export options");
    expect(html).toContain('id="settings-section-export-other-title"');
  });

  it("renders exactly four secondary export cards in the grid", () => {
    const html = render(<ExportSection />);
    // Each card carries a stable data-testid so the e2e suite can target
    // them without relying on the localised label. The doctor-report
    // card is no longer in this grid — it's the hero above.
    const ids = [
      "export-card-measurements-csv",
      "export-card-medications-csv",
      "export-card-mood-csv",
      "export-card-full-backup",
    ];
    for (const id of ids) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it("renders the medications-CSV intake-history toggle", () => {
    const html = render(<ExportSection />);
    // The medications card has a checkbox/toggle for "include intake
    // history" so the user can pick a smaller export when they only
    // want the medication list.
    expect(html).toContain('data-testid="export-medications-include-intake"');
  });

  it("renders a download/generate button per secondary card + the hero CTA", () => {
    const html = render(<ExportSection />);
    // Four secondary cards each carry an `export-action-*` testid; the
    // hero owns the `export-hero-doctor-report-action` slot.
    const buttonMatches = html.match(/data-testid="export-action-/g);
    expect(buttonMatches?.length ?? 0).toBe(4);
    expect(html).toContain('data-testid="export-hero-doctor-report-action"');
  });

  it("German locale renders the DE heading + hero copy", () => {
    const html = render(<ExportSection />, "de");
    expect(html).toContain("Export");
    expect(html).toContain("Arztbericht");
    expect(html).toContain("Weitere Export-Optionen");
    expect(html).not.toContain("settings.sections.export.");
  });
});
