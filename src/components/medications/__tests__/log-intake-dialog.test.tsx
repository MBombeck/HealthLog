import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
