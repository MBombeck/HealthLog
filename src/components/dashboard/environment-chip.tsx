"use client";

/**
 * `<EnvironmentChip>` — the dashboard's quiet note about the newest stored
 * environment day (v1.42, #615): high pollen, a hot night, very poor air.
 *
 * Quiet by construction: it renders nothing unless one of the three flags in
 * `src/lib/environment/day-flags.ts` is set for that day, nothing while the
 * environment module is off, and nothing for an air-quality flag the feed did
 * not cover (an unfetched day is not clean air). It names the day it is about,
 * because the archive behind it settles a few days late: the newest stored day
 * is usually yesterday or the day before, never a forecast for today, and the
 * chip never asks one.
 *
 * Not a dashboard widget: it has no widget id and no place in the layout
 * contract the iOS client shares. It reads the module overview through the
 * same query the settings section uses.
 */
import { useQuery } from "@tanstack/react-query";
import { CloudSun } from "lucide-react";

import { TagChip } from "@/components/ui/tag-chip";
import {
  DAY_LINK_SLOT,
  DayLink,
  withDayLinkSlot,
} from "@/components/day/day-link";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import {
  highPollenKinds,
  isHotNight,
  isVeryPoorAir,
  type PollenByKind,
} from "@/lib/environment/day-flags";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/** The slice of `GET /api/environment` the chip reads. */
export interface EnvironmentChipOverview {
  latestDay: {
    date: string;
    tempMin: number | null;
    airQuality: {
      eaqiMax: number | null;
      pollen: PollenByKind;
    } | null;
  } | null;
}

/** The flags a day raises, as i18n keys with their values. Pure. */
export function environmentChipFlags(
  day: NonNullable<EnvironmentChipOverview["latestDay"]>,
): Array<
  | { kind: "pollen"; kinds: string[] }
  | { kind: "hotNight" }
  | { kind: "veryPoorAir" }
> {
  const flags: ReturnType<typeof environmentChipFlags> = [];
  const air = day.airQuality;
  if (air) {
    const kinds = highPollenKinds(air.pollen);
    if (kinds.length > 0) flags.push({ kind: "pollen", kinds });
  }
  if (isHotNight(day.tempMin)) {
    flags.push({ kind: "hotNight" });
  }
  if (air && isVeryPoorAir(air.eaqiMax)) flags.push({ kind: "veryPoorAir" });
  return flags;
}

export function EnvironmentChip() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const enabled = user?.modules?.environment === true;

  const overview = useQuery({
    queryKey: queryKeys.environment(),
    enabled,
    queryFn: () => apiGet<EnvironmentChipOverview>("/api/environment"),
    staleTime: 30 * 60 * 1000,
  });

  const day = overview.data?.latestDay;
  if (!enabled || !day) return null;
  const flags = environmentChipFlags(day);
  if (flags.length === 0) return null;

  // A stated calendar day, read as that day wherever the person is.
  const date = fmt.dateShortSmartCalendar(day.date);
  return (
    <div
      data-slot="environment-chip"
      className="flex flex-wrap items-center gap-2"
    >
      <CloudSun className="text-muted-foreground size-4" aria-hidden />
      <span className="text-muted-foreground text-xs">
        {/* v1.42 — the date opens the day it names, the one thing every
            date in the app does. */}
        {withDayLinkSlot(
          t("environment.chip.day", { date: DAY_LINK_SLOT }),
          <DayLink date={day.date} size="xs">
            {date}
          </DayLink>,
        )}
      </span>
      {flags.map((flag) => (
        <TagChip key={flag.kind} data-flag={flag.kind}>
          {flag.kind === "pollen"
            ? t("environment.chip.pollenHigh", {
                kinds: flag.kinds
                  .map((kind) => t(`environment.pollen.${kind}`))
                  .join(", "),
              })
            : flag.kind === "hotNight"
              ? t("environment.chip.hotNight")
              : t("environment.chip.veryPoorAir")}
        </TagChip>
      ))}
    </div>
  );
}
