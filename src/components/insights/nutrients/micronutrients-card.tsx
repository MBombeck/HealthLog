"use client";

import { useQuery } from "@tanstack/react-query";
import { Info, Leaf } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
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
 * The groups this card lists. Water, caffeine, alcohol and energy with the
 * macros ride their own cards.
 */
const MICRONUTRIENT_GROUPS: ReadonlyArray<NutrientGroup> = [
  "vitamin",
  "mineral",
  "omega3",
];
const MICRONUTRIENT_CODES = nutrientCodesInGroup(...MICRONUTRIENT_GROUPS);

function formatAmount(
  fmt: { number: (v: number, d?: number) => string },
  amount: number,
): string {
  return fmt.number(Math.round(amount * 10) / 10, 1);
}

/** The sources in the order the split reads, each with its bar colour. */
const SOURCES = [
  { key: "APPLE_HEALTH", color: "var(--chart-1)" },
  { key: "MANUAL", color: "var(--chart-2)" },
  { key: "SUPPLEMENT", color: "var(--chart-3)" },
  { key: "EXTERNAL", color: "var(--chart-4)" },
  { key: "HEALTH_CONNECT", color: "var(--chart-5)" },
] as const;

/**
 * v1.43 — the latest day split by source: a thin bar and a one-line legend.
 * Shown only when the day has more than one source or a supplement share,
 * because a single synced total has nothing to split.
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
  const legend = parts
    .map((s) =>
      t("nutrients.micronutrients.sourcePart", {
        source: t(`nutrients.sources.${s.key}`),
        value: formatAmount(fmt, bySource[s.key] ?? 0),
        unit: unitLabel,
      }),
    )
    .join(", ");
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
      <p className="text-muted-foreground text-xs tabular-nums">{legend}</p>
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
            value: formatAmount(fmt, limit.value),
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
          <QueryErrorCard
            error={error}
            title={t("nutrients.micronutrients.loadError")}
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
            size="compact"
          />
        ) : (
          <>
            <ul
              className="divide-border divide-y rounded-md border"
              role="list"
            >
              {rows.map((row) => {
                const reference = resolveNutrientReference(
                  row.nutrient as NutrientCode,
                  sex,
                );
                const unitLabel = nutrientUnitLabel(row.unit, t);
                return (
                  <li
                    key={row.nutrient}
                    data-slot="nutrients-micronutrient-row"
                    className="space-y-2 p-2"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm">
                        {t(`nutrients.names.${row.nutrient}`)}
                      </span>
                      <span className="flex flex-col items-end gap-0.5 text-right">
                        <span className="text-sm font-medium tabular-nums">
                          {formatAmount(fmt, row.latestAmount)} {unitLabel}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {reference
                            ? t("nutrients.micronutrients.rowMeta", {
                                days: row.daysWithData,
                                window: WINDOW_DAYS,
                                value: formatAmount(fmt, reference.value),
                                unit: unitLabel,
                                authority: reference.authority,
                              })
                            : t("nutrients.micronutrients.rowMetaNoRef", {
                                days: row.daysWithData,
                                window: WINDOW_DAYS,
                              })}
                        </span>
                      </span>
                    </div>
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
