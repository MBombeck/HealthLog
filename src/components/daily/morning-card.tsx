"use client";

/**
 * One of the morning's two server-built cards: last night, or what is
 * different today. It renders the `DailyMorningCard` as delivered and decides
 * nothing: the title, every line and the ring come worded and resolved from
 * `GET /api/daily/morning`, so the web and the app show the same card.
 *
 * The card is one destination (the score's page), reached through its title.
 * The title link stretches over the card so the whole surface answers a tap,
 * while a line that carries its own `href` stays a separate link above it.
 *
 * The ring follows the wire exactly:
 *  - a fresh score with a band paints in its band;
 *  - a fresh score without a band (Rest mode) paints in the metric's own hue
 *    and is announced without a band word;
 *  - no score (not fresh) is the ring's provisional face, and the line below
 *    says when the last value was ("Last 81 on 24 Nov").
 *
 * A device's own score sits under the vendor's name, on the vendor's scale
 * and without a HealthLog band.
 */
import Link from "next/link";
import { Gauge, Moon, type LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import type { RingHue } from "@/components/insights/derived/ring-hues";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { DailyMorningCard, MorningCardKind } from "@/lib/daily/morning";

const KIND_ICON: Record<MorningCardKind, LucideIcon> = {
  night: Moon,
  today_different: Gauge,
};

/** The score a card's ring shows, named as the glossary names it. */
const RING_LABEL_KEY: Record<MorningCardKind, string> = {
  night: "insights.derived.composite.SLEEP_SCORE.title",
  today_different: "insights.derived.composite.READINESS.title",
};

const RING_HUE: Record<MorningCardKind, RingHue> = {
  night: "sleep",
  today_different: "readiness",
};

/**
 * The stretched title link and the card's hover and focus state. The link's
 * `::after` covers the card; anything else interactive sits above it.
 */
export const MORNING_CARD_SURFACE = cn(
  "relative transition-colors motion-reduce:transition-none",
  "has-[[data-card-link]:hover]:bg-muted/40",
  "has-[[data-card-link]:focus-visible]:ring-ring/50 has-[[data-card-link]:focus-visible]:ring-2",
);

export function MorningCard({ card }: { card: DailyMorningCard }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // The server words the title; the glossary key stands in for a response
  // cached before the field existed.
  const title = card.title || t(card.titleKey);
  const ring = card.ring;
  // A ring that is not fresh never shows a number, whatever else it carries.
  const ringScore = ring && ring.fresh ? ring.score : null;
  const ringLabel = t(RING_LABEL_KEY[card.kind]);
  const staleWithHistory =
    ring !== null && !ring.fresh && ring.asOfDay !== null;
  const bandless = ringScore !== null && ring?.band === null;

  return (
    <Card
      data-slot="morning-card"
      data-kind={card.kind}
      density="compact"
      className={cn(MORNING_CARD_SURFACE, "h-full")}
    >
      <CardContent className="flex flex-col gap-3">
        <TileHeader
          icon={KIND_ICON[card.kind]}
          size="sm"
          titleAs="h3"
          title={
            <Link
              href={card.href}
              data-card-link
              className="after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none"
            >
              {title}
            </Link>
          }
        />
        <div className="flex items-center gap-4">
          {ring ? (
            <div
              data-slot="morning-card-ring"
              data-fresh={ring.fresh ? "true" : "false"}
              data-as-of-day={ring.asOfDay ?? undefined}
              className={cn(
                "shrink-0",
                // A value that went stale is not "too little data": the
                // ring's own provisional caption gives way to the line
                // beside it ("Last 81 on 24 Nov").
                staleWithHistory &&
                  "[&_[data-slot=score-ring-provisional]]:hidden",
              )}
            >
              <ScoreRing
                score={ringScore}
                band={
                  ringScore !== null && ring.band
                    ? (ring.band as ScoreBand)
                    : undefined
                }
                hue={bandless ? RING_HUE[card.kind] : undefined}
                ariaLabel={bandless ? `${ringLabel} ${ringScore}` : undefined}
                size="sm"
                flat
                label={ringLabel}
              />
            </div>
          ) : null}
          {card.lines.length > 0 || card.sourceValues.length > 0 ? (
            <ul className="min-w-0 flex-1 space-y-1.5">
              {card.lines.map((line, i) => (
                <li
                  key={`line-${i}`}
                  data-slot="morning-card-line"
                  className="text-foreground text-sm"
                >
                  {line.href ? (
                    <Link
                      href={line.href}
                      className="focus-visible:ring-ring/50 relative z-10 rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
                    >
                      {line.text}
                    </Link>
                  ) : (
                    line.text
                  )}
                </li>
              ))}
              {card.sourceValues.map((value) => (
                <li
                  key={`${value.source}-${value.label}`}
                  data-slot="morning-card-source"
                  data-source={value.source}
                  data-measured-at={value.measuredAt}
                  className="text-muted-foreground text-xs"
                >
                  {t("daily.morning.sourceValue", {
                    label: value.label,
                    value: fmt.integer(value.value),
                    max: fmt.integer(value.scaleMax),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
