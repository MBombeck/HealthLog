"use client";

/**
 * The timeline on a phone (v1.42, #613): an "Ongoing" block that folds away,
 * then the chronicle, newest first, with the bucket means beside the month
 * headers (a quarter named once, at its newest month, with its span), thin
 * rails beside the rows an episode or a course spans, and empty stretches
 * named rather than skipped. Built from `chronicle-model.ts`.
 *
 * A dated row opens its day (the same `?day=` layer the chart hands off to);
 * a life event opens its edit sheet instead, because the event is the
 * person's own entry and that is where it is changed.
 */
import { useState } from "react";
import {
  CalendarHeart,
  ChevronDown,
  FileText,
  Flag,
  FlaskConical,
  Pill,
  Shield,
  Sparkles,
  Stethoscope,
  Syringe,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import type { TimelineItemKind, TimelineResponse } from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  RAIL_LANES,
  buildChronicle,
  standingChips,
  type ChronicleEntry,
  type ChronicleGrouping,
  type ChronicleRails,
} from "./chronicle-model";
import { useItemWords } from "./item-words";
import {
  formatAtPrecision,
  formatDayMonth,
  formatMonthLong,
  formatMonthYear,
} from "./timeline-dates";
import { LANE_COLOR } from "./timeline-geometry";
import { MeanPartsLine, bucketText, laneDotStyle } from "./timeline-chart";
import {
  chronicleMeans,
  meanParts,
  type SeriesValueFormat,
} from "./series-format";

const KIND_ICON: Partial<Record<TimelineItemKind, LucideIcon>> = {
  lifeEvent: Flag,
  travel: Flag,
  episode: Thermometer,
  chronic: Thermometer,
  allergy: Shield,
  medication: Pill,
  course: Pill,
  doseChange: Pill,
  pause: Pill,
  vaccination: Syringe,
  visit: Stethoscope,
  procedure: Stethoscope,
  labDay: FlaskConical,
  document: FileText,
  cycle: CalendarHeart,
};

const RAIL_X: Record<(typeof RAIL_LANES)[number], number> = {
  illness: 6,
  medications: 13,
};

function Rails({ rails }: { rails: ChronicleRails }) {
  // One positioned layer over the row, so the rails never take a grid cell.
  return (
    <span className="pointer-events-none absolute inset-0" aria-hidden="true">
      {RAIL_LANES.map((lane) => {
        const mode = rails[lane];
        if (!mode) return null;
        const color = LANE_COLOR[lane];
        const span =
          mode === "full"
            ? { top: 0, bottom: 0 }
            : mode === "start"
              ? { top: 0, bottom: "50%" }
              : mode === "end"
                ? { top: "50%", bottom: 0 }
                : null;
        return (
          <span key={lane}>
            {span && (
              <span
                className="absolute w-[3px] rounded-sm"
                style={{
                  left: RAIL_X[lane],
                  ...span,
                  background: color,
                  opacity: 0.8,
                }}
              />
            )}
            {mode !== "full" && (
              <span
                className="absolute size-[7px] rounded-full"
                style={{
                  left: RAIL_X[lane] - 2,
                  top: "calc(50% - 3.5px)",
                  background: color,
                }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

export function TimelineChronicle({
  timeline,
  today,
  grouping,
  selected,
  seriesColor,
  seriesFormat,
  onOpenDay,
  onEditLifeEvent,
}: {
  timeline: TimelineResponse;
  today: string;
  grouping: ChronicleGrouping;
  selected: string | null;
  /** The colour of each value line, as on the chart (`series-colors.ts`). */
  seriesColor: (key: string) => string;
  /** How a value reads (`useSeriesValueFormat`). */
  seriesFormat: SeriesValueFormat;
  onOpenDay: (date: string) => void;
  onEditLifeEvent: ((id: string) => void) | null;
}) {
  const { t, tCount, locale } = useTranslations();
  const words = useItemWords();
  const intl = resolveIntlLocale(locale);
  const [standingOpen, setStandingOpen] = useState(true);
  const chips = standingChips(timeline, (item) => words(item).label);
  const rows = buildChronicle(timeline, today, grouping);
  // The means ride on the month headers, each bucket on the newest month it
  // overlaps; the year view lists none.
  const means =
    grouping === "month"
      ? chronicleMeans(
          timeline.series,
          timeline.bucket,
          rows.flatMap((r) => (r.type === "header" ? [r.group] : [])),
        )
      : new Map<string, never>();

  const groupLabel = (group: string) =>
    grouping === "month" ? formatMonthYear(group, intl) : group.slice(0, 4);
  const gapLabel = (from: string, to: string) => {
    if (from === to)
      return t("timeline.chronicle.gapSingle", { period: groupLabel(from) });
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    const fromText =
      grouping === "month" && sameYear
        ? formatMonthLong(from, intl)
        : groupLabel(from);
    return t("timeline.chronicle.gap", { from: fromText, to: groupLabel(to) });
  };

  function entryText(entry: ChronicleEntry): {
    title: string;
    meta: string | null;
  } {
    if (entry.kind === "notable") {
      return {
        title: t(`timeline.chronicle.notable.${entry.notable}`),
        meta: t("timeline.chronicle.notableMeta"),
      };
    }
    const { item, role } = entry;
    const { label, sub } = words(item);
    if (role === "end") {
      // A pause that ends is the medication taken up again, not ended.
      return {
        title:
          item.kind === "pause"
            ? t("day.event.resumed", { label: item.label })
            : t("timeline.chronicle.ended", { label }),
        meta: entry.days
          ? tCount("timeline.chronicle.afterDays", entry.days)
          : null,
      };
    }
    const meta = [sub, item.startKnown ? null : t("timeline.startMissing")]
      .filter(Boolean)
      .join(" · ");
    return { title: label, meta: meta || null };
  }

  return (
    <div className="space-y-4" data-slot="timeline-chronicle">
      {chips.length > 0 && (
        <Card className="gap-2 py-3" data-slot="timeline-standing">
          <button
            type="button"
            aria-expanded={standingOpen}
            aria-controls="timeline-standing-chips"
            onClick={() => setStandingOpen((v) => !v)}
            className="focus-visible:ring-ring/50 flex min-h-11 items-center justify-between rounded-md px-4 text-left outline-none focus-visible:ring-2"
          >
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("timeline.standing")}
            </span>
            <ChevronDown
              className={cn(
                "text-muted-foreground size-4 motion-safe:transition-transform",
                standingOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
          {standingOpen && (
            <ul
              id="timeline-standing-chips"
              className="flex flex-wrap gap-1.5 px-4"
            >
              {chips.map((chip) => (
                <li
                  key={`${chip.lane}-${chip.id}`}
                  className="bg-muted text-foreground text-2xs inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium"
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={laneDotStyle(chip.lane)}
                    aria-hidden="true"
                  />
                  {chip.count > 1
                    ? tCount("timeline.standingAllergies", chip.count)
                    : chip.label}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <ol className="relative" aria-label={t("timeline.table.caption")}>
        {rows.map((row) => {
          if (row.type === "gap") {
            return (
              <li
                key={`gap-${row.from}`}
                data-slot="timeline-chronicle-gap"
                className="relative pt-2 pl-6"
              >
                <Rails rails={row.rails} />
                <p className="text-muted-foreground border-border rounded-lg border border-dashed px-3 py-2.5 text-xs">
                  {gapLabel(row.from, row.to)}
                </p>
              </li>
            );
          }
          if (row.type === "header") {
            const bucketMeans = means.get(row.group);
            const parts = bucketMeans
              ? meanParts(bucketMeans.values, seriesFormat)
              : [];
            return (
              <li
                key={`h-${row.group}`}
                className="relative flex items-baseline justify-between gap-3 pt-4 pb-1.5 pl-6"
                data-slot="timeline-chronicle-month"
                data-group={row.group}
              >
                <Rails rails={row.rails} />
                <h3 className="text-sm font-semibold">
                  {groupLabel(row.group)}
                </h3>
                {bucketMeans && parts.length > 0 && (
                  <span
                    className="text-muted-foreground text-xs tabular-nums"
                    data-slot="timeline-chronicle-means"
                    data-bucket={bucketMeans.start}
                  >
                    {timeline.bucket === "month"
                      ? null
                      : `${bucketText(bucketMeans.start, timeline.bucket, intl, t)}: `}
                    <MeanPartsLine parts={parts} seriesColor={seriesColor} />
                  </span>
                )}
              </li>
            );
          }
          const { entry } = row;
          const { title, meta } = entryText(entry);
          const Icon =
            entry.kind === "notable"
              ? Sparkles
              : (KIND_ICON[entry.item.kind] ?? Flag);
          const precision =
            entry.kind === "item" ? entry.item.precision : "DAY";
          const dateText =
            precision === "DAY"
              ? formatDayMonth(entry.date, intl)
              : formatAtPrecision(entry.date, precision, intl);
          const isLifeEvent =
            entry.kind === "item" && entry.item.kind === "lifeEvent";
          const action =
            isLifeEvent && onEditLifeEvent && entry.kind === "item"
              ? () => onEditLifeEvent(entry.item.id)
              : precision === "DAY"
                ? () => onOpenDay(entry.date)
                : null;
          const highlighted = selected === entry.date;
          const body = (
            <>
              <Rails rails={row.rails} />
              <span className="text-muted-foreground text-xs leading-5 whitespace-nowrap tabular-nums">
                {dateText}
              </span>
              <Icon
                className="text-muted-foreground mt-0.5 size-4"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-sm leading-5",
                    entry.kind === "notable" ? "font-normal" : "font-medium",
                  )}
                >
                  {title}
                </span>
                {meta && (
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    {meta}
                  </span>
                )}
              </span>
            </>
          );
          const rowClass = cn(
            "relative grid w-full grid-cols-[3.25rem_1rem_1fr] items-start gap-x-2.5 rounded-lg py-2.5 pr-3 pl-6 text-left",
            highlighted && "bg-muted",
          );
          const key =
            entry.kind === "item"
              ? `${entry.item.id}-${entry.role}`
              : `notable-${entry.date}-${entry.notable}`;
          return (
            <li
              key={key}
              data-slot="timeline-chronicle-row"
              data-date={entry.date}
            >
              {action ? (
                <button
                  type="button"
                  onClick={action}
                  className={cn(
                    rowClass,
                    "hover:bg-accent focus-visible:ring-ring/50 min-h-11 outline-none focus-visible:ring-2",
                  )}
                >
                  {body}
                </button>
              ) : (
                <div className={rowClass}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
