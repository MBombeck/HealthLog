"use client";

import Link from "next/link";

import type { DayResponse } from "@/lib/day/contract";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { GKI_COMPONENT_UNIT } from "@/lib/measurements/glucose-ketone-index";

type DayGki = NonNullable<DayResponse["glucoseKetoneIndex"]>[number];

/**
 * The day's glucose-ketone index (#1367), one tile beside the value tiles.
 * Every figure is the server's: the index and the two readings it was built
 * from. A day with one fingerstick shows its index and the pair; a day with
 * several shows the latest index and how many there were, and the ketones page
 * lists each. Nothing grades the number.
 */
export function DayGkiTile({ points }: { points: readonly DayGki[] }) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();
  const latest = points[points.length - 1];
  if (!latest) return null;
  return (
    <li data-slot="day-gki" className="flex min-w-0">
      <Link
        href="/insights/ketones"
        data-slot="day-value-link"
        className="bg-muted/60 hover:bg-muted focus-visible:ring-ring/50 flex min-h-11 w-full min-w-0 flex-col rounded-lg px-3 py-2.5 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
      >
        <span className="text-muted-foreground truncate text-xs">
          {t("measurements.glucoseKetoneIndex")}
        </span>
        <span className="truncate text-base font-semibold tabular-nums">
          {fmt.number(latest.value, 1)}
        </span>
        <span className="text-muted-foreground truncate text-xs tabular-nums">
          {points.length > 1
            ? tCount("day.gkiCount", points.length)
            : t("day.gkiPair", {
                glucose: fmt.number(latest.glucoseMmol, 1),
                ketones: fmt.number(latest.ketonesMmol, 1),
                unit: GKI_COMPONENT_UNIT,
              })}
        </span>
      </Link>
    </li>
  );
}
