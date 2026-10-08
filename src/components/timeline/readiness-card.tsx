"use client";

/**
 * The readiness inventory as a card on top of the timeline (v1.42, #613),
 * while a lane is thin or empty and offers a way to close the gap. One
 * sentence on what the timeline already carries, then each gap with its one
 * link. Closing it is remembered on this device; the full inventory stays
 * one tap away under "Data coverage".
 */
import Link from "next/link";
import { ChevronRight, Layers, X } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { TimelineReadinessResponse } from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";

import { readinessGaps, readinessTally } from "./readiness-model";
import { wordKey } from "./readiness-inventory";
import { formatMonthYear } from "./timeline-dates";

export function ReadinessCard({
  readiness,
  onDismiss,
}: {
  readiness: TimelineReadinessResponse;
  onDismiss: () => void;
}) {
  const { t, tCount, locale } = useTranslations();
  const intl = resolveIntlLocale(locale);
  const { carrying, total } = readinessTally(readiness);
  const gaps = readinessGaps(readiness);
  const summary = readiness.since
    ? t("timeline.readiness.card.summary", {
        since: formatMonthYear(readiness.since, intl),
        carrying,
        total,
      })
    : t("timeline.readiness.meter", { carrying, total });

  return (
    <Card className="gap-2 py-3 md:py-4" data-slot="timeline-readiness-card">
      <CardHeader>
        <TileHeader
          size="sm"
          icon={Layers}
          title={t("timeline.readiness.card.title")}
          right={
            <Button
              variant="ghost"
              size="icon-sm"
              className="-my-1.5 -mr-1.5 size-11 sm:size-8"
              aria-label={t("timeline.readiness.card.dismiss")}
              onClick={onDismiss}
              data-slot="timeline-readiness-card-dismiss"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm">{summary}</p>
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {gaps.map((gap) => {
            const line = wordKey(
              t,
              tCount,
              `timeline.readiness.gapLine.${gap.key}`,
              { count: gap.count },
            );
            const link = wordKey(
              t,
              tCount,
              `timeline.readiness.gap.${gap.key}`,
              {
                count: gap.count,
              },
            );
            if (!line || !link) return null;
            return (
              <li
                key={`${gap.lane}-${gap.key}`}
                className="flex items-center justify-between gap-3 sm:justify-start"
              >
                <span className="text-sm">{line}</span>
                <Link
                  href={gap.href}
                  data-slot="timeline-readiness-gap"
                  data-gap={gap.key}
                  className="hover:bg-accent focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-0.5 rounded-md px-2 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 sm:min-h-8"
                >
                  {link}
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
