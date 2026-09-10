/**
 * A failed cycle read must surface as a recoverable, foreground error, not a
 * hand-rolled muted line. The calendar read (which drives the default tab) is
 * forced into its error state; the tab has to render the shared query-error
 * primitive with retry, and no longer the muted `cycle-tab-error` row.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManage: true,
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
}));

const errorQuery = {
  data: undefined,
  isError: true,
  isLoading: false,
  refetch: vi.fn(),
};
const idleQuery = {
  data: undefined,
  isError: false,
  isLoading: false,
  refetch: vi.fn(),
};
const mutationStub = { mutate: vi.fn(), isPending: false, isError: false };

vi.mock("../use-cycle", () => ({
  localYmd: () => "2026-07-01",
  useCycleCalendar: () => errorQuery,
  useCycleHistory: () => idleQuery,
  useCycleInsights: () => idleQuery,
  useCycleProfile: () => idleQuery,
  useCycleDayLog: () => idleQuery,
  useCustomSymptoms: () => idleQuery,
  useLogDay: () => mutationStub,
  usePatchDayLog: () => mutationStub,
  useStartPeriod: () => mutationStub,
  useEndPeriod: () => mutationStub,
  useDeleteDayLog: () => mutationStub,
  useCreateCustomSymptom: () => mutationStub,
  useDeleteCustomSymptom: () => mutationStub,
  CUSTOM_SYMPTOM_LIMIT_ERROR_CODE: "cycle.symptom.custom.limit",
  CustomSymptomError: class extends Error {},
}));

import { I18nProvider } from "@/lib/i18n/context";
import { CycleView } from "../cycle-view";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CycleView />
    </I18nProvider>,
  );
}

describe("<CycleView> — a read failure is honest, not a muted line", () => {
  it("renders the shared query-error primitive with retry, not the muted row", () => {
    const html = render();
    expect(html).toContain('data-slot="query-error-row"');
    expect(html).toContain('data-slot="query-error-row-retry"');
    expect(html).not.toContain('data-slot="cycle-tab-error"');
  });
});
