/**
 * The one loader for the rows a cycle forecast reads.
 *
 * The calendar read, the Coach and MCP cycle block and the calendar feed all
 * run the same engine over the same three inputs — the record's cycles, its
 * day logs and its overnight wrist temperatures — and they only agree with
 * each other when they read the same rows. The day-log window is the part that
 * matters: `estimatePeriodLength` falls back to the logged flow days when a
 * cycle carries no `periodEndDate`, so a reader with a wider window can predict
 * a different period length than one with a narrower window. Every consumer
 * therefore states its window here, and the ones that claim to agree with the
 * calendar pass the calendar's default.
 *
 * Server-only. No consumer recomputes any of this on a client.
 */
import { prisma } from "@/lib/db";
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import { BBT_WINDOW, type NightlyTempInput } from "@/lib/cycle/types";
import { resolveSensitiveFields } from "@/lib/cycle/dto";
import type {
  CalendarDayLogRow,
  CycleEngineInputs,
} from "@/lib/cycle/engine-adapter";
import { moodDateKey } from "@/lib/mood/date-key";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import type { MenstrualCycle } from "@/generated/prisma/client";

/** How far back the calendar shows by default, and its day-log window. */
export const CALENDAR_DEFAULT_PAST_DAYS = 90;

/** How far back the overnight wrist temperatures are read. */
const NIGHTS_LOOKBACK_DAYS = 90;

/**
 * The earliest day log a calendar view starting at `from` needs: the view
 * itself, or the symptothermal lookback before today, whichever is earlier.
 */
export function dayLogWindowStart(from: string, today: string): string {
  const lookback = addDays(today, -BBT_WINDOW);
  return dayDiff(from, lookback) <= 0 ? from : lookback;
}

/**
 * The day-log window of the calendar's default view. A consumer that promises
 * to agree with what the calendar page shows reads exactly this.
 */
export function defaultCalendarDayLogStart(today: string): string {
  return dayLogWindowStart(addDays(today, -CALENDAR_DEFAULT_PAST_DAYS), today);
}

interface LoadWindow {
  userId: string;
  /** Today in the record's own timezone. */
  today: string;
  /** The record's timezone. */
  tz: string;
  /** The earliest day log to read, inclusive. */
  dayLogsFrom: string;
}

/** Every live cycle of the record, oldest first. */
function loadCycles(userId: string): Promise<MenstrualCycle[]> {
  return prisma.menstrualCycle.findMany({
    where: { userId, deletedAt: null },
    orderBy: { startDate: "asc" },
  });
}

/**
 * The record's overnight wrist temperatures as nightly values. A measurements
 * read on a cycle surface, and it needs no section predicate for one reason:
 * no value from it reaches any response. It goes into `predictCycle` and what
 * comes out is a shifted date.
 */
async function loadNights(
  userId: string,
  today: string,
  tz: string,
): Promise<NightlyTempInput[]> {
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      deletedAt: null,
      type: "WRIST_TEMPERATURE",
      measuredAt: {
        gte: startOfLocalDayKey(addDays(today, -NIGHTS_LOOKBACK_DAYS), tz),
      },
    },
    orderBy: { measuredAt: "asc" },
    select: { measuredAt: true, value: true },
  });
  return rows.map((m) => ({
    date: moodDateKey(m.measuredAt, tz),
    valueC: m.value,
  }));
}

/** The engine's own day-log fields, nothing the forecast does not read. */
const ENGINE_DAY_LOG_SELECT = {
  date: true,
  flow: true,
  basalBodyTempC: true,
  temperatureExcluded: true,
  ovulationTest: true,
  cervicalMucus: true,
  cervixPosition: true,
  cervixFirmness: true,
  cervixOpening: true,
} as const;

/** The engine inputs, with the full cycle rows for callers that need them. */
export interface LoadedEngineInputs extends CycleEngineInputs {
  cycles: MenstrualCycle[];
}

/**
 * The forecast's inputs and nothing else. The intent fields, notes and
 * symptoms are not selected at all, so a consumer built on this loader cannot
 * reach them even by mistake.
 */
export async function loadCycleEngineInputs(
  window: LoadWindow,
): Promise<LoadedEngineInputs> {
  const [cycles, dayLogs, nights] = await Promise.all([
    loadCycles(window.userId),
    prisma.cycleDayLog.findMany({
      where: {
        userId: window.userId,
        deletedAt: null,
        date: { gte: window.dayLogsFrom },
      },
      orderBy: { date: "asc" },
      select: ENGINE_DAY_LOG_SELECT,
    }),
    loadNights(window.userId, window.today, window.tz),
  ]);
  return { cycles, dayLogs, nights };
}

/** The calendar grid's inputs: the engine's, plus what each day cell shows. */
export interface LoadedCalendarInputs {
  cycles: MenstrualCycle[];
  dayLogs: CalendarDayLogRow[];
  nights: NightlyTempInput[];
}

/**
 * The calendar read's inputs. Same cycles, same window rule and same nights
 * as {@link loadCycleEngineInputs}; the day logs additionally carry the
 * fields the grid paints, the intent fields resolved through the same reader
 * the day-log route uses (same `cycle` grant, so the grid shows a delegate
 * nothing the day log would not).
 */
export async function loadCalendarInputs(
  window: LoadWindow,
): Promise<LoadedCalendarInputs> {
  const [cycles, dayLogRows, nights] = await Promise.all([
    loadCycles(window.userId),
    prisma.cycleDayLog.findMany({
      where: {
        userId: window.userId,
        deletedAt: null,
        date: { gte: window.dayLogsFrom },
      },
      orderBy: { date: "asc" },
      select: {
        ...ENGINE_DAY_LOG_SELECT,
        intermenstrualBleeding: true,
        sexualActivity: true,
        protectedSex: true,
        pregnancyTest: true,
        progesteroneTest: true,
        contraceptive: true,
        sensitiveEncrypted: true,
        // Selected for presence only; the text is never decrypted here.
        notesEncrypted: true,
        _count: { select: { symptomLinks: true } },
      },
    }),
    loadNights(window.userId, window.today, window.tz),
  ]);

  const dayLogs: CalendarDayLogRow[] = dayLogRows.map((l) => {
    const sensitive = resolveSensitiveFields(l);
    return {
      date: l.date,
      flow: l.flow,
      basalBodyTempC: l.basalBodyTempC,
      temperatureExcluded: l.temperatureExcluded,
      ovulationTest: l.ovulationTest,
      cervicalMucus: l.cervicalMucus,
      cervixPosition: l.cervixPosition,
      cervixFirmness: l.cervixFirmness,
      cervixOpening: l.cervixOpening,
      intermenstrualBleeding: l.intermenstrualBleeding,
      sexualActivity: sensitive.sexualActivity,
      pregnancyTest: sensitive.pregnancyTest,
      progesteroneTest: sensitive.progesteroneTest,
      contraceptive: sensitive.contraceptive,
      hasSymptoms: l._count.symptomLinks > 0,
      hasNote: l.notesEncrypted != null && l.notesEncrypted !== "",
    };
  });

  return { cycles, dayLogs, nights };
}

/**
 * The flow of every day log on or after `from`, for the history events of the
 * calendar feed: a logged period without a `periodEndDate` is drawn from its
 * observed bleeding days. Never fed to the forecast, which keeps its own
 * window.
 */
export function loadFlowDays(
  userId: string,
  from: string,
): Promise<Array<{ date: string; flow: CalendarDayLogRow["flow"] }>> {
  return prisma.cycleDayLog.findMany({
    where: { userId, deletedAt: null, date: { gte: from } },
    orderBy: { date: "asc" },
    select: { date: true, flow: true },
  });
}
