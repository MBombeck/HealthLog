"use client";

import { useQuery } from "@tanstack/react-query";
import { Info, Leaf } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { NUTRIENT_SOURCE_LABEL_KEYS } from "@/lib/i18n/source-labels";
import { formatNutrientAmount } from "@/lib/nutrients/format-amount";
import { queryKeys } from "@/lib/query-keys";
import { binaryReferenceSex } from "@/lib/profile/sex";
import {
  NUTRIENT_CATALOG,
  isNutrientCode,
  nutrientCodesInGroup,
  resolveNutrientReference,
  type NutrientCode,
  type NutrientGroup,
} from "@/lib/nutrients/catalog";
import type {
  NutrientAmountBySource,
  NutrientIntakeOverview,
  NutrientOverviewRow,
} from "./types";
import { nutrientUnitLabel } from "./unit-label";

const WINDOW_DAYS = 30;

/**
 * The groups this card lists, in the order it lists them, each under its own
 * section label. Water, caffeine, alcohol and energy with the macros ride
 * their own cards.
 */
const MICRONUTRIENT_GROUPS: ReadonlyArray<NutrientGroup> = [
  "vitamin",
  "mineral",
  "omega3",
];
const MICRONUTRIENT_CODES = nutrientCodesInGroup(...MICRONUTRIENT_GROUPS);

/** The sources in the order the split reads, each with its bar colour. */
const SOURCES = [
  { key: "APPLE_HEALTH", color: "var(--chart-1)" },
  { key: "MANUAL", color: "var(--chart-2)" },
  { key: "SUPPLEMENT", color: "var(--chart-3)" },
  { key: "EXTERNAL", color: "var(--chart-4)" },
  { key: "HEALTH_CONNECT", color: "var(--chart-5)" },
] as const;

/**
 * The latest day split by source: a thin bar and a legend whose parts
 * each carry the swatch of their bar segment, so five possible sources stay
 * readable. Source names are the app's own ("Apple Health", "Manual",
 * "External device"). Shown only when the day has more than one source or a
 * supplement share, because a single synced total has nothing to split.
 */
function SourceSplit({
  bySource,
  unitLabel,
}: {
  bySource: NutrientAmountBySource;
  unitLabel: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const parts = SOURCES.filter((s) => (bySource[s.key] ?? 0) > 0);
  const total = parts.reduce((sum, s) => sum + (bySource[s.key] ?? 0), 0);
  if (total <= 0 || (parts.length < 2 && !bySource.SUPPLEMENT)) return null;
  const labelled = parts.map((s) => ({
    ...s,
    text: t("nutrients.micronutrients.sourcePart", {
      source: t(NUTRIENT_SOURCE_LABEL_KEYS[s.key]),
      value: formatNutrientAmount(fmt, bySource[s.key] ?? 0),
      unit: unitLabel,
    }),
  }));
  const legend = labelled.map((s) => s.text).join(", ");
  return (
    <div className="space-y-1" data-slot="nutrients-source-split">
      <div
        className="bg-muted flex h-1.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={legend}
      >
        {parts.map((s) => (
          <span
            key={s.key}
            className="h-full"
            style={{
              width: `${((bySource[s.key] ?? 0) / total) * 100}%`,
              backgroundColor: s.color,
            }}
          />
        ))}
      </div>
      <ul
        className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums"
        aria-hidden="true"
      >
        {labelled.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * v1.43 — the calm note the server's upper-limit verdict earns: the level,
 * whether it covers the supplement share only, and where it comes from.
 */
function UpperLimitNote({
  row,
  unitLabel,
}: {
  row: NutrientOverviewRow;
  unitLabel: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const limit = row.upperLimit;
  if (!limit || row.latestAboveUpperLimit !== true) return null;
  return (
    <p
      className="flex items-start gap-1.5 text-xs"
      data-slot="nutrients-upper-limit-note"
    >
      <Info
        aria-hidden="true"
        className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
      />
      <span>
        {t(
          limit.scope === "supplemental"
            ? "nutrients.micronutrients.aboveUpperLimitSupplemental"
            : "nutrients.micronutrients.aboveUpperLimit",
          {
            value: formatNutrientAmount(fmt, limit.value),
            unit: unitLabel,
            source: limit.source,
          },
        )}
        {limit.form
          ? ` ${t(`nutrients.micronutrients.upperLimitForm.${limit.form}`)}`
          : null}
      </span>
    </p>
  );
}

/**
 * v1.29 — micronutrients card on `/insights/nutrients`.
 *
 * Rows ONLY for codes with data in the last 30 days (catalog order),
 * each carrying a latest-day total + a muted "N of 30 days · ref X
 * (authority)" meta line — reference omitted when the profile has no sex on
 * file. A muted footer counts "M of N tracked"; zero rows collapse the
 * card to a single honest `EmptyState`, never a column of empty rows. No
 * sparkline in slice 1 — sparse series make sparklines lie.
 */
export function MicronutrientsCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const sex = binaryReferenceSex(user?.gender);

  // A failed read left `data` undefined, `rows` empty, and the card rendered
  // its "no micronutrient data" EmptyState — the same output as an account that
  // genuinely logs no nutrients. The sibling hydration card already routes
  // through QueryErrorCard; this one now matches it.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.nutrientIntake(WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientIntakeOverview>(`/api/nutrients?days=${WINDOW_DAYS}`),
  });

  const rows = (data?.nutrients ?? []).filter(
    (row) =>
      isNutrientCode(row.nutrient) &&
      MICRONUTRIENT_GROUPS.includes(NUTRIENT_CATALOG[row.nutrient].group),
  );

  return (
    <Card data-slot="nutrients-micronutrients-card">
      <CardHeader>
        <TileHeader icon={Leaf} title={t("nutrients.micronutrients.title")} />
      </CardHeader>
      <CardContent className="space-y-3">
        {isError ? (
          <QueryErrorRow
            inset
            error={error}
            slot="nutrients-micronutrients-error"
            message={t("nutrients.micronutrients.loadError")}
            onRetry={() => void refetch()}
          />
        ) : isLoading ? (
          <div className="space-y-1" aria-hidden="true">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Leaf className="size-6" />}
            title={t("nutrients.micronutrients.emptyTitle")}
          />
        ) : (
          <>
            {MICRONUTRIENT_GROUPS.map((group) => {
              const groupRows = rows.filter(
                (row) =>
                  NUTRIENT_CATALOG[row.nutrient as NutrientCode].group ===
                  group,
              );
              if (groupRows.length === 0) return null;
              const labelId = `nutrients-group-${group}`;
              return (
                <section
                  key={group}
                  aria-labelledby={labelId}
                  className="space-y-1.5"
                  data-slot="nutrients-micronutrient-group"
                >
                  <h3
                    id={labelId}
                    className="text-muted-foreground text-xs font-medium"
                  >
                    {t(`nutrients.micronutrients.groups.${group}`)}
                  </h3>
                  <ul
                    className="divide-border divide-y rounded-lg border"
                    role="list"
                  >
                    {groupRows.map((row) => {
                      const reference = resolveNutrientReference(
                        row.nutrient as NutrientCode,
                        sex,
                      );
                      const unitLabel = nutrientUnitLabel(row.unit, t);
                      return (
                        <li
                          key={row.nutrient}
                          data-slot="nutrients-micronutrient-row"
                          className="space-y-2 p-3"
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0 text-sm">
                              {t(`nutrients.names.${row.nutrient}`)}
                            </span>
                            <span className="shrink-0 text-sm font-medium tabular-nums">
                              {formatNutrientAmount(fmt, row.latestAmount)}{" "}
                              {unitLabel}
                            </span>
                          </div>
                          {/* Its own line: beside the name it took the row's
                              width and broke two-word names like "Vitamin C". */}
                          <p className="text-muted-foreground -mt-1.5 text-xs tabular-nums">
                            {reference
                              ? t("nutrients.micronutrients.rowMeta", {
                                  days: row.daysWithData,
                                  window: WINDOW_DAYS,
                                  value: formatNutrientAmount(
                                    fmt,
                                    reference.value,
                                  ),
                                  unit: unitLabel,
                                  authority: reference.authority,
                                })
                              : t("nutrients.micronutrients.rowMetaNoRef", {
                                  days: row.daysWithData,
                                  window: WINDOW_DAYS,
                                })}
                          </p>
                          {row.latestBySource && (
                            <SourceSplit
                              bySource={row.latestBySource}
                              unitLabel={unitLabel}
                            />
                          )}
                          <UpperLimitNote row={row} unitLabel={unitLabel} />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            <p className="text-muted-foreground text-xs">
              {t("nutrients.micronutrients.footer", {
                tracked: rows.length,
                total: MICRONUTRIENT_CODES.length,
              })}
            </p>
          </>
        )}
        <p className="text-muted-foreground text-sm">
          {t("nutrients.sparseNote")}
        </p>
      </CardContent>
    </Card>
  );
}
