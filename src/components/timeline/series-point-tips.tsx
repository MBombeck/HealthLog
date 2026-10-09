"use client";

/**
 * One value line's point, read on its own (v1.42).
 *
 * The selection bar is the cross-section of a whole bucket; a point of one
 * line answers for that line only: its name, the value with its unit, the
 * stretch it is the mean of ("July 2026", "Week of 22 September 2026") and
 * the readings behind it. Nothing of the other lines, nothing of the day.
 *
 * The points are drawn in the SVG, which is hidden from assistive technology
 * (the tables beside it read the chart out). Each point gets a plain HTML
 * target over it, 24 px across whatever the dot's size:
 *
 *   - a pointer resting on it shows the card;
 *   - the keyboard reaches each line once (one tab stop per line), Left and
 *     Right walk its points, and focus shows the same card;
 *   - a tap shows the card, a second tap on the same point (or the card's
 *     "View the whole day") opens the day, the two-step every chart in the
 *     app uses on a phone;
 *   - a click with a mouse selects the day, as a click on the chart does,
 *     and a double click opens it.
 *
 * The card is placed above the point and kept inside the chart's width
 * (`tipLeft`), so it never adds a horizontal scroll of its own.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { RichChartTooltip } from "@/components/charts/chart-tooltip";
import { TooltipDayAction } from "@/components/day/chart-day";
import { useTranslations } from "@/lib/i18n/context";

import { formatSeriesValue, type SeriesValueFormat } from "./series-format";
import type { TimelineLayout } from "./timeline-geometry";

/** Hit target across, in px: bigger than the dot, a comfortable aim. */
export const POINT_TARGET = 24;

/**
 * The card's left edge for a point at `x`: centred on the point, then pushed
 * back inside `[0, containerWidth]`.
 */
export function tipLeft(
  x: number,
  cardWidth: number,
  containerWidth: number,
): number {
  const centred = x - cardWidth / 2;
  return Math.max(0, Math.min(centred, containerWidth - cardWidth));
}

interface Active {
  key: string;
  t: string;
  pinned: boolean;
}

export function SeriesPointTips({
  layout,
  today,
  seriesLabel,
  seriesColor,
  fmt,
  bucketLabel,
  onSelect,
  onOpenDay,
}: {
  layout: TimelineLayout;
  today: string;
  seriesLabel: (key: string) => string;
  seriesColor: (key: string) => string;
  fmt: SeriesValueFormat;
  /** The stretch a point is the mean of, worded ("July 2026"). */
  bucketLabel: (t: string) => string;
  onSelect: (date: string) => void;
  onOpenDay: (date: string) => void;
}) {
  const { tCount } = useTranslations();
  const [active, setActive] = useState<Active | null>(null);
  // Per line, the point that holds its one tab stop.
  const [stops, setStops] = useState<Record<string, string>>({});
  const pointerType = useRef<string>("mouse");
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardWidth, setCardWidth] = useState(200);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  // The card's real width, once drawn, for the clamping below.
  useLayoutEffect(() => {
    const width = cardRef.current?.offsetWidth;
    if (width && width !== cardWidth) setCardWidth(width);
  }, [active, cardWidth]);

  // A card pinned by a tap goes away with a tap anywhere else.
  const pinned = active?.pinned ?? false;
  useEffect(() => {
    if (!pinned) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest(
          '[data-slot="timeline-point-tip"], [data-slot="timeline-point-target"]',
        )
      ) {
        return;
      }
      setActive(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [pinned]);

  // The first day of a point's stretch that has happened, the day it opens.
  const dayOf = (t: string) => (t > today ? today : t);

  const series = layout.series.find((s) => s.key === active?.key);
  const point = series?.points.find((p) => p.t === active?.t);

  const words = (key: string, t: string, mean: number, unit: string | null) =>
    `${seriesLabel(key)}, ${bucketLabel(t)}: ${formatSeriesValue(key, mean, unit, fmt)}`;

  function move(
    event: KeyboardEvent<HTMLButtonElement>,
    key: string,
    index: number,
  ) {
    const points = layout.series.find((s) => s.key === key)?.points ?? [];
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "ArrowRight")
      next = Math.min(points.length - 1, index + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = points.length - 1;
    else if (event.key === "Escape") {
      setActive(null);
      return;
    } else return;
    event.preventDefault();
    const target = points[next];
    if (!target) return;
    setStops((s) => ({ ...s, [key]: target.t }));
    buttons.current.get(`${key}:${target.t}`)?.focus();
  }

  return (
    <div data-slot="timeline-point-tips">
      {layout.series.map((s) =>
        s.points.map((p, i) => {
          const id = `${s.key}:${p.t}`;
          const stop = stops[s.key] ?? s.points.at(-1)?.t;
          return (
            <button
              key={id}
              ref={(node) => {
                if (node) buttons.current.set(id, node);
                else buttons.current.delete(id);
              }}
              type="button"
              data-slot="timeline-point-target"
              data-series={s.key}
              data-t={p.t}
              tabIndex={p.t === stop ? 0 : -1}
              aria-label={`${words(s.key, p.t, p.mean, s.unit)}, ${tCount("timeline.values.readings", p.count)}`}
              onPointerDown={(event) => {
                pointerType.current = event.pointerType;
                event.stopPropagation();
              }}
              onPointerEnter={(event) => {
                if (event.pointerType !== "mouse") return;
                setActive((a) =>
                  a?.pinned ? a : { key: s.key, t: p.t, pinned: false },
                );
              }}
              onPointerLeave={(event) => {
                if (event.pointerType !== "mouse") return;
                setActive((a) => (a?.pinned ? a : null));
              }}
              onFocus={() => {
                setStops((st) => ({ ...st, [s.key]: p.t }));
                setActive({ key: s.key, t: p.t, pinned: false });
              }}
              onBlur={() => setActive((a) => (a?.pinned ? a : null))}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenDay(dayOf(p.t));
                  return;
                }
                move(event, s.key, i);
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (pointerType.current === "mouse") {
                  onSelect(dayOf(p.t));
                  return;
                }
                // A tap shows the card; a second tap on the same point opens
                // the day.
                if (
                  active?.pinned &&
                  active.key === s.key &&
                  active.t === p.t
                ) {
                  onOpenDay(dayOf(p.t));
                  return;
                }
                setActive({ key: s.key, t: p.t, pinned: true });
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onOpenDay(dayOf(p.t));
              }}
              className="focus-visible:ring-ring/50 absolute rounded-full outline-none focus-visible:ring-2"
              style={{
                left: p.x - POINT_TARGET / 2,
                top: p.y - POINT_TARGET / 2,
                width: POINT_TARGET,
                height: POINT_TARGET,
              }}
            />
          );
        }),
      )}
      {series && point ? (
        <div
          ref={cardRef}
          data-slot="timeline-point-tip"
          data-series={series.key}
          data-t={point.t}
          className={
            active?.pinned
              ? "absolute z-10 w-max max-w-60"
              : "pointer-events-none absolute z-10 w-max max-w-60"
          }
          style={{
            left: tipLeft(point.x, cardWidth, layout.width),
            // Above the point, below it when the line sits at the top.
            ...(point.y > 120
              ? { bottom: layout.height - point.y + POINT_TARGET / 2 }
              : { top: point.y + POINT_TARGET / 2 }),
          }}
        >
          <RichChartTooltip
            active
            label={bucketLabel(point.t)}
            rows={[
              {
                name: seriesLabel(series.key),
                value: formatSeriesValue(
                  series.key,
                  point.mean,
                  series.unit,
                  fmt,
                ),
                color: seriesColor(series.key),
                delta: tCount("timeline.values.readings", point.count),
              },
            ]}
            action={
              active?.pinned ? (
                <TooltipDayAction onOpen={() => onOpenDay(dayOf(point.t))} />
              ) : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
