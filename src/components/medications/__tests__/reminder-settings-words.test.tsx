/**
 * The reminder settings say what will happen. The plan line reads the
 * resolved next dose (when it turns overdue, when it counts as missed), the
 * phases are reachable for every scheduled medication (they were GLP-1 only)
 * and named after the dose state they announce, and an automatically
 * recorded medication no longer reads "Reminders are on".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => true,
    canManageDomain: () => true,
    inSharedRecord: false,
  }),
  useActiveRecordName: () => null,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", timezone: "UTC", timeFormat: "H24" },
    isAuthenticated: false,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ReminderPlanLine } from "@/components/medications/detail/overview-status-section";
import { NotificationsBody } from "@/components/medications/sections/notifications-section";
import { PhasesRow } from "@/components/medications/sections/settings-section";
import { queryKeys } from "@/lib/query-keys";

function render(node: React.ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("reminder settings in words", () => {
  it("says when the next dose turns overdue and when it counts as missed", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.medicationCompliance("m1"), {
      complianceDisplay: {
        currentDose: {
          targetAt: "2030-01-01T08:00:00.000Z",
          dueAt: "2030-01-01T07:00:00.000Z",
          overdueSince: "2030-01-01T09:00:00.000Z",
          missedAfter: "2030-01-01T12:00:00.000Z",
        },
      },
    });
    const html = render(<ReminderPlanLine medicationId="m1" />, client);
    expect(html).toContain('data-slot="medication-reminder-plan"');
    // The resolved instants, in the reader's zone (Berlin here).
    expect(html).toContain("overdue after 10:00 AM;");
    expect(html).toContain("after 01:00 PM it counts as missed");
  });

  it("names a dose recorded automatically as sending no reminders", () => {
    const html = render(
      <NotificationsBody
        medicationId="m1"
        notificationsEnabled
        autoMarkTaken
      />,
    );
    expect(html).toContain("no reminders are sent");
    expect(html).not.toContain("Reminders are on.");
  });

  it("offers the reminder phases for any medication", () => {
    const html = render(<PhasesRow medicationId="m1" />);
    expect(html).toContain(
      'data-slot="medication-detail-phase-management-button"',
    );
    expect(html).toContain("Reminder timing");
  });
});
