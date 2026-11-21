import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let mockAuthLoading = false;
let mockIsAuthenticated = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/medications",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockAuthLoading,
    user: { timezone: "Europe/Berlin" },
  }),
}));

vi.mock("@/hooks/use-record-capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-record-capabilities")>();
  return {
    ...actual,
    useRecordCapabilities: () => ({
      canWriteDomain: () => true,
      canManageDomain: () => true,
      inSharedRecord: false,
    }),
    useActiveRecordName: () => null,
  };
});

vi.mock("@/components/medications/wizard/medication-wizard-dialog", () => ({
  MedicationWizardDialog: () => null,
}));
vi.mock("@/components/medications/log-intake-dialog", () => ({
  LogIntakeDialog: () => null,
}));
vi.mock("@/components/medications/take-all-due-dialog", () => ({
  TakeAllDueDialog: () => null,
}));

import MedicationsPage from "@/app/medications/page-client";
import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { MedicationListLayout } from "@/lib/medication-list-layout";

function createDueMed(id: string, name: string, category: string) {
  return {
    id,
    name,
    dose: "1 tablet",
    category,
    active: true,
    asNeeded: false,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    nextDueAt: "2026-07-24T08:00:00.000Z",
    nextDueOverdue: true,
    stockDosesRemaining: null,
    schedules: [
      {
        id: `s-${id}`,
        windowStart: "08:00",
        windowEnd: "09:00",
        label: null,
        daysOfWeek: null,
        dose: "1 tablet",
      },
    ],
  };
}

function renderPage(meds: readonly ReturnType<typeof createDueMed>[]): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  const layout: MedicationListLayout = {
    version: 1,
    view: "cards",
    order: [],
    groupBy: "none",
  };
  client.setQueryData(queryKeys.medications(), meds);
  client.setQueryData(queryKeys.medicationListLayout(), layout);
  client.setQueryData(queryKeys.medicationCategories(), { categories: [] });
  client.setQueryData(
    queryKeys.medicationComplianceSummary(),
    meds.map((med) => ({
      medicationId: med.id,
      applicable: true,
      complianceDisplay: {
        shortDays: 7,
        longDays: 30,
        short: { rate: 100, streak: 5 },
        long: { rate: 100, streak: 20 },
        // A resolved dose past its catch-up band: missed keeps its state at
        // any clock, so the due set does not depend on when the test runs.
        currentDose: {
          status: "missed",
          state: "missed",
          targetAt: "2026-07-24T08:00:00.000Z",
          dueAt: "2026-07-24T07:00:00.000Z",
          overdueSince: "2026-07-24T09:00:00.000Z",
          missedAfter: "2026-07-24T12:00:00.000Z",
        },
      },
    })),
  );

  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <MedicationsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("/medications — filter rail on the page", () => {
  beforeEach(() => {
    mockAuthLoading = false;
    mockIsAuthenticated = true;
  });

  it("renders the filter rail and every medication when no filter is set", () => {
    const html = renderPage([
      createDueMed("m1", "Aspirin Protect", "PAIN"),
      createDueMed("m2", "Ramipril HCT", "HEART"),
    ]);
    expect(html).toContain('data-slot="medication-filter-rail"');
    expect(html).toContain("Aspirin Protect");
    expect(html).toContain("Ramipril HCT");
    expect(html).toContain("Take all due");
  });

  it("shows the empty cabinet state, without the filter rail, when there are no medications", () => {
    const html = renderPage([]);
    expect(html).not.toContain('data-slot="medication-filter-rail"');
    expect(html).toContain("No medications yet");
  });

  it("renders through loading -> authenticated states", () => {
    const meds = [createDueMed("m1", "Aspirin Protect", "PAIN")];

    mockAuthLoading = true;
    mockIsAuthenticated = false;
    const htmlLoading = renderPage(meds);
    expect(htmlLoading).toContain("animate-spin");
    expect(htmlLoading).not.toContain("Aspirin Protect");

    mockAuthLoading = false;
    mockIsAuthenticated = true;
    expect(renderPage(meds)).toContain("Aspirin Protect");
  });
});
