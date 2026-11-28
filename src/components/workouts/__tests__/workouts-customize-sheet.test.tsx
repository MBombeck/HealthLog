/**
 * "Seite anpassen" on the workouts page: the groups stand in the template's
 * order, each row shows its current value, and a shared record gets no goal
 * editor. The sheet primitive is replaced by a plain frame so its body
 * renders without a portal.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { NO_ACTIVITY_GOALS } from "@/lib/validations/activity-goals";

const state = { shared: false };

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    title,
    children,
  }: {
    title: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div data-testid="sheet">
      <h2>{title}</h2>
      {children}
    </div>
  ),
}));
vi.mock("@/hooks/use-activity-calendar", () => ({
  useActivityCalendar: () => ({
    data: {
      available: {
        steps: true,
        activeMinutes: true,
        workouts: true,
        load: false,
      },
      goals: { ...NO_ACTIVITY_GOALS, workoutsPerWeek: 3, stepsPerWeek: 50000 },
      goalProgress: [],
    },
  }),
  useSaveActivityGoals: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-record-capabilities", async (importOriginal) => ({
  holdsOwnerRights: (
    await importOriginal<typeof import("@/hooks/use-record-capabilities")>()
  ).holdsOwnerRights,
  useRecordCapabilities: () => ({ inSharedRecord: state.shared }),
}));

const { WorkoutsCustomizeSheet } = await import("../workouts-customize-sheet");

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <WorkoutsCustomizeSheet
        open
        onOpenChange={() => {}}
        summary
        onSummaryChange={() => {}}
        measure="activeMinutes"
        onMeasureChange={() => {}}
        sources={["APPLE_HEALTH", "MANUAL"]}
      />
    </I18nProvider>,
  );
}

describe("WorkoutsCustomizeSheet", () => {
  it("lists display, capture and data in that order", () => {
    const html = render();
    const order = [...html.matchAll(/data-group="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["display", "capture", "data"]);
    expect(html).toContain("Customize page");
  });

  it("shows each row's current value", () => {
    const html = render();
    expect(html).toContain("Active minutes");
    expect(html).toContain("2 set");
    expect(html).toContain("Apple Health");
  });

  it("offers no goal editor and no import inside somebody else's record", () => {
    state.shared = true;
    const html = render();
    state.shared = false;
    expect(html).not.toContain('data-slot="activity-calendar-set-goals"');
    expect(html).not.toContain('data-slot="workouts-customize-import"');
    expect(html).toContain('data-slot="workouts-customize-export"');
  });
});
