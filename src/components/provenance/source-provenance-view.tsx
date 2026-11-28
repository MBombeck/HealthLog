"use client";

import { useState } from "react";
import Link from "next/link";
import { GitCompareArrows, Layers } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAction } from "@/components/ui/inline-action";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { TagChip } from "@/components/ui/tag-chip";
import {
  useDayProvenance,
  useSourceComparison,
} from "@/hooks/use-source-provenance";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS } from "@/lib/i18n/source-labels";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import {
  PROVENANCE_TYPES,
  type ProvenanceType,
} from "@/lib/provenance/ranked-types";
import { shiftDateKey } from "@/lib/tz/format";

type RangeDays = "30" | "90" | "365";

/**
 * Today as a UTC day key: the source ladder picks per UTC day, so the page
 * names its days the way the pick cuts them.
 */
function utcToday(): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the ladder pick is per UTC day, and this page explains that pick
  return new Date().toISOString().slice(0, 10);
}

/**
 * The provenance view (#1204, #1108, #576): for one metric, which sources
 * delivered values on a day, which one the source priority picked and why,
 * and two sources side by side over a range. Read-only; the settings that
 * decide the pick stay in Settings > Source priority.
 */
export function SourceProvenanceView({
  initialType,
  initialDate,
}: {
  initialType: ProvenanceType;
  initialDate: string | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [type, setType] = useState<ProvenanceType>(initialType);
  const [date, setDate] = useState<string>(initialDate ?? utcToday());
  const [range, setRange] = useState<RangeDays>("30");
  const [a, setA] = useState<string | undefined>(undefined);
  const [b, setB] = useState<string | undefined>(undefined);
  const to = utcToday();
  const from = shiftDateKey(to, -(Number(range) - 1));

  const day = useDayProvenance(type, date);
  const compare = useSourceComparison({ type, from, to, a, b });

  const sourceLabel = (source: string) => {
    const key =
      MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS[
        source as keyof typeof MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS
      ];
    return key ? t(key) : source;
  };
  const typeLabel = (value: ProvenanceType) =>
    t(MEASUREMENT_TYPE_LABEL_KEYS[value]);
  const sortedTypes = [...PROVENANCE_TYPES].sort((x, y) =>
    typeLabel(x).localeCompare(typeLabel(y)),
  );

  const formatValue = (value: number | null, aggregation: "sum" | "mean") =>
    value === null
      ? "–"
      : aggregation === "sum"
        ? fmt.integer(Math.round(value))
        : fmt.number(value, 1);

  return (
    <div className="space-y-6" data-slot="source-provenance">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="provenance-type">
            {t("sourceProvenance.metric")}
          </Label>
          <NativeSelect
            id="provenance-type"
            data-slot="provenance-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value as ProvenanceType);
              setA(undefined);
              setB(undefined);
            }}
          >
            {sortedTypes.map((value) => (
              <option key={value} value={value}>
                {typeLabel(value)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="provenance-date">{t("sourceProvenance.day")}</Label>
          <DateField
            id="provenance-date"
            value={date}
            max={to}
            onChange={(value) => value && setDate(value)}
          />
        </div>
      </div>

      <Card data-slot="provenance-day">
        <CardHeader>
          <TileHeader icon={Layers} title={t("sourceProvenance.dayTitle")} />
        </CardHeader>
        <CardContent className="space-y-3">
          {day.isError ? (
            <QueryErrorRow
              inset
              error={day.error}
              message={t("sourceProvenance.loadError")}
              onRetry={() => day.refetch()}
            />
          ) : !day.data ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : day.data.sources.length === 0 ? (
            <EmptyState
              variant="plain"
              title={t("sourceProvenance.dayEmpty")}
              data-slot="provenance-day-empty"
            />
          ) : (
            <>
              <p className="text-sm" data-slot="provenance-verdict">
                {day.data.pickReason === "not_ranked"
                  ? t("sourceProvenance.reason.not_ranked")
                  : t(
                      `sourceProvenance.reason.${day.data.pickReason ?? "only_source"}`,
                      {
                        source: sourceLabel(day.data.picked ?? ""),
                      },
                    )}
              </p>
              <ul className="divide-border divide-y rounded-lg border">
                {day.data.sources.map((row) => (
                  <li
                    key={row.source}
                    data-slot="provenance-source-row"
                    data-source={row.source}
                    data-picked={
                      row.source === day.data?.picked ? "true" : "false"
                    }
                    className="flex items-start justify-between gap-3 p-3"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {sourceLabel(row.source)}
                        {row.source === day.data?.picked ? (
                          <TagChip>{t("sourceProvenance.used")}</TagChip>
                        ) : null}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t("sourceProvenance.readings", {
                          count: fmt.integer(row.readings),
                          devices: row.devices.join(", "),
                        })}
                      </p>
                      {row.pass ? (
                        <p className="text-muted-foreground text-xs">
                          {t(`sourceProvenance.pass.${row.pass}`)}
                        </p>
                      ) : null}
                    </div>
                    <p className="shrink-0 text-sm tabular-nums">
                      {formatValue(row.value, day.data?.aggregation ?? "mean")}{" "}
                      <span className="text-muted-foreground text-xs">
                        {row.unit}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
              {day.data.ranked ? (
                <p className="text-muted-foreground text-xs">
                  {t("sourceProvenance.ladder", {
                    ladder: day.data.ladder.map(sourceLabel).join(", "),
                  })}
                </p>
              ) : null}
              <p className="text-muted-foreground text-xs">
                {t("sourceProvenance.utcNote")}
              </p>
            </>
          )}
          <InlineAction asChild tone="primary" size="xs">
            <Link href="/settings/sources" data-slot="provenance-settings-link">
              {t("sourceProvenance.openSettings")}
            </Link>
          </InlineAction>
        </CardContent>
      </Card>

      <Card data-slot="provenance-compare">
        <CardHeader>
          <TileHeader
            icon={GitCompareArrows}
            title={t("sourceProvenance.compareTitle")}
            right={
              <Segmented
                size="sm"
                label={t("sourceProvenance.range")}
                slot="provenance-range"
                value={range}
                onChange={setRange}
                // The charts' short range labels ("30d"), spelled out in
                // the title: three long ones beside the title push the card
                // past a 390 px phone.
                options={(["30", "90", "365"] as const).map((days) => ({
                  value: days,
                  label: t("charts.daysNLabel", { days }),
                  title: t("sourceProvenance.rangeDays", { days }),
                }))}
              />
            }
          />
        </CardHeader>
        <CardContent className="space-y-4">
          {compare.isError ? (
            <QueryErrorRow
              inset
              error={compare.error}
              message={t("sourceProvenance.loadError")}
              onRetry={() => compare.refetch()}
            />
          ) : !compare.data ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : compare.data.sources.length < 2 ? (
            <EmptyState
              variant="plain"
              title={t("sourceProvenance.compareNeedsTwo")}
              data-slot="provenance-compare-empty"
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                {(["a", "b"] as const).map((side) => (
                  <div key={side} className="grid gap-1.5">
                    <Label htmlFor={`provenance-${side}`}>
                      {t(`sourceProvenance.side.${side}`)}
                    </Label>
                    <NativeSelect
                      id={`provenance-${side}`}
                      data-slot={`provenance-${side}`}
                      value={
                        (side === "a" ? compare.data?.a : compare.data?.b) ?? ""
                      }
                      onChange={(e) =>
                        side === "a"
                          ? setA(e.target.value)
                          : setB(e.target.value)
                      }
                    >
                      {compare.data?.sources.map((s) => (
                        <option key={s.source} value={s.source}>
                          {sourceLabel(s.source)}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ))}
              </div>
              <dl
                className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm"
                data-slot="provenance-compare-summary"
              >
                <dt className="text-muted-foreground text-xs">
                  {t("sourceProvenance.daysBoth")}
                </dt>
                <dd className="tabular-nums">
                  {fmt.integer(compare.data.summary.daysBoth)}
                </dd>
                <dt className="text-muted-foreground text-xs">
                  {t("sourceProvenance.meanOf", {
                    source: sourceLabel(compare.data.a ?? ""),
                  })}
                </dt>
                <dd className="tabular-nums">
                  {formatValue(
                    compare.data.summary.meanA,
                    compare.data.aggregation,
                  )}
                </dd>
                <dt className="text-muted-foreground text-xs">
                  {t("sourceProvenance.meanOf", {
                    source: sourceLabel(compare.data.b ?? ""),
                  })}
                </dt>
                <dd className="tabular-nums">
                  {formatValue(
                    compare.data.summary.meanB,
                    compare.data.aggregation,
                  )}
                </dd>
                <dt className="text-muted-foreground text-xs">
                  {t("sourceProvenance.meanAbsDiff")}
                </dt>
                <dd className="tabular-nums">
                  {formatValue(
                    compare.data.summary.meanAbsoluteDifference,
                    "mean",
                  )}{" "}
                  <span className="text-muted-foreground text-xs">
                    {compare.data.unit}
                  </span>
                </dd>
                <dt className="text-muted-foreground text-xs">
                  {t("sourceProvenance.pickedDays")}
                </dt>
                <dd className="tabular-nums">
                  {t("sourceProvenance.pickedSplit", {
                    a: fmt.integer(compare.data.summary.pickedA),
                    b: fmt.integer(compare.data.summary.pickedB),
                  })}
                </dd>
              </dl>
              <div className="max-h-80 overflow-y-auto overscroll-contain rounded-lg border">
                <table
                  className="w-full text-sm"
                  data-slot="provenance-compare-table"
                >
                  <thead className="bg-muted text-muted-foreground sticky top-0 text-xs">
                    <tr>
                      <th scope="col" className="p-2 text-left font-medium">
                        {t("sourceProvenance.day")}
                      </th>
                      <th scope="col" className="p-2 text-right font-medium">
                        {sourceLabel(compare.data.a ?? "")}
                      </th>
                      <th scope="col" className="p-2 text-right font-medium">
                        {sourceLabel(compare.data.b ?? "")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {[...compare.data.days].reverse().map((d) => (
                      <tr key={d.date} data-slot="provenance-compare-row">
                        <th scope="row" className="p-2 text-left font-normal">
                          <InlineAction
                            type="button"
                            tone="primary"
                            size="sm"
                            data-slot="provenance-compare-day"
                            onClick={() => setDate(d.date)}
                          >
                            {fmt.dateShortSmartCalendar(d.date)}
                          </InlineAction>
                        </th>
                        {(["a", "b"] as const).map((side) => {
                          const source = compare.data?.[side];
                          const used = source !== null && d.picked === source;
                          return (
                            <td
                              key={side}
                              className={
                                used
                                  ? "p-2 text-right font-semibold tabular-nums"
                                  : "p-2 text-right tabular-nums"
                              }
                            >
                              {formatValue(
                                d[side],
                                compare.data?.aggregation ?? "mean",
                              )}
                              {used ? (
                                <span className="sr-only">
                                  {" "}
                                  {t("sourceProvenance.used")}
                                </span>
                              ) : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("sourceProvenance.compareNote")}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
