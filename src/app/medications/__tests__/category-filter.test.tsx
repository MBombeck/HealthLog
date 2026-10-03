/**
 * v1.40 (#1041) — the category filter on /medications and the custom
 * category badge. The filter appears once the list spans two categories
 * (or the record has categories of its own), offers each category in use,
 * and the card badge shows a custom category's own label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { timezone: "Europe/Berlin" },
  }),
}));

// The create wizard and the dialogs are closed in every assertion here;
// mock them away so the page render stays scoped to the list surface.
vi.mock("@/components/medications/wizard/medication-wizard-dialog", () => ({
  MedicationWizardDialog: () => null,
}));
vi.mock("@/components/medications/log-intake-dialog", () => ({
  LogIntakeDialog: () => null,
}));

// v1.30.x — `@/app/medications/page` is now an async RSC prefetch wrapper; the
// interactive surface this test renders is the client leaf it wraps.
import MedicationsPage from "@/app/medications/page-client";
import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { MedicationListLayout } from "@/lib/medication-list-layout";

const pastWindow = {
  windowStart: "01:00",
  windowEnd: "02:00",
  label: null,
  daysOfWeek: null,
  dose: null,
};

const KEY = "custom:11111111-1111-4111-8111-111111111111";

function med(id: string, name: string, category: string, label?: string) {
  return {
    id,
    name,
    dose: "5 mg",
    category,
    categoryLabel: label ?? null,
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    stockDosesRemaining: null,
    schedules: [{ id: `s-${id}`, ...pastWindow }],
  };
}

function renderPage(
  meds: ReturnType<typeof med>[],
  customCategories: unknown[] = [],
): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  client.setQueryData(queryKeys.medications(), meds);
  client.setQueryData(queryKeys.medicationListLayout(), {
    version: 1,
    view: "cards",
    order: [],
  } satisfies MedicationListLayout);
  client.setQueryData(queryKeys.medicationCategories(), {
    categories: customCategories,
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <MedicationsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("/medications — category filter", () => {
  it("shows the filter once the list spans two categories, with the custom label on the card", () => {
    const html = renderPage([
      med("m1", "Levothyroxine", "THYROID"),
      med("m2", "Tamiflu", KEY, "Travel kit"),
    ]);
    expect(html).toContain('data-slot="filter-bar"');
    expect(html).toContain('data-slot="filter-bar-pill"');
    // The card badge reads the person's own label, not "Other".
    expect(html).toContain("Travel kit");
  });

  it("leaves the filter out when every medication shares one category and none are custom", () => {
    const html = renderPage([
      med("m1", "Levothyroxine", "THYROID"),
      med("m2", "Liothyronine", "THYROID"),
    ]);
    expect(html).not.toContain('data-slot="filter-bar"');
  });

  it("shows the filter, with its manage entry, when the record has categories of its own", () => {
    const html = renderPage(
      [med("m1", "Levothyroxine", "THYROID")],
      [
        {
          key: KEY,
          label: "Travel kit",
          sortOrder: 0,
          isActive: true,
          medicationCount: 0,
        },
      ],
    );
    expect(html).toContain('data-slot="filter-bar"');
    expect(html).toContain('data-slot="medication-categories-manage"');
  });
});
