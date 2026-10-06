"use client";

/**
 * v1.41 — the tables a turn has read so far, while it still runs.
 *
 * Under the status line, one quiet line per table as soon as the call that
 * read it settles: its title, window and how many readings it holds, with a
 * small sparkline in the first chart colour and no axes. At most three. A
 * tap opens the full chart (or table) right there; nothing opens by itself.
 * Once the answer settles the previews go: the tables the answer points at
 * become its charts, the rest sit under "Data used" in the closed trail.
 */
import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import {
  coachWindowLabelKey,
  interimLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import type { CoachResultTable } from "@/lib/ai/coach/types";

import { CoachResultView } from "./coach-results";

/** At most this many previews show, whatever the turn has read. */
export const MAX_INTERIM_PREVIEWS = 3;

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** The interim tables to preview, in the order they arrived. */
export function interimPreviews(
  results: readonly CoachResultTable[],
  interimRefs: readonly string[],
): CoachResultTable[] {
  const refs = new Set(interimRefs);
  return results
    .filter((result) => refs.has(result.ref))
    .slice(0, MAX_INTERIM_PREVIEWS);
}

/**
 * How many readings a table holds: the sum of its count column when it has
 * one (readings per day or week), else its rows.
 */
export function interimReadingCount(result: CoachResultTable): number {
  const countIndex = result.columns.findIndex((c) => c.kind === "count");
  if (countIndex === -1) return result.rowCount;
  let sum = 0;
  for (const row of result.rows) {
    const cell = row[countIndex];
    if (typeof cell === "number") sum += cell;
  }
  return sum > 0 ? sum : result.rowCount;
}

/** "Blood pressure by day, last 30 days, 214 readings". */
export function interimLabel(
  result: CoachResultTable,
  t: Translate,
  locale: Locale,
): string {
  const count = interimReadingCount(result);
  return t(interimLabelKey(count, locale), {
    title: result.title,
    window: t(coachWindowLabelKey(result.source.window)),
    count,
  });
}

/** The values the sparkline draws: the first charted series, in row order. */
export function sparklineValues(result: CoachResultTable): number[] {
  const spec = result.chart;
  const key =
    spec?.kind === "line" || spec?.kind === "bar"
      ? spec.series[0]
      : spec?.kind === "compare"
        ? spec.a
        : result.columns.find((c) => c.kind === "number")?.key;
  const index = result.columns.findIndex((c) => c.key === key);
  if (index === -1) return [];
  return result.rows
    .map((row) => row[index])
    .filter((cell): cell is number => typeof cell === "number");
}

/** An SVG polyline path through the values, inside `width × height`. */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, i) => {
      const x = values.length > 1 ? i * step : width / 2;
      const y = height - 1 - ((value - min) / span) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  return (
    <svg
      aria-hidden="true"
      data-slot="coach-interim-sparkline"
      viewBox="0 0 48 16"
      className="h-4 w-12 shrink-0 overflow-visible"
      preserveAspectRatio="none"
    >
      <polyline
        points={sparklinePoints(values, 48, 16)}
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function InterimPreview({ result }: { result: CoachResultTable }) {
  const { t, locale } = useTranslations();
  const detailId = useId();
  const [open, setOpen] = useState(false);
  return (
    <li
      data-slot="coach-interim-result"
      data-ref={result.ref}
      className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 flex min-w-0 flex-col gap-2 motion-safe:duration-300"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -my-1 flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded text-left text-xs outline-none focus-visible:ring-2 sm:my-0 sm:min-h-6"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 motion-safe:transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">
          {interimLabel(result, t, locale)}
        </span>
        <Sparkline values={sparklineValues(result)} />
      </button>
      {open ? (
        <div id={detailId} className="w-full min-w-0">
          <CoachResultView result={result} chartFirst />
        </div>
      ) : null}
    </li>
  );
}

export function CoachInterimResults({
  results,
  interimRefs,
}: {
  results: readonly CoachResultTable[];
  interimRefs: readonly string[];
}) {
  const previews = interimPreviews(results, interimRefs);
  if (previews.length === 0) return null;
  return (
    <ul
      data-slot="coach-interim-results"
      className="flex w-full min-w-0 flex-col gap-0.5 self-stretch"
    >
      {previews.map((result) => (
        <InterimPreview key={result.ref} result={result} />
      ))}
    </ul>
  );
}
