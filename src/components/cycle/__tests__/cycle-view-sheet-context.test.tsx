/**
 * The log sheet speaks about the date it opened on, not about today (#1004).
 *
 * It used to take its header count and its "period ended" button from the
 * verdict, which is the server's answer about TODAY. A January date opened
 * in September therefore read "Day 2", and a back-dated period could not be
 * closed unless today happened to be a bleeding day. The fixture below makes
 * the two sources disagree on purpose: the verdict says day 2 of a period,
 * the grid day for the open date says day 20 with no period end possible.
 * The sheet must follow the grid.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { CalendarDay } from "../types";

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

const TODAY = "2026-07-01";

function gridDay(date: string, over: Partial<CalendarDay> = {}): CalendarDay {
  return {
    date,
    phase: null,
    isPredictedPeriod: false,
    isFertileWindow: false,
    isPredictedOvulation: false,
    isPeriodLogged: false,
    isCycleStart: false,
    cycleDay: null,
    periodEndable: false,
    flow: null,
    hasSymptoms: false,
    confidence: 0,
    basalBodyTempC: null,
    ovulationTest: null,
    cervicalMucus: null,
    cervixPosition: null,
    cervixFirmness: null,
    cervixOpening: null,
    intermenstrualBleeding: false,
    sexualActivity: false,
    pregnancyTest: null,
    progesteroneTest: null,
    contraceptive: null,
    hasNote: false,
    ...over,
  };
}

const calendarQuery = {
  data: {
    profile: {
      goal: "GENERAL_HEALTH",
      rawChartMode: false,
      predictionEnabled: true,
      cyclesObserved: 4,
    },
    prediction: null,
    verdict: {
      state: "IN_CYCLE",
      dayOfCycle: 2,
      cycleLength: 28,
      phase: "MENSTRUAL",
      spans: [],
      cycleStartDate: "2026-06-30",
      overdueDays: null,
      daysUntilNext: null,
      fertileWindow: { start: null, end: null, active: false },
    },
    stillLearning: false,
    days: [gridDay(TODAY, { cycleDay: 20, phase: "LUTEAL" })],
    meta: { generatedAt: "2026-07-01T00:00:00Z" },
  },
  isError: false,
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
  localYmd: () => TODAY,
  useCycleCalendar: () => calendarQuery,
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

const sheetProps: Record<string, unknown>[] = [];
vi.mock("../log-day-sheet", async (importActual) => {
  const actual = await importActual<typeof import("../log-day-sheet")>();
  return {
    ...actual,
    LogDaySheet: (props: Record<string, unknown>) => {
      sheetProps.push(props);
      return null;
    },
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { CycleView } from "../cycle-view";

describe("<CycleView> — the log sheet describes the date it opened on", () => {
  it("feeds the sheet the grid day's count and period-end answer, not today's verdict", () => {
    sheetProps.length = 0;
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CycleView />
      </I18nProvider>,
    );
    const props = sheetProps.at(-1);
    expect(props).toBeDefined();
    expect(props?.date).toBe(TODAY);
    expect(props?.dayOfCycle).toBe(20);
    expect(props?.phase).toBe("LUTEAL");
    expect(props?.periodEndable).toBe(false);
  });
});
