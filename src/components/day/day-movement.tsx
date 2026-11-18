"use client";

import type { DayResponse } from "@/lib/day/contract";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import { DAY_SECTION_LABEL } from "./day-sections";

type DayMovement = NonNullable<DayResponse["movement"]>;

/**
 * "On the move": the day's movement context from Dawarich, as the server
 * resolved it. Distances arrive in the account's unit; a field the day has no
 * value for is left out, never shown as zero. The country of a travel day is
 * named in the reader's language.
 */
export function DayMovementSection({
  movement,
}: {
  movement: DayMovement | null | undefined;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  if (!movement) return null;
  const unit = movement.distance.unit;
  const distance = (value: number) =>
    t(unit === "mi" ? "day.movement.miles" : "day.movement.kilometres", {
      value: fmt.number(value, 1),
    });

  const rows: Array<{ key: string; label: string; value: string }> = [];
  if (movement.distance.total !== null) {
    rows.push({
      key: "total",
      label: t("day.movement.total"),
      value: distance(movement.distance.total),
    });
  }
  if (movement.distance.driving) {
    rows.push({
      key: "driving",
      label: t("day.movement.driving"),
      value: distance(movement.distance.driving),
    });
  }
  if (movement.distance.train) {
    rows.push({
      key: "train",
      label: t("day.movement.train"),
      value: distance(movement.distance.train),
    });
  }
  if (movement.placesVisited !== null) {
    rows.push({
      key: "places",
      label: t("day.movement.places"),
      value: fmt.number(movement.placesVisited, 0),
    });
  }
  if (movement.awayFromHomeMinutes !== null) {
    rows.push({
      key: "away",
      label: t("day.movement.away"),
      value: formatDurationMinutes(movement.awayFromHomeMinutes, t),
    });
  }
  if (movement.travel?.isTravelDay) {
    const code = movement.travel.countryCode;
    rows.push({
      key: "travel",
      label: t("day.movement.travel"),
      value: code ? countryName(code, locale) : t("day.movement.travelYes"),
    });
  }
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2" data-slot="day-movement">
      <h3 className={DAY_SECTION_LABEL}>{t("day.groups.movement")}</h3>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        {rows.map((row) => (
          <div key={row.key} className="min-w-0" data-movement={row.key}>
            <dt className="text-muted-foreground truncate text-xs">
              {row.label}
            </dt>
            <dd className="truncate text-sm tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
