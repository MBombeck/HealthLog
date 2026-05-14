/**
 * v1.4.25 W19c-Frontend — `<AdvancedSection>` Research Mode card tests.
 *
 * The card lives next to the danger-zone delete and drives three
 * server interactions:
 *
 *   GET    /api/auth/me/research-mode   on mount, via TanStack Query
 *   POST   /api/auth/me/research-mode   via the acknowledgment dialog
 *   DELETE /api/auth/me/research-mode   directly when the user
 *                                       toggles OFF
 *
 * The toggle ON path opens the dialog; only the dialog's CTA fires
 * the POST (so the user reads the disclaimer first). OFF fires
 * DELETE directly. A version-mismatch banner renders above the
 * toggle whenever `acknowledgedVersion !== currentDisclaimerVersion`
 * even when `enabled === true`.
 *
 * The dialog itself is covered by
 * `ResearchModeAcknowledgmentDialog.test.tsx`; we mock it down to a
 * marker here so the toggle behaviour is the only contract under
 * test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const queryResults: Record<string, unknown> = {};

function setQueryResult(keyJoined: string, data: unknown) {
  queryResults[keyJoined] = data;
}

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = (queryKey as Array<string | number>).join("/");
    return {
      data: queryResults[key],
      isLoading: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The acknowledgment dialog is exercised in its own spec; mock the
// import to a transparent marker so we can assert "the toggle ON path
// renders the dialog with the right props" without re-running the
// dialog tree.
vi.mock("@/components/medications/ResearchModeAcknowledgmentDialog", () => ({
  ResearchModeAcknowledgmentDialog: ({
    open,
    currentDisclaimerVersion,
  }: {
    open: boolean;
    currentDisclaimerVersion: string | null;
  }) => (
    <div
      data-slot="mock-ack-dialog"
      data-open={open ? "true" : "false"}
      data-version={currentDisclaimerVersion ?? ""}
    />
  ),
}));

import { AdvancedSection } from "../advanced-section";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  for (const k of Object.keys(queryResults)) delete queryResults[k];
});

describe("<AdvancedSection> → Research Mode card", () => {
  it("renders the section title + subtitle + toggle in OFF state", () => {
    setQueryResult("research-mode", {
      enabled: false,
      acknowledgedAt: null,
      acknowledgedVersion: null,
      currentDisclaimerVersion: "2026-05-14.1",
    });

    const html = render(<AdvancedSection />);

    expect(html).toContain('data-slot="settings-research-mode-card"');
    expect(html).toContain("Research Mode");
    expect(html).toContain("Show the estimated drug-level chart");
    // OFF state status line.
    expect(html).toContain("Disabled. The drug-level chart is hidden.");
    // No re-prompt banner when versions already align (or the user has
    // never acknowledged in the first place).
    expect(html).not.toContain('data-slot="settings-research-mode-reprompt"');
    // Switch is unchecked.
    const switchTag = html.match(
      /<button[^>]*data-slot="settings-research-mode-toggle"[^>]*>/,
    )?.[0];
    expect(switchTag).toBeDefined();
    expect(switchTag).not.toMatch(/data-state="checked"/);
  });

  it("renders the acknowledged-on status when enabled + versions aligned", () => {
    setQueryResult("research-mode", {
      enabled: true,
      acknowledgedAt: "2026-05-14T08:30:00Z",
      acknowledgedVersion: "2026-05-14.1",
      currentDisclaimerVersion: "2026-05-14.1",
    });

    const html = render(<AdvancedSection />);

    // Acknowledged-on copy carries the formatted date (the i18n
    // template uses `{date}`; the formatter renders the day).
    expect(html).toMatch(/Acknowledged on/);
    // Banner stays hidden when versions match.
    expect(html).not.toContain('data-slot="settings-research-mode-reprompt"');
    // Switch is checked.
    const switchTag = html.match(
      /<button[^>]*data-slot="settings-research-mode-toggle"[^>]*>/,
    )?.[0];
    expect(switchTag).toMatch(/data-state="checked"/);
  });

  it("renders the re-prompt banner when versions diverge", () => {
    setQueryResult("research-mode", {
      enabled: true,
      acknowledgedAt: "2026-04-01T00:00:00Z",
      acknowledgedVersion: "2026-04-01.1",
      currentDisclaimerVersion: "2026-05-14.1",
    });

    const html = render(<AdvancedSection />);

    expect(html).toContain('data-slot="settings-research-mode-reprompt"');
    expect(html).toContain("Disclaimer updated");
    expect(html).toContain(
      'data-slot="settings-research-mode-reprompt-cta"',
    );
    expect(html).toContain("Re-acknowledge disclaimer");
    // Status line reflects the stale state without claiming
    // "acknowledged on …" — that copy would mis-represent that the
    // chart is currently painting.
    expect(html).not.toMatch(/Acknowledged on/);
    expect(html).toContain(
      "The disclaimer was updated. Re-acknowledge below to bring the chart back.",
    );
    // The toggle stays "on" — we surface the previous choice; the
    // banner explains why the chart isn't painting.
    const switchTag = html.match(
      /<button[^>]*data-slot="settings-research-mode-toggle"[^>]*>/,
    )?.[0];
    expect(switchTag).toMatch(/data-state="checked"/);
  });

  it("forwards the current server-supplied version to the dialog", () => {
    setQueryResult("research-mode", {
      enabled: false,
      acknowledgedAt: null,
      acknowledgedVersion: null,
      currentDisclaimerVersion: "2026-06-01.2",
    });

    const html = render(<AdvancedSection />);

    // The dialog renders even when closed (its `open` prop is what
    // controls visibility); the data-version attribute lets us verify
    // the parent passes the live version string through.
    expect(html).toContain('data-slot="mock-ack-dialog"');
    expect(html).toMatch(/data-version="2026-06-01\.2"/);
    expect(html).toMatch(/data-open="false"/);
  });

  it("renders German copy when locale='de'", () => {
    setQueryResult("research-mode", {
      enabled: false,
      acknowledgedAt: null,
      acknowledgedVersion: null,
      currentDisclaimerVersion: "2026-05-14.1",
    });

    const html = render(<AdvancedSection />, "de");

    expect(html).toContain("Forschungsmodus");
    expect(html).toContain("Geschätzte Wirkstoffkurve anzeigen");
    expect(html).toContain("Deaktiviert");
  });
});
