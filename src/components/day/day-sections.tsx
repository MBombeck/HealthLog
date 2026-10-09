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

import { TagChip } from "@/components/ui/tag-chip";
import {
  type DateKey,
  type DayEvent,
  type DayEventKind,
  type DayNotable,
  type DayRunningItem,
  type DayRunningKind,
  type DayValue,
} from "@/lib/day/contract";
import { visitKindWords } from "@/components/timeline/item-words";
import {
  DOCUMENT_KIND_KEY,
  LIFE_EVENT_CATEGORY_KEY,
  keyOf,
} from "@/components/timeline/label-keys";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { metricPageHref } from "@/lib/insights/metric-page";
import { MOOD_LABEL_KEYS } from "@/lib/mood/labels";
import { cn } from "@/lib/utils";

import type { DayFocus } from "./day-layer-controller";
import {
  curateDayValues,
  numberLinePositions,
  tileKeyOf,
  type DayValueTile,
} from "./day-values-model";
import {
  ALLERGY_SEVERITY_KEY,
  ASSESSMENT_BAND_KEY,
  ASSESSMENT_INSTRUMENT_KEY,
  CYCLE_FLOW_KEY,
  DAY_NOTABLE_KEY,
  ILLNESS_IMPACT_KEY,
  WORKOUT_SPORT_KEY,
} from "./label-keys";
import { cycleRunningLine } from "./day-cycle-line";
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

/**
 * The value the person came from. A comparison shows only when the opening
 * surface brings one (an earlier lab result); the usual range of the 30 days
 * before is not repeated here, because the value tiles below draw it.
 */
export function DayFocusCard({ focus }: { focus: DayFocus }) {
  const compare = focus.compare ?? null;
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
    return t(DAY_NOTABLE_KEY[notable.kind], params);
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
              ? `${labelFor(tileKeyOf(notable.type))}: `
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
  lifeEvent: "var(--chart-2)",
};

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * The server sends what the record holds and leaves the words to the reader's
 * language: a cycle is titled "cycle" and a trip "travel", a mood entry
 * carries its mood code, a screener its instrument, a workout its sport, and
 * a start, an end, a pause or a resumption the bare name of what started,
 * ended, paused or resumed. They are worded here. The record's kind decides,
 * not the title: a medication or a document the person named "cycle" keeps
 * its own name.
 */
export function dayTitle(kind: string, title: string, t: Translate): string {
  switch (kind) {
    case "cyclePhase":
    case "cycleDayLog":
      return t("nav.cycle");
    case "travel":
      return t("day.travel");
    case "medicationStart":
    case "courseStart":
      return t("day.event.started", { label: title });
    case "medicationEnd":
    case "courseEnd":
      return t("day.event.ended", { label: title });
    case "pauseStart":
    case "medicationPause":
      return t("day.event.paused", { label: title });
    case "pauseEnd":
      return t("day.event.resumed", { label: title });
    case "illnessOnset":
      return t("day.event.illnessBegan", { label: title });
    case "illnessResolved":
      return t("day.event.illnessResolved", { label: title });
    case "mood": {
      const key = MOOD_LABEL_KEYS[title];
      return key ? t(key) : t("nav.mood");
    }
    case "assessment": {
      const key = keyOf(ASSESSMENT_INSTRUMENT_KEY, title);
      return key ? t(key) : title;
    }
    case "workout": {
      const key = keyOf(WORKOUT_SPORT_KEY, title);
      return key ? t(key) : title;
    }
    default:
      return title;
  }
}

/**
 * A row's second line. Where it is a code (a category, a kind, a severity, a
 * band) or a bare number (an intensity, a dose number, a functional impact),
 * it is worded; a code the bundle does not know is left out rather than
 * shown raw. A dose, a duration or a lab value is the record's own text.
 */
export function dayMeta(
  kind: string,
  meta: string,
  t: Translate,
  title = "",
): string | null {
  switch (kind) {
    case "cycleDayLog": {
      const key = keyOf(CYCLE_FLOW_KEY, meta);
      return key ? `${t("cycle.flow.label")}: ${t(key)}` : null;
    }
    case "lifeEvent": {
      const key = keyOf(LIFE_EVENT_CATEGORY_KEY, meta);
      return key ? t(key) : null;
    }
    // The mood is the title; its score says the same thing again.
    case "mood":
      return null;
    case "assessment": {
      const [score, band] = meta.split(" ");
      const bands = keyOf(ASSESSMENT_INSTRUMENT_KEY, title)
        ? ASSESSMENT_BAND_KEY[title as keyof typeof ASSESSMENT_BAND_KEY]
        : null;
      const bandKey = bands && band ? keyOf(bands, band) : undefined;
      const bandText = bandKey ? t(bandKey) : null;
      return [score, bandText].filter(Boolean).join(", ") || null;
    }
    case "symptom":
      return t("symptoms.intensityPill", { value: meta });
    case "allergyOnset": {
      const key = keyOf(ALLERGY_SEVERITY_KEY, meta);
      return key ? t(key) : null;
    }
    case "visit":
    case "procedure":
      return meta === "PLANNED"
        ? t("encounters.status.planned")
        : visitKindWords(t, meta);
    case "vaccination":
      return t("vaccinations.series.doseN", { position: meta });
    case "illnessDayLog": {
      const key = keyOf(ILLNESS_IMPACT_KEY, meta);
      return key ? t("illness.timeline.impact", { impact: t(key) }) : null;
    }
    case "document": {
      const key = keyOf(DOCUMENT_KIND_KEY, meta);
      return key ? t(key) : null;
    }
    default:
      return meta;
  }
}

/** Running kinds whose `sub` is a dose and reads as part of the name. */
const DOSE_SUB_KINDS: ReadonlySet<DayRunningKind> = new Set([
  "medication",
  "medicationCourse",
]);

export function DayRunning({
  items,
  date,
}: {
  items: readonly DayRunningItem[];
  /** The viewed day; a start date in another year names its year. */
  date: DateKey;
}) {
  const { t, locale } = useTranslations();
  if (items.length === 0) return null;
  const viewedYear = date.slice(0, 4);
  const intlLocale = resolveIntlLocale(locale);
  const sinceText = (since: string): string =>
    new Intl.DateTimeFormat(intlLocale, {
      day: "numeric",
      month: "long",
      ...(since.slice(0, 4) === viewedYear ? {} : { year: "numeric" }),
      timeZone: "UTC",
    }).format(new Date(`${since}T12:00:00.000Z`));
  return (
    <section className="space-y-2" data-slot="day-running">
      <h3 className={DAY_SECTION_LABEL}>{t("day.groups.running")}</h3>
      <ul>
        {items.map((item) => {
          const cycleLine = cycleRunningLine(item, t);
          const title = dayTitle(item.kind, item.title, t);
          const doseInName = item.sub !== null && DOSE_SUB_KINDS.has(item.kind);
          const name = doseInName ? `${title} ${item.sub}` : title;
          const chip =
            cycleLine === null && item.sub !== null && !doseInName
              ? dayMeta(item.kind, item.sub, t)
              : null;
          const since =
            item.dayCount === null && item.since !== null
              ? sinceText(item.since)
              : null;
          const detail =
            cycleLine !== null
              ? cycleLine
              : item.dayIndex !== null
                ? item.dayCount !== null
                  ? t("day.dayOf", { n: item.dayIndex, m: item.dayCount })
                  : since !== null
                    ? t("day.dayNSince", { n: item.dayIndex, date: since })
                    : t("day.dayN", { n: item.dayIndex })
                : since !== null
                  ? t("day.sinceDate", { date: since })
                  : null;
          const body = (
            <>
              <span
                aria-hidden="true"
                className="w-[3px] shrink-0 self-stretch rounded-full"
                style={{ backgroundColor: RUNNING_COLOR[item.kind] }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {name}
                  </span>
                  {chip ? <TagChip className="shrink-0">{chip}</TagChip> : null}
                </span>
                {detail ? (
                  <span className="text-muted-foreground block truncate text-xs">
                    {detail}
                  </span>
                ) : null}
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

export function NumberLine({
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
  // Like a score tile, a value tile leads to its metric's page; a kind
  // without a page of its own stays a plain tile.
  const href = metricPageHref(tile.key);
  const body = (
    <>
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
    </>
  );
  const frame = cn(
    "bg-muted/60 flex min-h-11 min-w-0 flex-col rounded-lg px-3 py-2.5",
    selected && "ring-foreground ring-[1.5px] ring-inset",
  );
  return (
    <li
      data-slot="day-value"
      data-type={tile.key}
      data-selected={selected ? "true" : undefined}
      className="flex min-w-0"
    >
      {href ? (
        <Link
          href={href}
          data-slot="day-value-link"
          className={cn(
            frame,
            "hover:bg-muted focus-visible:ring-ring/50 w-full transition-colors focus-visible:ring-[3px] focus-visible:outline-none",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={cn(frame, "w-full")}>{body}</div>
      )}
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
          const meta = event.meta
            ? dayMeta(event.kind, event.meta, t, event.title)
            : null;
          return (
            <li
              key={`${event.kind}-${event.id}`}
              data-slot="day-event"
              data-kind={event.kind}
              className={cn(
                // The time column fits "08:10 AM" and "오전 08:10" on one
                // line; the time itself never wraps.
                "relative grid grid-cols-[3.75rem_1.25rem_minmax(0,1fr)_1rem] items-start gap-x-2.5 py-2.5",
                event.href && "hover:bg-muted/40 rounded-md",
              )}
            >
              <span
                data-slot="day-event-time"
                className="text-muted-foreground text-xs leading-5 whitespace-nowrap tabular-nums"
              >
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
                {meta ? (
                  <p className="text-muted-foreground mt-0.5 text-xs">{meta}</p>
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
