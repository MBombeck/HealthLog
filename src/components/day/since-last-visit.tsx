"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircleDashed,
  FileText,
  FlaskConical,
  Pill,
  ShieldAlert,
  Stethoscope,
  Syringe,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { EncounterDTO } from "@/lib/encounters/dto";
import { apiGet } from "@/lib/api/api-fetch";
import type {
  DateKey,
  DayEventKind,
  DayNotable,
  DayNotableWindowResponse,
} from "@/lib/day/contract";
import {
  useDisplayTimezone,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { getUnitForType } from "@/lib/measurements/unit-map";
import { queryKeys } from "@/lib/query-keys";

import { DAY_SECTION_LABEL, useNotableText } from "./day-sections";
import { DayLink } from "./day-link";
import { dateKeyOfInstant } from "./day-url";
import { tileKeyOf } from "./day-values-model";
import { useDayValueFormat } from "./use-day-value-format";
import { useTodayKey } from "./use-today-key";

/**
 * "Since the last visit": the preparation the next planned appointment
 * otherwise lacks. Dose changes, episodes that began, new results, extreme
 * readings and gaps between the last visit and today, each dated, each date
 * opening its day. Compiled from the record without any judgement; the
 * wording is the day view's own.
 *
 * One read, `GET /api/day/notable` for the window from the last visit to
 * today: the server lists every context change in it (a dose change always,
 * however quiet the day around it) and every notable observation. Nothing is
 * recomputed here; this only spells the rows.
 */

const EVENT_ICON: Partial<Record<DayEventKind, LucideIcon>> = {
  doseChange: Pill,
  medicationStart: Pill,
  medicationEnd: Pill,
  pauseStart: Pill,
  courseStart: Pill,
  illnessOnset: Thermometer,
  allergyOnset: ShieldAlert,
  labResult: FlaskConical,
  procedure: Stethoscope,
  vaccination: Syringe,
};

/** Rows shown before "All". */
export const VISIBLE_ROWS = 5;

export interface PrepRow {
  key: string;
  date: DateKey;
  Icon: LucideIcon;
  title: string;
  meta: string | null;
}

/**
 * The window's rows, oldest first: each context change as the server named
 * it, each notable observation spelled by the caller. A first reading of a
 * kind is left out here (it says nothing about the stretch since the visit).
 */
export function preparationRows(
  window: Pick<DayNotableWindowResponse, "observations" | "changes">,
  spell: {
    notableTitle: (notable: DayNotable) => string;
    notableText: (notable: DayNotable) => string | null;
    countMeta: (count: number) => string | null;
  },
): PrepRow[] {
  const rows: PrepRow[] = [];
  for (const change of window.changes) {
    rows.push({
      key: `${change.kind}-${change.id}-${change.date}`,
      date: change.date,
      Icon: EVENT_ICON[change.kind] ?? FileText,
      title: change.title,
      meta: spell.countMeta(change.count),
    });
  }
  for (const notable of window.observations) {
    if (notable.kind === "firstValue") continue;
    rows.push({
      key: `notable-${notable.date}-${notable.kind}-${notable.type ?? ""}`,
      date: notable.date,
      Icon: notable.kind === "gap" ? CircleDashed : Activity,
      title: spell.notableTitle(notable),
      meta: spell.notableText(notable),
    });
  }
  // A stable sort: the server's order holds within a day.
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function SinceLastVisit({
  next,
  last,
}: {
  /** The next planned visit, the one this prepares. */
  next: EncounterDTO;
  /** The last visit that took place. */
  last: EncounterDTO;
}) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();
  const timeZone = useDisplayTimezone();
  const today = useTodayKey();
  const { labelFor, formatTile } = useDayValueFormat();
  const notableText = useNotableText();
  const [showAll, setShowAll] = useState(false);

  const lastDay = dateKeyOfInstant(last.occurredAt, timeZone);
  // From the last visit's own day (a dose changed at the visit belongs to
  // what the next one should know) to today. The server caps the span.
  const window = useQuery({
    queryKey: queryKeys.dayNotable(lastDay, today),
    queryFn: () => {
      const params = new URLSearchParams({ from: lastDay, to: today });
      return apiGet<DayNotableWindowResponse>(`/api/day/notable?${params}`);
    },
    enabled: lastDay <= today,
    staleTime: 5 * 60_000,
  });

  // "Blood pressure 152/94 mmHg": the reading a notable day is about, in the
  // day view's own spelling.
  const notableTitle = (notable: DayNotable): string => {
    if (!notable.type) return "";
    const label = labelFor(tileKeyOf(notable.type));
    const value = notable.params.value;
    if (typeof value !== "number") return label;
    const shown = formatTile({
      key: tileKeyOf(notable.type),
      values: [
        {
          type: notable.type,
          value,
          unit: getUnitForType(notable.type),
          at: "",
          source: "",
          band: null,
        },
      ],
    });
    return `${label} ${shown.value}${shown.unit ? ` ${shown.unit}` : ""}`;
  };

  const rows = window.data
    ? preparationRows(window.data, {
        notableTitle,
        notableText,
        countMeta: (count) =>
          count > 1 ? tCount("day.countEntries", count) : null,
      })
    : [];

  const loading = window.isPending && window.fetchStatus !== "idle";
  const failed = window.isError;
  if (!loading && !failed && rows.length === 0) return null;
  // A preparation that could not be read is left out rather than shown half:
  // the visit card stands on its own, and the day links stay everywhere else.
  if (failed && rows.length === 0) return null;

  const visible = showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  const lastLabel = fmt.dateShortSmartCalendar(lastDay);
  const nextDay = dateKeyOfInstant(next.occurredAt, timeZone);

  return (
    <section
      data-slot="since-last-visit"
      aria-labelledby={`since-last-visit-${next.id}`}
      className="space-y-2"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`since-last-visit-${next.id}`} className={DAY_SECTION_LABEL}>
          {t("day.sinceLastVisit.title", { date: lastLabel })}
        </h3>
        {rows.length > 0 ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            {tCount("day.sinceLastVisit.count", rows.length)}
          </span>
        ) : null}
      </div>
      {loading && rows.length === 0 ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : (
        <ul className="border-border divide-border divide-y rounded-lg border px-3.5">
          {visible.map((row) => (
            <li
              key={row.key}
              data-slot="since-last-visit-row"
              className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 py-2.5 sm:grid-cols-[7.5rem_1.25rem_minmax(0,1fr)]"
            >
              <span className="col-start-2 text-sm sm:col-start-1 sm:row-start-1">
                <DayLink date={row.date}>
                  {fmt.dateShortSmartCalendar(row.date)}
                </DayLink>
              </span>
              <row.Icon
                className="text-muted-foreground row-span-2 mt-0.5 size-4 sm:row-span-1 sm:row-start-1"
                aria-hidden="true"
              />
              <div className="col-start-2 min-w-0 sm:col-start-3 sm:row-start-1">
                {row.title ? <p className="text-sm">{row.title}</p> : null}
                {row.meta ? (
                  <p className="text-muted-foreground text-xs">{row.meta}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > VISIBLE_ROWS ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="focus-visible:ring-ring/50 min-h-11 rounded-md text-sm font-medium focus-visible:ring-[3px] focus-visible:outline-none sm:min-h-9"
        >
          {showAll
            ? t("day.sinceLastVisit.fewer")
            : tCount("day.sinceLastVisit.all", rows.length)}
        </button>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {t("day.sinceLastVisit.note")}
      </p>
      <Button
        asChild
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-9"
      >
        <Link
          href={`/settings/gesundheitsakte?reportFrom=${lastDay}&reportTo=${nextDay < today ? nextDay : today}`}
          data-slot="since-last-visit-report"
        >
          <FileText className="size-4" aria-hidden="true" />
          {t("day.sinceLastVisit.report", { date: lastLabel })}
        </Link>
      </Button>
    </section>
  );
}
