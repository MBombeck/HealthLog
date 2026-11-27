"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Droplets, Pill, Thermometer } from "lucide-react";

import { PHASE_HUE } from "@/components/cycle/phase-tokens";
import { InlineAction } from "@/components/ui/inline-action";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CHART_CONTEXT_CYCLE_PHASES,
  type ChartContextMedicationKind,
} from "@/lib/charts/context-markers-contract";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import type { ContextMarkEntry, ResolvedContextMarks } from "./context-marks";

/**
 * The chart's legend: one row under the plot that names every line on it
 * and every piece of context the window holds, in one shape. A series is a
 * swatch of its stroke and its name; an illness episode or a medication is
 * its glyph and its name, and opens the dates on a hover or a tap; the cycle
 * phases are a glyph that switches the ribbon on and, while on, name their
 * colours in the same row. Nothing about the context sits on a row of its
 * own any more.
 */

type Translate = (key: string, params?: Record<string, string>) => string;

/** A calendar day, spelled by the chart's own UTC-pinned date format. */
function dayLabel(key: string, formatDate: (date: Date) => string): string {
  return formatDate(new Date(`${key}T12:00:00Z`));
}

/** The line of each medication mark, spelled out so every key has a call site. */
const MEDICATION_LINE_KEYS: Readonly<
  Record<ChartContextMedicationKind, string>
> = {
  start: "chartContext.start",
  stop: "chartContext.stop",
  doseChange: "chartContext.doseChange",
  pause: "chartContext.pause",
  resume: "chartContext.resume",
};

/** One line per mark: what happened, in the record's own words. */
export function contextEntryLine(
  entry: ContextMarkEntry,
  t: Translate,
  formatDate: (date: Date) => string,
): { date: string; text: string; href: string } {
  if (entry.kind === "illness") {
    const { span } = entry;
    return {
      date: dayLabel(span.start, formatDate),
      text:
        span.end === null
          ? t("chartContext.illnessOpen", { label: span.label })
          : t("chartContext.illness", {
              label: span.label,
              end: dayLabel(span.end, formatDate),
            }),
      href: span.href,
    };
  }
  const { mark } = entry;
  const name = mark.name;
  const dose = mark.dose ?? "";
  const key =
    mark.kind === "start"
      ? mark.estimated
        ? "chartContext.startEstimated"
        : mark.dose
          ? "chartContext.startDose"
          : "chartContext.start"
      : mark.kind === "doseChange" && !mark.dose
        ? "chartContext.doseChangeBare"
        : MEDICATION_LINE_KEYS[mark.kind];
  return {
    date: dayLabel(mark.date, formatDate),
    text: t(key, { name, dose }),
    href: mark.href,
  };
}

/** Close a hover-opened popover only after the pointer has left both parts. */
const HOVER_CLOSE_MS = 150;

/** One legend item's box: the same height and gap for every kind. */
const ITEM_CLASS =
  "inline-flex h-6 items-center gap-1.5 text-xs text-foreground";

/** A button among the items: the item's box, a hover wash, a finger's 44 px. */
const BUTTON_CLASS = cn(
  ITEM_CLASS,
  "relative -mx-1.5 rounded-md px-1.5",
  "pointer-coarse:before:absolute pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']",
  "hover:bg-muted focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
);

/** The context entries of one record (an episode, a medication), in x order. */
interface ContextLegendItem {
  key: string;
  label: string;
  kind: ContextMarkEntry["kind"];
  entries: ContextMarkEntry[];
}

/** The window's marks, one item per episode or medication, first seen first. */
export function contextLegendItems(
  marks: ResolvedContextMarks,
): ContextLegendItem[] {
  const items = new Map<string, ContextLegendItem>();
  for (const group of marks.groups) {
    for (const entry of group.entries) {
      const key =
        entry.kind === "illness"
          ? `illness:${entry.span.id}`
          : `medication:${entry.mark.medicationId}`;
      const label =
        entry.kind === "illness" ? entry.span.label : entry.mark.name;
      const item = items.get(key);
      if (item) item.entries.push(entry);
      else items.set(key, { key, label, kind: entry.kind, entries: [entry] });
    }
  }
  return [...items.values()];
}

function ContextLegendButton({
  item,
  t,
  formatDate,
}: {
  item: ContextLegendItem;
  t: Translate;
  formatDate: (date: Date) => string;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A click after a hover opened it shows it rather than toggling it shut.
  const openedByHover = useRef(false);
  // A click or a tap pins it open until it is dismissed.
  const pinned = useRef(false);
  const lines = item.entries.map((e) => contextEntryLine(e, t, formatDate));
  const illness = item.kind === "illness";
  const Icon = illness ? Thermometer : Pill;
  // A mouse opens on hover; a finger or a key opens on activation (Radix).
  const hoverOpen = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (!open) openedByHover.current = true;
    setOpen(true);
  };
  const hoverClose = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse" || pinned.current) return;
    closeTimer.current = setTimeout(() => {
      openedByHover.current = false;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          pinned.current = false;
          openedByHover.current = false;
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="chart-context-mark"
          data-kind={item.kind}
          aria-label={lines.map((l) => `${l.date}, ${l.text}`).join("; ")}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onClick={(event) => {
            if (open && openedByHover.current) event.preventDefault();
            openedByHover.current = false;
            pinned.current = true;
          }}
          className={BUTTON_CLASS}
        >
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              illness ? "text-warning" : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
          <span className="max-w-48 truncate">{item.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-auto max-w-72 space-y-2"
        data-slot="chart-context-popover"
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
        // Hover is a preview: focus stays where the reader is.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {lines.map((line, i) => (
          <div key={i} className="space-y-0.5">
            <p className="text-muted-foreground text-xs">{line.date}</p>
            <p className="text-foreground text-sm">
              {line.text}{" "}
              <InlineAction asChild size="xs">
                <Link href={line.href}>{t("chartContext.open")}</Link>
              </InlineAction>
            </p>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** A drawn line's legend entry: its stroke as a swatch, its name. */
export interface ChartLegendSeries {
  key: string;
  label: string;
  color: string;
  /** The stroke's dash, as on the line ("5 5"); solid without. */
  dash?: string;
}

/**
 * The legend's line entries: every series, and with an overlay on, its 7-day
 * average and its trend, each in the stroke the plot draws it with
 * (`seriesLayers` in `chart-layers.tsx`).
 */
export function legendSeriesFor({
  types,
  colors,
  label,
  showMA,
  showTrend,
  t,
}: {
  types: readonly string[];
  colors: readonly string[];
  label: (type: string) => string;
  showMA: boolean;
  showTrend: boolean;
  t: (key: string) => string;
}): ChartLegendSeries[] {
  const color = (i: number) => colors[i % colors.length];
  return [
    ...types.map((type, i) => ({
      key: type,
      label: label(type),
      color: color(i),
    })),
    ...(showMA
      ? types.map((type, i) => ({
          key: `${type}_ma`,
          label: `${label(type)} (${t("charts.movingAverage7d")})`,
          color: color(i),
          dash: "5 5",
        }))
      : []),
    ...(showTrend
      ? types.map((type) => ({
          key: `${type}_trend`,
          label: `${label(type)} (${t("charts.trend")})`,
          color: "var(--muted-foreground)",
          dash: "8 4",
        }))
      : []),
  ];
}

function SeriesSwatch({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg
      width="16"
      height="8"
      viewBox="0 0 16 8"
      aria-hidden="true"
      className="shrink-0"
    >
      <line
        x1="1"
        y1="4"
        x2="15"
        y2="4"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The row under the plot. Rendered only when it has something to say: more
 * than one line, an overlay, or context in the window.
 */
export function ChartLegend({
  series,
  marks,
  formatDate,
  showCycle,
  onShowCycleChange,
}: {
  series: ChartLegendSeries[];
  marks: ResolvedContextMarks | null;
  formatDate: (date: Date) => string;
  showCycle: boolean;
  onShowCycleChange: (next: boolean) => void;
}) {
  const { t } = useTranslations();
  const context = marks ? contextLegendItems(marks) : [];
  const hasCycle = marks?.hasCycle ?? false;
  if (series.length < 2 && context.length === 0 && !hasCycle) return null;
  const cycleLabel = t("chartContext.cyclePhases");
  return (
    <ul
      data-slot="chart-legend"
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1"
    >
      {series.map((s) => (
        <li key={s.key} data-slot="chart-legend-series" className={ITEM_CLASS}>
          <SeriesSwatch color={s.color} dash={s.dash} />
          {s.label}
        </li>
      ))}
      {context.map((item) => (
        <li key={item.key} className="inline-flex">
          <ContextLegendButton item={item} t={t} formatDate={formatDate} />
        </li>
      ))}
      {hasCycle ? (
        <li className="inline-flex">
          <button
            type="button"
            data-slot="chart-context-cycle-toggle"
            aria-pressed={showCycle}
            aria-label={cycleLabel}
            title={cycleLabel}
            onClick={() => onShowCycleChange(!showCycle)}
            className={cn(
              BUTTON_CLASS,
              showCycle ? "bg-muted" : "text-muted-foreground",
            )}
          >
            <Droplets className="size-3.5 shrink-0" aria-hidden="true" />
          </button>
        </li>
      ) : null}
      {hasCycle && showCycle
        ? CHART_CONTEXT_CYCLE_PHASES.map((phase) => (
            <li
              key={phase}
              data-slot="chart-context-cycle-legend"
              className={ITEM_CLASS}
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ background: PHASE_HUE[phase] }}
              />
              {t(`cycle.phase.${phase}`)}
            </li>
          ))
        : null}
    </ul>
  );
}
