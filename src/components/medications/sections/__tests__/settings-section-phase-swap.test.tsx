/**
 * v1.5.6 G-1 §5 — phase sibling-swap wiring on `<SettingsSection>`.
 *
 * When the hosting `<AdvancedSettingsSheet>` passes
 * `onRequestPhaseSheet`, the section must NOT mount its own
 * `<PhaseConfigSheet>` — the parent orchestrates the swap (close the
 * advanced sheet, then open the phase sheet) so the two never stack.
 * Without the callback the section keeps owning its own phase sheet,
 * preserving the standalone-surface fallback.
 *
 * `<PhaseConfigSheet>` is mocked to a marker so its presence /
 * absence is observable in static markup regardless of open-state.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/components/medications/sections/api-tokens-row", () => ({
  ApiTokensRow: () => <div data-slot="mock-api-tokens" />,
}));

vi.mock("@/components/medications/sections/phase-config-sheet", () => ({
  PhaseConfigSheet: () => <div data-slot="mock-phase-config-sheet" />,
}));

import { SettingsSection } from "@/components/medications/sections/settings-section";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={makeClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

// GLP-1 + a set course window so the Phasen row + button mount.
const glp1Props = {
  medicationId: "med-1",
  medicationName: "Test Drug",
  treatmentClass: "GLP1",
  startsOn: "2026-01-01",
  endsOn: "2026-06-01",
  reminderGraceMinutes: 30,
};

describe("SettingsSection phase sibling-swap (G-1 §5)", () => {
  it("does NOT self-mount the phase sheet when onRequestPhaseSheet is provided", () => {
    const html = render(
      <SettingsSection {...glp1Props} onRequestPhaseSheet={() => {}} />,
    );
    expect(html).toContain("medication-detail-phase-management-button");
    expect(html).not.toContain("mock-phase-config-sheet");
  });

  it("self-mounts the phase sheet on the standalone surface (no callback)", () => {
    const html = render(<SettingsSection {...glp1Props} />);
    expect(html).toContain("medication-detail-phase-management-button");
    expect(html).toContain("mock-phase-config-sheet");
  });
});
