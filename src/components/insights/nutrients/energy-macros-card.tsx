"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flame } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { NutrientDailyBarChartDynamic } from "@/components/charts/nutrient-daily-bar-chart-dynamic";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { useTargetAdjust } from "@/lib/insights/target-adjust-context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  nutrientCodesInGroup,
  type NutrientCode,
} from "@/lib/nutrients/catalog";
import { formatNutrientAmount } from "@/lib/nutrients/format-amount";
import { NutrientTargetSheet } from "./nutrient-target-sheet";
import type { NutrientDailySeries, NutrientIntakeOverview } from "./types";
import { nutrientUnitLabel } from "./unit-label";

const WINDOW_DAYS = 30;

/** Energy and the macros, in catalog order. */
const MACRO_CODES = nutrientCodesInGroup("energy_macro");

/**
 * Energy and macronutrients on `/insights/nutrients` (#1402).
 *
 * Renders only when one of the energy and macro codes has data in the
 * window; most accounts never log them. A select picks the code (only the
 * codes with data; six names do not fit one segmented row at 390 px, and a
 * metric picker is a select everywhere else), and one 30-day bar chart shows
 * it: the day's total as the content value, and a dashed line at the
 * person's own target when one is set, else at the dietary reference where
 * one exists (energy, fat and sugar have none). The value stays foreground
 * and the bars are never coloured by attainment (ui-standards.md): a day
 * above the line is a bar above a line.
 *
 * The target is set where every other insights target is: the header gear
 * of the page (`TargetAdjustButton`), which opens this card's sheet for the
 * chosen code. The card itself stays a read surface.
 */
export function EnergyMacrosCard() {
  const { t } = useTranslations();

  const overview = useQuery({
    queryKey: queryKeys.nutrientIntake(WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientIntakeOverview>(`/api/nutrients?days=${WINDOW_DAYS}`),
  });
  const logged = new Set(
    (overview.data?.nutrients ?? []).map((row) => row.nutrient),
  );
  const codes = MACRO_CODES.filter((code) => logged.has(code));
  const [picked, setPicked] = useState<NutrientCode | null>(null);
  const code = picked && codes.includes(picked) ? picked : (codes[0] ?? null);

  // The page shows the overview's own failure; this card adds nothing then.
  if (!code) return null;

  return (
    <Card data-slot="nutrients-energy-macros-card">
      <CardHeader>
        <TileHeader icon={Flame} title={t("nutrients.macros.title")} />
      </CardHeader>
      <CardContent className="space-y-4">
        {codes.length > 1 ? (
          <NativeSelect
            aria-label={t("nutrients.macros.pickLabel")}
            data-slot="nutrients-macros-pick"
            className="sm:w-56"
            value={code}
            onChange={(event) => setPicked(event.target.value as NutrientCode)}
          >
            {codes.map((c) => (
              <option key={c} value={c}>
                {t(`nutrients.names.${c}`)}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <MacroSeries key={code} code={code} />
      </CardContent>
    </Card>
  );
}

function MacroSeries({ code }: { code: NutrientCode }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [editing, setEditing] = useState(false);
  const adjust = useTargetAdjust();
  const register = adjust?.register;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.nutrientDaily(code, WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientDailySeries>(
        `/api/nutrients/daily?nutrient=${code}&days=${WINDOW_DAYS}`,
      ),
    staleTime: 60_000,
  });

  // The page header's gear edits the chosen code's target. Registered once
  // the series is in, so the gear never opens a sheet without its seed.
  const loaded = data !== undefined;
  useEffect(() => {
    if (!register || !loaded) return;
    return register({
      type: "NUTRIENT_TARGET",
      openEditor: () => setEditing(true),
    });
  }, [register, loaded]);

  if (isError && !data) {
    return (
      <QueryErrorRow
        inset
        error={error}
        slot="nutrients-macros-error"
        message={t("nutrients.macros.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-[240px] w-full" />
      </div>
    );
  }

  const unit = nutrientUnitLabel(data.unit, t);
  const name = t(`nutrients.names.${code}`);
  const today = data.days.at(-1)?.amount ?? 0;
  const target = data.personalTarget ?? null;
  const reference = data.reference;
  const lineValue = target?.value ?? reference?.value ?? null;

  let meta: string | null = null;
  if (target) {
    meta = t(
      target.direction === "limit"
        ? "nutrients.macros.limitMeta"
        : "nutrients.macros.targetMeta",
      { value: formatNutrientAmount(fmt, target.value), unit },
    );
  } else if (reference) {
    meta = t("nutrients.macros.referenceMeta", {
      value: formatNutrientAmount(fmt, reference.value),
      unit,
      authority: reference.authority ?? "EFSA",
    });
  }

  return (
    <div className="space-y-4" data-slot="nutrients-macros-series">
      <div className="space-y-1">
        <p
          className="text-2xl font-bold tabular-nums"
          data-slot="nutrients-macros-today"
        >
          {formatNutrientAmount(fmt, today)} {unit}
        </p>
        {meta ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="nutrients-macros-meta"
          >
            {meta}
          </p>
        ) : null}
      </div>
      <NutrientDailyBarChartDynamic
        days={data.days}
        unit={unit}
        valueLabel={name}
        referenceValue={lineValue}
        dayLinks
      />
      {editing ? (
        <NutrientTargetSheet
          code={code}
          name={name}
          unit={unit}
          windowDays={WINDOW_DAYS}
          current={target}
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        />
      ) : null}
    </div>
  );
}
