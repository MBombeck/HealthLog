/**
 * A reminder-read failure on the dashboard Vorsorge tile must not read as "no
 * upcoming checkup reminders" — a missed preventive-care nudge is the harm
 * behind that fall-through. `useMeasurementReminders` is forced into its error
 * state; the tile has to render a `query-error-row` with retry and never the
 * empty copy.
 *
 * SSR-static render; the query-backed hooks are mocked so the error branch is
 * synchronous.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-measurement-reminders", () => ({
  useMeasurementReminders: () => ({
    data: undefined,
    isError: true,
    refetch: vi.fn(),
  }),
  useMeasurementReminderMutations: () => ({
    satisfy: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/hooks/use-encounters", () => ({
  useEncounters: () => ({ data: { upcoming: [] } }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManage: true,
    canAdd: true,
    canManageDomain: () => true,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { VorsorgeDashboardCard } from "../vorsorge-dashboard-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <VorsorgeDashboardCard />
    </I18nProvider>,
  );
}

describe("<VorsorgeDashboardCard> — a read failure is honest, not empty", () => {
  it("renders the query-error row with retry and never the empty copy", () => {
    const html = render();
    expect(html).toContain('data-slot="query-error-row"');
    expect(html).toContain('data-slot="query-error-row-retry"');
    expect(html).not.toContain("No upcoming checkup reminders");
  });
});
