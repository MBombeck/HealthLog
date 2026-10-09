"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Activity,
  Brain,
  CalendarCheck,
  CalendarHeart,
  ChevronRight,
  FileText,
  FlaskConical,
  Flag,
  Footprints,
  PauseCircle,
  Pill,
  ShieldAlert,
  Smile,
  Sparkles,
  Stethoscope,
  Syringe,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import type {
  DayEvent,
  DayEventKind,
  DayNotable,
  DayRunningItem,
  DayRunningKind,
  DayValue,
} from "@/lib/day/contract";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import type { DayFocus } from "./day-layer-controller";
import {
  curateDayValues,
  numberLinePositions,
  tileKeyOf,
  type DayValueTile,
} from "./day-values-model";
import { useDayValueFormat } from "./use-day-value-format";

/**
 * The sections of one day: the value the person came from, what ran through
 * the day, the readings against the person's own usual range, and what
 * happened, in order of the clock.
 *
 * Every row that came from a record links to that record; the day is a place
 * to look from, and the entry is where it is edited.
 */

/** Section label, UI-STANDARDS §5. */
export const DAY_SECTION_LABEL =
  "text-muted-foreground text-xs font-medium tracking-wide uppercase";

/* ─── Focus ───────────────────────────────────────────────────────────── */

export function DayFocusCard({
  focus,
  usual,
}: {
  focus: DayFocus;
  /** The usual range of the focus type that day, when the server has one. */
  usual: string | null;
}) {
  const { t } = useTranslations();
  const compare =
    focus.compare ??
    (usual ? { label: t("day.usualLabel"), value: usual } : null);
  return (
    <div
      data-slot="day-focus"
      className="bg-muted/60 flex items-end justify-between gap-3 rounded-lg px-3.5 py-3"
    >
      <div className="min-w-0">
        <p className="text-muted-foreground truncate text-xs">{focus.label}</p>
        <p className="text-3xl font-semibold tracking-tight break-words tabular-nums">
          {focus.value}
          {focus.unit ? (
            <span className="text-muted-foreground ml-1 text-base font-medium whitespace-nowrap">
              {focus.unit}
            </span>
          ) : null}
        </p>
      </div>
      {compare ? (
        <div className="shrink-0 text-right" data-slot="day-focus-compare">
          <p className="text-muted-foreground text-xs">{compare.label}</p>
          <p className="text-sm font-medium tabular-nums">{compare.value}</p>
        </div>
      ) : null}
    </div>
  );
}

/* ─── Notable ─────────────────────────────────────────────────────────── */

/** Words a notable observation from the bundle, its date as month and year. */
export function useNotableText() {
  const { t, locale } = useTranslations();
  return (notable: DayNotable): string => {
    const params: Record<string, string | number> = { ...notable.params };
    const since = notable.params.since;
    if (typeof since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
      params.since = new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${since}T12:00:00.000Z`));
    }
    return t(`day.notable.${notable.kind}`, params);
  };
}

export function DayNotableLines({
  notables,
  labelFor,
  withMetric,
}: {
  notables: readonly DayNotable[];
  labelFor: (tileKey: string) => string;
  /** Name the metric in front; off under the focus card, which names it. */
  withMetric: boolean;
}) {
  const text = useNotableText();
  if (notables.length === 0) return null;
  return (
    <ul className="space-y-1.5" data-slot="day-notable">
      {notables.map((notable, i) => (
        <li
          key={`${notable.kind}-${notable.type ?? ""}-${i}`}
          className="text-muted-foreground flex items-start gap-2 text-xs"
        >
          <Sparkles className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {withMetric && notable.type
              ? `${labelFor(tileKeyOf(notable.type))} · `
              : null}
            {text(notable)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ─── Running ─────────────────────────────────────────────────────────── */

const RUNNING_COLOR: Record<DayRunningKind, string> = {
  medication: "var(--chart-1)",
  medicationCourse: "var(--chart-1)",
  medicationPause: "var(--muted-foreground)",
  illness: "var(--chart-5)",
  restMode: "var(--chart-5)",
  cyclePhase: "var(--chart-3)",
  travel: "var(--chart-4)",
  lifestyle: "var(--muted-foreground)",
  lifeEvent: "var(--chart-2)",
};

/**
 * The server names a few records by a sentinel rather than by text it would
 * have to translate: a cycle is titled "cycle", a trip "travel", a cycle
 * day carries its flow level. They are worded here, in the reader's
 * language; every other title is the record's own text. The record's kind
 * decides, not the title: a medication or a document the person named
 * "cycle" keeps its own name.
 */
export function dayTitle(
  kind: string,
  title: string,
  t: (key: string) => string,
): string {
  if (kind === "cyclePhase" || kind === "cycleDayLog") return t("nav.cycle");
  if (kind === "travel") return t("day.travel");
  return title;
}

const FLOW_LEVELS = new Set(["NONE", "SPOTTING", "LIGHT", "MEDIUM", "HEAVY"]);

function dayMeta(
  kind: string,
  meta: string,
  t: (key: string) => string,
): string {
  if (kind === "cycleDayLog" && FLOW_LEVELS.has(meta)) {
    return `${t("cycle.flow.label")}: ${t(`cycle.flow.${meta}`)}`;
  }
  return meta;
}

export function DayRunning({ items }: { items: readonly DayRunningItem[] }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (items.length === 0) return null;
  return (
    <section className="space-y-2" data-slot="day-running">
      <h3 className={DAY_SECTION_LABEL}>{t("day.groups.running")}</h3>
      <ul>
        {items.map((item) => {
          const parts = [
            item.sub,
            item.dayIndex !== null
              ? item.dayCount !== null
                ? t("day.dayOf", { n: item.dayIndex, m: item.dayCount })
                : t("day.dayN", { n: item.dayIndex })
              : null,
            item.dayCount === null
              ? t("day.since", {
                  date: fmt.dateShortSmartCalendar(item.since),
                })
              : null,
          ].filter((part): part is string => !!part);
          const body = (
            <>
              <span
                aria-hidden="true"
                className="w-[3px] shrink-0 self-stretch rounded-full"
                style={{ backgroundColor: RUNNING_COLOR[item.kind] }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {dayTitle(item.kind, item.title, t)}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {parts.join(" · ")}
                </span>
              </span>
              {item.href ? (
                <ChevronRight
                  className="text-muted-foreground size-4 shrink-0"
                  aria-hidden="true"
                />
              ) : null}
            </>
          );
          return (
            <li key={`${item.kind}-${item.id}`}>
              {item.href ? (
                <Link
                  href={item.href}
                  data-slot="day-running-item"
                  className="hover:bg-muted/60 focus-visible:ring-ring/50 -mx-2 flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  {body}
                </Link>
              ) : (
                <div
                  data-slot="day-running-item"
                  className="flex min-h-11 items-center gap-3 py-1.5"
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ─── Values ──────────────────────────────────────────────────────────── */

function NumberLine({
  value,
  band,
}: {
  value: number;
  band: { lo: number; hi: number };
}) {
  const pos = numberLinePositions(value, band);
  return (
    <div
      className="relative mt-1.5 h-2.5"
      aria-hidden="true"
      data-slot="day-number-line"
    >
      <span className="bg-border absolute inset-x-0 top-1 h-0.5 rounded-full" />
      <span
        className="bg-muted-foreground/45 absolute top-[3px] h-1 rounded-full"
        style={{
          left: `${pos.lo}%`,
          width: `${Math.max(pos.hi - pos.lo, 1)}%`,
        }}
      />
      <span
        className="bg-foreground ring-card absolute top-px -ml-1 size-2 rounded-full ring-2"
        style={{ left: `${pos.point}%` }}
      />
    </div>
  );
}

function ValueTile({
  tile,
  selected,
}: {
  tile: DayValueTile;
  selected: boolean;
}) {
  const { t, tCount } = useTranslations();
  const { formatTile } = useDayValueFormat();
  const shown = formatTile(tile);
  // The line plots the first row: systolic for a blood pressure.
  const lead = tile.values[0];
  return (
    <li
      data-slot="day-value"
      data-type={tile.key}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "bg-muted/60 flex min-w-0 flex-col rounded-lg px-3 py-2.5",
        selected && "ring-foreground ring-[1.5px] ring-inset",
      )}
    >
      <span className="text-muted-foreground truncate text-xs">
        {shown.label}
      </span>
      <span className="truncate text-base font-semibold tabular-nums">
        {shown.value}
        {shown.unit ? (
          <span className="text-muted-foreground ml-0.5 text-xs font-medium">
            {shown.unit}
          </span>
        ) : null}
      </span>
      {tile.readings > 1 ? (
        <span
          data-slot="day-value-mean"
          className="text-muted-foreground truncate text-xs"
        >
          {tCount("day.meanOfReadings", tile.readings)}
        </span>
      ) : null}
      {lead?.band ? (
        <>
          <NumberLine value={lead.value} band={lead.band} />
          {shown.usualParts ? (
            <span className="sr-only">
              {shown.usualParts
                .map((part) => t("day.usualRange", part))
                .join(", ")}
            </span>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export function DayValues({
  values,
  focusTypes,
}: {
  values: readonly DayValue[];
  focusTypes: readonly string[];
}) {
  const { t, tCount } = useTranslations();
  const [expanded, setExpanded] = useState(false);
  if (values.length === 0) return null;
  const { curated, rest } = curateDayValues(values, focusTypes);
  const focusKeys = new Set(focusTypes.map(tileKeyOf));
  const tiles = expanded ? [...curated, ...rest] : curated;
  const total = curated.length + rest.length;
  return (
    <section className="space-y-2" data-slot="day-values">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={DAY_SECTION_LABEL}>{t("day.groups.values")}</h3>
        <span className="text-muted-foreground truncate text-xs">
          {t("day.valuesLegend")}
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-2">
        {tiles.map((tile) => (
          <ValueTile
            key={tile.key}
            tile={tile}
            selected={focusKeys.has(tile.key)}
          />
        ))}
      </ul>
      {rest.length > 0 ? (
        <button
          type="button"
          data-slot="day-values-all"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium focus-visible:ring-[3px] focus-visible:outline-none sm:min-h-9"
        >
          {expanded ? t("day.valuesFewer") : tCount("day.valuesAll", total)}
          <ChevronRight
            className={cn(
              "size-4 transition-transform motion-reduce:transition-none",
              expanded && "-rotate-90",
            )}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </section>
  );
}

/* ─── Events ──────────────────────────────────────────────────────────── */

const EVENT_ICON: Record<DayEventKind, LucideIcon> = {
  intake: Pill,
  doseChange: Pill,
  medicationStart: Pill,
  medicationEnd: Pill,
  pauseStart: PauseCircle,
  pauseEnd: PauseCircle,
  courseStart: Pill,
  courseEnd: Pill,
  illnessOnset: Thermometer,
  illnessResolved: Thermometer,
  illnessDayLog: Thermometer,
  symptom: Activity,
  allergyOnset: ShieldAlert,
  labResult: FlaskConical,
  visit: Stethoscope,
  procedure: Stethoscope,
  vaccination: Syringe,
  checkup: CalendarCheck,
  document: FileText,
  mood: Smile,
  assessment: Brain,
  workout: Footprints,
  cycleDayLog: CalendarHeart,
  lifeEvent: Flag,
};

export function DayEvents({ events }: { events: readonly DayEvent[] }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (events.length === 0) return null;
  return (
    <section className="space-y-1" data-slot="day-events">
      <h3 className={DAY_SECTION_LABEL}>{t("day.groups.happened")}</h3>
      <ul className="divide-border divide-y">
        {events.map((event) => {
          const Icon = EVENT_ICON[event.kind];
          return (
            <li
              key={`${event.kind}-${event.id}`}
              data-slot="day-event"
              data-kind={event.kind}
              className={cn(
                "relative grid grid-cols-[2.75rem_1.25rem_minmax(0,1fr)_1rem] items-start gap-x-2.5 py-2.5",
                event.href && "hover:bg-muted/40 rounded-md",
              )}
            >
              <span className="text-muted-foreground text-xs leading-5 tabular-nums">
                {event.at ? fmt.time(event.at) : ""}
              </span>
              <Icon
                className="text-muted-foreground mt-0.5 size-4"
                aria-hidden="true"
              />
              <div className="min-w-0">
                {event.href ? (
                  // The whole row is the target; the title carries the link
                  // so the document chips below stay their own targets.
                  <Link
                    href={event.href}
                    data-slot="day-event-link"
                    className="focus-visible:ring-ring/50 block text-sm leading-5 font-medium after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:outline-none focus-visible:after:ring-[3px] focus-visible:after:ring-inherit"
                  >
                    {dayTitle(event.kind, event.title, t)}
                  </Link>
                ) : (
                  <p className="text-sm leading-5 font-medium">
                    {dayTitle(event.kind, event.title, t)}
                  </p>
                )}
                {event.meta ? (
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {dayMeta(event.kind, event.meta, t)}
                  </p>
                ) : null}
                {event.note ? (
                  // The person's own words: content, never muted.
                  <p className="mt-0.5 text-sm" data-slot="day-event-note">
                    {event.note}
                  </p>
                ) : null}
                {event.docs.length > 0 ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {event.docs.map((doc) => (
                      <li key={doc.id} className="relative z-10 min-w-0">
                        <Link
                          href={`/documents?doc=${encodeURIComponent(doc.id)}`}
                          data-slot="day-event-doc"
                          title={t("day.openDocument")}
                          className="border-border hover:bg-muted focus-visible:ring-ring/50 inline-flex max-w-full items-center gap-1.5 rounded-md border py-1 pr-2.5 pl-2 text-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                        >
                          <FileText
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span className="truncate">{doc.name}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {event.href ? (
                <ChevronRight
                  className="text-muted-foreground mt-0.5 size-4"
                  aria-hidden="true"
                />
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
