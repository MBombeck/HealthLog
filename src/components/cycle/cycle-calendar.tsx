"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";
import type { CalendarDay } from "./types";
import {
  FERTILE_HUE,
  FLOW_HUE,
  INTERCOURSE_HUE,
  OVULATION_HUE,
  flowOpacity,
} from "./phase-tokens";

/**
 * v1.15.0 — the month calendar.
 *
 * Renders one month at a time over the calendar read's day grid. Logged
 * period days carry a filled rose pip; the predicted next period renders as
 * a ranged BAND (a soft rose underline spanning the predicted days, never a
 * single dated dot); the fertile window (already goal-gated server-side — the
 * API nulls it unless TRYING_TO_CONCEIVE) renders as a green ring; the
 * predicted-ovulation day gets an amber marker; per-day symptom presence
 * shows a small dot; intercourse shows a diamond; anything else logged that
 * day (a test, contraception, spotting, a temperature, a mucus or cervix
 * reading, a note) shows a hollow ring, so a day with only one of those
 * logged no longer looks like a day with nothing logged. Selecting a day
 * calls `onSelectDay` (the log-day sheet).
 *
 * a11y: each day is a real `<button>` with an aria-label restating the date
 * + its markers; the colour markers are paired with the aria text so the
 * grid is never colour-only. WCAG 2.5.5 — each cell is ≥ 40 px.
 */

/**
 * Monday-first short weekday labels, localized via Intl (no i18n key).
 *
 * Takes the APP locale explicitly. It used to pass `undefined`, which resolves
 * to the browser's locale — invisible whenever the two agree, and wrong for
 * every user who reads the app in a language their browser is not set to.
 */
function shortWeekdays(locale: Locale): string[] {
  const fmt = new Intl.DateTimeFormat(resolveIntlLocale(locale), {
    weekday: "short",
  });
  // 2024-01-01 is a Monday — walk 7 days for a Monday-first header row.
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2024, 0, 1 + i)),
  );
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** 0=Mon … 6=Sun (Monday-first grid). */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

type Translate = ReturnType<typeof useTranslations>["t"];

/** `LABEL (VALUE)`, or the bare label when there is no value to name. */
function named(t: Translate, labelKey: string, valueKey?: string): string {
  return valueKey ? `${t(labelKey)} (${t(valueKey)})` : t(labelKey);
}

/**
 * The entries a day holds beyond flow, symptoms, intercourse and the
 * predictions, each spelled out for the cell's aria-label. Empty means the
 * other-entries ring stays off. Every field here is one the day log can hold
 * and the grid has no marker of its own for.
 */
export function otherEntryLabels(day: CalendarDay, t: Translate): string[] {
  const out: string[] = [];
  if (day.intermenstrualBleeding)
    out.push(t("cycle.sheet.intermenstrualBleeding"));
  if (day.basalBodyTempC != null) out.push(t("cycle.sheet.temperature"));
  if (day.ovulationTest)
    out.push(
      named(
        t,
        "cycle.sheet.ovulationTest",
        `cycle.ovulationTest.${day.ovulationTest}`,
      ),
    );
  if (day.cervicalMucus)
    out.push(named(t, "cycle.sheet.mucus", `cycle.mucus.${day.cervicalMucus}`));
  if (day.cervixPosition || day.cervixFirmness || day.cervixOpening)
    out.push(t("cycle.sheet.cervix"));
  if (day.pregnancyTest)
    out.push(
      named(
        t,
        "cycle.sheet.pregnancyTest",
        `cycle.testResult.${day.pregnancyTest}`,
      ),
    );
  if (day.progesteroneTest)
    out.push(
      named(
        t,
        "cycle.sheet.progesteroneTest",
        `cycle.testResult.${day.progesteroneTest}`,
      ),
    );
  if (day.contraceptive)
    out.push(
      named(
        t,
        "cycle.sheet.contraceptive",
        `cycle.contraceptive.${day.contraceptive}`,
      ),
    );
  if (day.hasNote) out.push(t("cycle.sheet.note"));
  return out;
}

export interface CycleCalendarProps {
  days: CalendarDay[];
  /** YYYY-MM-DD of today (server tz-anchored) for the "today" ring. */
  today: string;
  /**
   * YYYY-MM-DD of the CONFIRMED (retrospective) ovulation estimate, or null.
   * Set only when the prediction carries `ovulationConfirmed` — that day then
   * renders as the distinct light oval instead of the predicted dot.
   */
  confirmedOvulation?: string | null;
  /**
   * Open the day. Omitted inside somebody else's record: no grant level
   * admits a cycle write, so the cells stay readable and stop being controls
   * rather than opening a sheet whose every button the server would refuse.
   */
  onSelectDay?: (date: string) => void;
  /**
   * The month the grid moved to (`YYYY-MM`). The page's anchored read covers
   * a fixed span around today, so a month outside it arrives with no days —
   * the caller uses this to fetch that month rather than render empty cells
   * over entries that exist.
   */
  onVisibleMonthChange?: (month: string) => void;
  className?: string;
}

export function CycleCalendar({
  days,
  today,
  confirmedOvulation,
  onSelectDay,
  onVisibleMonthChange,
  className,
}: CycleCalendarProps) {
  const { t, locale } = useTranslations();
  const weekdays = useMemo(() => shortWeekdays(locale), [locale]);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);

  // Anchor the visible month on today's month.
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return new Date(y, m - 1, 1);
  });

  const grid = useMemo(() => {
    const first = new Date(
      monthAnchor.getFullYear(),
      monthAnchor.getMonth(),
      1,
    );
    const lead = mondayIndex(first);
    const daysInMonth = new Date(
      monthAnchor.getFullYear(),
      monthAnchor.getMonth() + 1,
      0,
    ).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push(
        new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), day),
      );
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [monthAnchor]);

  const monthLabel = monthAnchor.toLocaleDateString(resolveIntlLocale(locale), {
    month: "long",
    year: "numeric",
  });

  function shiftMonth(delta: number) {
    const next = new Date(
      monthAnchor.getFullYear(),
      monthAnchor.getMonth() + delta,
      1,
    );
    setMonthAnchor(next);
    // The page reads a window anchored on today, so a month outside it has no
    // days until somebody asks for them.
    onVisibleMonthChange?.(
      `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`,
    );
  }

  return (
    <div data-slot="cycle-calendar" className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("cycle.calendar.prevMonth")}
          onClick={() => shiftMonth(-1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-semibold capitalize">{monthLabel}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("cycle.calendar.nextMonth")}
          onClick={() => shiftMonth(1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div
        role="grid"
        aria-label={monthLabel}
        className="grid grid-cols-7 gap-1"
      >
        {weekdays.map((wk, i) => (
          <div
            key={i}
            role="columnheader"
            className="text-muted-foreground text-2xs pb-1 text-center font-medium uppercase"
          >
            {wk}
          </div>
        ))}

        {grid.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} aria-hidden="true" />;
          const date = ymd(cell);
          const info = byDate.get(date);
          const isToday = date === today;
          // A CONFIRMED-ovulation day is the predicted-ovulation day that also
          // matches the prediction's retrospective estimate. It supersedes the
          // predicted dot with the distinct light oval (Apple's idiom).
          const isConfirmedOvulation =
            !!info?.isPredictedOvulation &&
            confirmedOvulation != null &&
            date === confirmedOvulation;
          const isPredictedOvulationDot =
            !!info?.isPredictedOvulation && !isConfirmedOvulation;

          const markers: string[] = [];
          if (info?.isPeriodLogged) {
            // Restate the flow grade in the aria text so the shading is never
            // colour-only (the legend covers it; the cell names it too).
            const flowKey =
              info.flow && info.flow !== "NONE"
                ? `cycle.calendar.flow${info.flow.charAt(0)}${info.flow.slice(1).toLowerCase()}`
                : null;
            markers.push(
              flowKey
                ? `${t("cycle.calendar.legendPeriod")} (${t(flowKey)})`
                : t("cycle.calendar.legendPeriod"),
            );
          }
          if (info?.isPredictedPeriod)
            markers.push(t("cycle.calendar.legendPredicted"));
          if (info?.isFertileWindow)
            markers.push(t("cycle.calendar.legendFertile"));
          if (isConfirmedOvulation)
            markers.push(t("cycle.calendar.legendOvulationConfirmed"));
          else if (isPredictedOvulationDot)
            markers.push(t("cycle.calendar.legendOvulation"));
          if (info?.hasSymptoms)
            markers.push(t("cycle.calendar.legendSymptoms"));
          const hasIntercourse = !!info?.sexualActivity;
          if (hasIntercourse)
            markers.push(t("cycle.calendar.legendIntercourse"));
          const others = info ? otherEntryLabels(info, t) : [];
          markers.push(...others);

          const aria = `${date}${markers.length ? `, ${markers.join(", ")}` : ""}`;
          const flowLevel =
            info?.isPeriodLogged && info.flow && info.flow !== "NONE"
              ? info.flow
              : info?.isPeriodLogged
                ? "UNGRADED"
                : undefined;

          const content = (
            <>
              {/* Fertile window: a soft full-cell band (calm fill, not a hard
                  ring) so the window reads as a continuous range across days. */}
              {info?.isFertileWindow ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-0.5 rounded-md opacity-15"
                  style={{ backgroundColor: FERTILE_HUE }}
                />
              ) : null}

              {/* Logged-period filled pip behind the number — shaded by flow on
                  the single-hue opacity ladder (SPOTTING→HEAVY). */}
              {info?.isPeriodLogged ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-1 rounded-md"
                  style={{
                    backgroundColor: FLOW_HUE,
                    opacity: flowOpacity(info.flow),
                  }}
                />
              ) : null}

              {/* Confirmed-ovulation oval: a restrained light oval ringed in the
                  ovulatory hue, deliberately distinct from the predicted dot. */}
              {isConfirmedOvulation ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-1 inset-y-2 rounded-full ring-2 ring-inset"
                  style={
                    {
                      backgroundColor: OVULATION_HUE,
                      opacity: 0.22,
                      "--tw-ring-color": OVULATION_HUE,
                    } as React.CSSProperties
                  }
                />
              ) : null}

              <span className={cn("relative z-10", isToday && "text-primary")}>
                {cell.getDate()}
              </span>

              {/* Predicted-period day: a soft FILL behind the number (like a
                  logged period day, but lighter) with a dashed outline so it
                  still reads as predicted, not confirmed — replaces the old
                  hatched underline, which looked unfinished. */}
              {info?.isPredictedPeriod && !info?.isPeriodLogged ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-1 rounded-md border border-dashed"
                  style={{
                    backgroundColor: FLOW_HUE,
                    opacity: 0.3,
                    borderColor: FLOW_HUE,
                  }}
                />
              ) : null}

              {/* Marker row: predicted-ovulation + symptom dots. The confirmed
                  oval lives behind the number, so it needs no row dot. */}
              <span
                aria-hidden="true"
                className="relative z-10 mt-0.5 flex h-1.5 items-center gap-0.5"
              >
                {isPredictedOvulationDot ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: OVULATION_HUE }}
                  />
                ) : null}
                {info?.hasSymptoms ? (
                  <span className="bg-muted-foreground/70 h-1 w-1 rounded-full" />
                ) : null}
                {hasIntercourse ? (
                  <span
                    data-slot="cycle-calendar-intercourse"
                    className="size-1.5 rotate-45 rounded-xs"
                    style={{ backgroundColor: INTERCOURSE_HUE }}
                  />
                ) : null}
                {others.length > 0 ? (
                  <span
                    data-slot="cycle-calendar-other"
                    className="border-muted-foreground size-1.5 rounded-full border"
                  />
                ) : null}
              </span>
            </>
          );

          const cellClass = cn(
            "relative flex aspect-square min-h-11 flex-col items-center justify-center rounded-lg text-sm transition-colors",
            isToday && "font-semibold",
          );
          const cellAttrs = {
            role: "gridcell" as const,
            "aria-label": aria,
            "aria-current": isToday ? ("date" as const) : undefined,
            "data-flow-level": flowLevel,
            "data-fertile": info?.isFertileWindow ? "true" : undefined,
            "data-predicted":
              info?.isPredictedPeriod && !info?.isPeriodLogged
                ? "true"
                : undefined,
            "data-ovulation": isConfirmedOvulation
              ? "confirmed"
              : isPredictedOvulationDot
                ? "predicted"
                : undefined,
            "data-intercourse": hasIntercourse ? "true" : undefined,
            "data-other-entries": others.length > 0 ? "true" : undefined,
          };

          return onSelectDay ? (
            <button
              key={date}
              type="button"
              {...cellAttrs}
              onClick={() => onSelectDay(date)}
              className={cn(
                cellClass,
                "hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
              )}
            >
              {content}
            </button>
          ) : (
            <div key={date} {...cellAttrs} className={cellClass}>
              {content}
            </div>
          );
        })}
      </div>

      <CalendarLegend />
    </div>
  );
}

function CalendarLegend() {
  const { t } = useTranslations();
  // Each swatch mirrors its grid affordance: period = filled, predicted =
  // dashed, fertile = a soft band fill, predicted-ovulation = a filled dot,
  // confirmed-ovulation = a ringed light oval (distinct from the dot), symptom
  // = the small grey marker dot the grid draws (QA M4), intercourse = the
  // diamond, other entries = the hollow ring.
  const items: {
    hue: string;
    labelKey: string;
    variant:
      | "fill"
      | "dashed"
      | "band"
      | "oval"
      | "dot"
      | "smallDot"
      | "diamond"
      | "ring";
  }[] = [
    { hue: FLOW_HUE, labelKey: "cycle.calendar.legendPeriod", variant: "fill" },
    {
      hue: FLOW_HUE,
      labelKey: "cycle.calendar.legendPredicted",
      variant: "dashed",
    },
    {
      hue: FERTILE_HUE,
      labelKey: "cycle.calendar.legendFertile",
      variant: "band",
    },
    {
      hue: OVULATION_HUE,
      labelKey: "cycle.calendar.legendOvulation",
      variant: "dot",
    },
    {
      hue: OVULATION_HUE,
      labelKey: "cycle.calendar.legendOvulationConfirmed",
      variant: "oval",
    },
    {
      hue: "var(--muted-foreground)",
      labelKey: "cycle.calendar.legendSymptom",
      variant: "smallDot",
    },
    {
      hue: INTERCOURSE_HUE,
      labelKey: "cycle.calendar.legendIntercourse",
      variant: "diamond",
    },
    {
      hue: "var(--muted-foreground)",
      labelKey: "cycle.calendar.legendOtherEntries",
      variant: "ring",
    },
  ];
  return (
    <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {items.map((it) => (
        <li
          key={it.labelKey}
          data-legend={it.labelKey}
          className="flex items-center gap-1.5"
        >
          <span
            aria-hidden="true"
            className={cn(
              it.variant === "oval" &&
                "h-2.5 w-3.5 rounded-full ring-[1.5px] ring-inset",
              (it.variant === "fill" ||
                it.variant === "dashed" ||
                it.variant === "band" ||
                it.variant === "dot") &&
                "h-2.5 w-2.5 rounded-full",
              it.variant === "smallDot" && "h-1 w-1 rounded-full",
              it.variant === "diamond" && "mx-0.5 size-2 rotate-45 rounded-xs",
              it.variant === "ring" && "size-2 rounded-full border",
              it.variant === "dashed" && "opacity-60",
              it.variant === "band" && "opacity-30",
            )}
            style={
              it.variant === "oval"
                ? ({
                    backgroundColor: it.hue,
                    opacity: 0.3,
                    "--tw-ring-color": it.hue,
                  } as React.CSSProperties)
                : it.variant === "ring"
                  ? { borderColor: it.hue }
                  : { backgroundColor: it.hue }
            }
          />
          {t(it.labelKey)}
        </li>
      ))}
    </ul>
  );
}
