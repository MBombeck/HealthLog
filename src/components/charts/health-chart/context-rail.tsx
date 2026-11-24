"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Pill, Thermometer } from "lucide-react";

import { PHASE_HUE } from "@/components/cycle/phase-tokens";
import { InlineAction } from "@/components/ui/inline-action";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SwitchRow } from "@/components/ui/switch-row";
import { CHART_CONTEXT_CYCLE_PHASES } from "@/lib/charts/context-markers-contract";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import type { ContextMarkEntry, ResolvedContextMarks } from "./context-marks";

type Translate = (key: string, params?: Record<string, string>) => string;

/** A calendar day, spelled by the chart's own UTC-pinned date format. */
function dayLabel(key: string, formatDate: (date: Date) => string): string {
  return formatDate(new Date(`${key}T12:00:00Z`));
}

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
        ? "startEstimated"
        : mark.dose
          ? "startDose"
          : "start"
      : mark.kind === "doseChange" && !mark.dose
        ? "doseChangeBare"
        : mark.kind;
  return {
    date: dayLabel(mark.date, formatDate),
    text: t(`chartContext.${key}`, { name, dose }),
    href: mark.href,
  };
}

/** Close a hover-opened popover only after the pointer has left both parts. */
const HOVER_CLOSE_MS = 150;

function ContextMarkButton({
  entries,
  t,
  formatDate,
}: {
  entries: ContextMarkEntry[];
  t: Translate;
  formatDate: (date: Date) => string;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A click after a hover opened it shows it rather than toggling it shut.
  const openedByHover = useRef(false);
  // A click or a tap pins it open until it is dismissed.
  const pinned = useRef(false);
  const lines = entries.map((e) => contextEntryLine(e, t, formatDate));
  const onlyIllness = entries.every((e) => e.kind === "illness");
  const Icon = onlyIllness ? Thermometer : Pill;
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
          aria-label={lines.map((l) => `${l.date}, ${l.text}`).join("; ")}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onClick={(event) => {
            if (open && openedByHover.current) event.preventDefault();
            openedByHover.current = false;
            pinned.current = true;
          }}
          className={cn(
            "flex size-6 items-center justify-center rounded-full",
            "hover:bg-muted focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
            onlyIllness ? "text-warning" : "text-muted-foreground",
          )}
        >
          {entries.length > 1 ? (
            <span className="text-2xs font-semibold tabular-nums">
              {entries.length}
            </span>
          ) : (
            <Icon className="size-3.5" aria-hidden="true" />
          )}
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

/**
 * The marks a reader can open, in a row under the plot at their days.
 * Rendered only when there is at least one (see `resolveContextMarks`).
 */
export function ChartContextRail({
  marks,
  maxIndex,
  insetLeft,
  insetRight,
  formatDate,
}: {
  marks: ResolvedContextMarks;
  maxIndex: number;
  insetLeft: number;
  insetRight: number;
  formatDate: (date: Date) => string;
}) {
  const { t } = useTranslations();
  if (marks.groups.length === 0) return null;
  return (
    <ul
      data-slot="chart-context"
      aria-label={t("chartContext.listLabel")}
      className="relative mt-1 h-6"
      style={{ marginLeft: insetLeft, marginRight: insetRight }}
    >
      {marks.groups.map((group) => (
        <li
          key={`${group.x}-${group.entries.length}`}
          className="absolute top-0 -translate-x-1/2"
          style={{
            left: `${maxIndex > 0 ? (group.x / maxIndex) * 100 : 0}%`,
          }}
        >
          <ContextMarkButton
            entries={group.entries}
            t={t}
            formatDate={formatDate}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The cycle-phase switch under a chart whose window holds observed cycles,
 * and, while on, what each colour of the ribbon means.
 */
export function ChartCycleSwitch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const { t } = useTranslations();
  return (
    <SwitchRow
      label={t("chartContext.cyclePhases")}
      checked={checked}
      onCheckedChange={onCheckedChange}
      data-slot="chart-context-cycle-switch"
      className="mt-3"
    >
      {checked ? (
        <ul
          className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 pt-1 text-xs"
          data-slot="chart-context-cycle-legend"
        >
          {CHART_CONTEXT_CYCLE_PHASES.map((phase) => (
            <li key={phase} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ background: PHASE_HUE[phase] }}
              />
              {t(`cycle.phase.${phase}`)}
            </li>
          ))}
        </ul>
      ) : null}
    </SwitchRow>
  );
}
