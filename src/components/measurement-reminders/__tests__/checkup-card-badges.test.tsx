import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { MeasurementReminder } from "@/hooks/use-measurement-reminders";

/**
 * A checkup that is switched off, or that the Coach created, says so in the
 * card view. The list view used to drop both badges, so a disabled checkup
 * looked active there; which view a person sees is a remembered preference,
 * so the same checkup read differently depending on a toggle.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { VorsorgeCard } from "../checkups/checkup-card";

const reminder = {
  id: "coach-off",
  label: "Check blood pressure",
  measurementType: null,
  intervalDays: 30,
  rrule: null,
  anchorDate: null,
  endsOn: null,
  origin: "COACH",
  nextDueAt: null,
  notifyHour: 9,
  location: null,
  lastSatisfiedAt: null,
  enabled: false,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
} as MeasurementReminder;

function render(view: "cards" | "list"): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const noop = () => {};
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <VorsorgeCard
          reminder={reminder}
          now={Date.parse("2030-02-01T12:00:00.000Z")}
          view={view}
          onPrimaryAction={noop}
          onFileVisit={noop}
          onRemove={noop}
          onEdit={noop}
          onSkip={noop}
          onSnooze={noop}
          busy={false}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("checkup state badges", () => {
  it.each(["cards", "list"] as const)(
    "show the Coach and switched-off badges in the %s view",
    (view) => {
      const html = render(view);
      expect(html).toContain("Check blood pressure");
      expect(html).toContain(">Coach<");
      expect(html).toContain(">Off<");
    },
  );
});
