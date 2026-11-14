import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// The reminder-thresholds read: `undefined` = not loaded (the 120 / 240
// defaults apply), otherwise the account's own tiers.
let mockThresholds:
  | { lateMinutes: number; missedMinutes: number; lowStockRunwayDays: null }
  | undefined;

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: mockThresholds }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { username: "tester", timezone: "Europe/Berlin" },
  }),
}));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    open,
    children,
    footer,
  }: {
    open: boolean;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    open ? (
      <section>
        {children}
        {footer}
      </section>
    ) : null,
}));

import {
  LogIntakeDialog,
  type LogIntakeMedication,
} from "../log-intake-dialog";

function medication(
  id: string,
  overrides: Partial<LogIntakeMedication> = {},
): LogIntakeMedication {
  return {
    id,
    name: `Medication ${id}`,
    dose: "5 mg",
    active: true,
    intakeActionable: true,
    schedules: [],
    lastTakenAt: null,
    todayEventCount: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    ...overrides,
  };
}

function renderDialog(medications: LogIntakeMedication[]): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <LogIntakeDialog open onOpenChange={() => {}} medications={medications} />
    </I18nProvider>,
  );
}

function expectSelected(html: string, id: string): void {
  expect(html).toMatch(
    new RegExp(
      `<option(?=[^>]*value="${id}")(?=[^>]*selected)[^>]*>|<option(?=[^>]*selected)(?=[^>]*value="${id}")[^>]*>`,
    ),
  );
}

describe("<LogIntakeDialog> medication default", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    mockThresholds = undefined;
  });

  it("grades the due dose by the account's own missed threshold", () => {
    // 10:00 in Berlin, five hours after a 04:00–05:00 window closed. Under the
    // 240-minute default the dose is past missed and the alphabetical
    // fallback wins; an account that keeps a six-hour missed threshold still
    // sees it as very late, so it is the default.
    const meds = [
      medication("first", { name: "Alpha" }),
      medication("late", {
        name: "Zulu",
        nextDueAt: undefined,
        schedules: [
          {
            windowStart: "04:00",
            windowEnd: "05:00",
            daysOfWeek: null,
            label: null,
            dose: null,
          },
        ],
      }),
    ];
    expectSelected(renderDialog(meds), "first");
    mockThresholds = {
      lateMinutes: 120,
      missedMinutes: 360,
      lowStockRunwayDays: null,
    };
    expectSelected(renderDialog(meds), "late");
  });
  it("selects an overdue current-window medication ahead of array order", () => {
    const html = renderDialog([
      medication("first", { name: "Alpha" }),
      medication("overdue", {
        name: "Zulu",
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "09:00",
            daysOfWeek: null,
            label: null,
            dose: null,
          },
        ],
        nextDueAt: "2026-05-12T06:00:00.000Z",
        nextDueOverdue: true,
      }),
    ]);

    expectSelected(html, "overdue");
  });

  it("uses a stable alphabetical fallback instead of array order for future doses", () => {
    const html = renderDialog([
      medication("z", {
        name: "Zolpidem",
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "11:00",
            daysOfWeek: null,
            label: null,
            dose: null,
          },
        ],
        nextDueAt: "2099-05-13T07:00:00.000Z",
        nextDueOverdue: false,
      }),
      medication("r", { name: "Ramipril" }),
    ]);

    expectSelected(html, "r");
  });
});

describe("<LogIntakeDialog> the medication's own note (#1371)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the picked medication's note under the picker", () => {
    const html = renderDialog([
      medication("a", { note: "30 to 60 minutes before food" }),
    ]);
    expect(html).toContain('data-slot="log-intake-note"');
    expect(html).toContain("30 to 60 minutes before food");
  });

  it("shows no note line for a medication without one", () => {
    const html = renderDialog([medication("a", { note: null })]);
    expect(html).not.toContain("log-intake-note");
  });

  it("shows the note of the medication that is picked, not another's", () => {
    const html = renderDialog([
      medication("a", { name: "Alpha", note: "Alpha note" }),
      medication("b", { name: "Beta", note: "Beta note" }),
    ]);
    expect(html).toContain("Alpha note");
    expect(html).not.toContain("Beta note");
  });
});
