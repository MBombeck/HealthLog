/**
 * The dashboard's next-appointment line opens the appointment, on the visits
 * tab, and not the checkups list the card otherwise summarises.
 *
 * The line linked the bare `/care`, which opens the preventive-care tab —
 * the one list an appointment is never on. The negative control is the card's
 * own empty state, whose link is to the checkups and stays there.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const visit = {
  id: "visit-42",
  status: "PLANNED",
  kind: "SPECIALIST",
  // Inside the card's two-week horizon whenever the suite runs.
  occurredAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  practitioner: { name: "Practice Example" },
};

vi.mock("@/hooks/use-measurement-reminders", () => ({
  useMeasurementReminders: () => ({
    data: [],
    isError: false,
    refetch: vi.fn(),
  }),
  useMeasurementReminderMutations: () => ({
    satisfy: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/hooks/use-encounters", () => ({
  useEncounters: () => ({ data: { upcoming: [visit], past: [] } }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManage: true,
    canWriteDomain: () => true,
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

function linkHref(html: string, slot: string): string | null {
  const tag = html.match(new RegExp(`<a[^>]*data-slot="${slot}"[^>]*>`));
  return tag?.[0].match(/href="([^"]*)"/)?.[1] ?? null;
}

describe("<VorsorgeDashboardCard> — the next appointment", () => {
  it("opens the visit itself", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <VorsorgeDashboardCard />
      </I18nProvider>,
    );
    expect(html).toContain("Practice Example");
    expect(linkHref(html, "vorsorge-dashboard-next-visit")).toBe(
      "/care?visit=visit-42",
    );
    // The empty state names the checkups and still opens them.
    expect(html).toContain('href="/care"');
  });
});
