"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { NutrientDailyBarChartDynamic } from "@/components/charts/nutrient-daily-bar-chart-dynamic";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  NUTRIENT_CATALOG,
  nutrientCodesInGroup,
  type NutrientCode,
} from "@/lib/nutrients/catalog";
import type {
  NutrientDailySeries,
  NutrientIntakeOverview,
  NutrientPersonalTargetDto,
} from "./types";
import { nutrientUnitLabel } from "./unit-label";

const WINDOW_DAYS = 30;

/** Energy and the macros, in catalog order. */
const MACRO_CODES = nutrientCodesInGroup("energy_macro");

function formatAmount(
  fmt: { number: (v: number, d?: number) => string },
  amount: number,
): string {
  return fmt.number(Math.round(amount * 10) / 10, 1);
}

/**
 * Energy and macronutrients on `/insights/nutrients` (#1402).
 *
 * Renders only when one of the energy and macro codes has data in the
 * window; most accounts never log them. A segmented row picks the code (only
 * the codes with data), and one 30-day bar chart shows it: the day's total
 * as the content value, and a dashed line at the person's own target when
 * one is set, else at the dietary reference where one exists (energy, fat
 * and sugar have none). The value stays foreground and the bars are never
 * coloured by attainment (ui-standards.md): a day above the line is a bar
 * above a line. The person sets or clears a target for the chosen code
 * inline.
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
          <Segmented
            size="sm"
            className="flex-wrap"
            options={codes.map((c) => ({
              value: c,
              label: t(`nutrients.macros.short.${c}`),
            }))}
            value={code}
            onChange={setPicked}
            label={t("nutrients.macros.pickLabel")}
            slot="nutrients-macros-pick"
          />
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

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.nutrientDaily(code, WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientDailySeries>(
        `/api/nutrients/daily?nutrient=${code}&days=${WINDOW_DAYS}`,
      ),
    staleTime: 60_000,
  });

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
      { value: formatAmount(fmt, target.value), unit },
    );
  } else if (reference) {
    meta = t("nutrients.macros.referenceMeta", {
      value: formatAmount(fmt, reference.value),
      unit,
      authority: reference.authority ?? "EFSA",
    });
  }

  return (
    <div className="space-y-4" data-slot="nutrients-macros-series">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p
            className="text-2xl font-bold tabular-nums"
            data-slot="nutrients-macros-today"
          >
            {formatAmount(fmt, today)} {unit}
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
        {editing ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            data-slot="nutrients-macros-edit-target"
          >
            {t(
              target
                ? "nutrients.macros.editTarget"
                : "nutrients.macros.setTarget",
            )}
          </Button>
        )}
      </div>
      {editing ? (
        <TargetEditor
          code={code}
          name={name}
          unit={unit}
          current={target}
          onDone={() => setEditing(false)}
        />
      ) : null}
      <NutrientDailyBarChartDynamic
        days={data.days}
        unit={unit}
        valueLabel={name}
        referenceValue={lineValue}
        dayLinks
      />
    </div>
  );
}

/**
 * Set or clear the person's daily amount for one code: a number in the code's
 * canonical unit and whether it is an amount to reach or one to stay under.
 */
function TargetEditor({
  code,
  name,
  unit,
  current,
  onDone,
}: {
  code: NutrientCode;
  name: string;
  unit: string;
  current: NutrientPersonalTargetDto | null;
  onDone: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(current ? String(current.value) : "");
  const [direction, setDirection] = useState<"target" | "limit">(
    current?.direction ?? "target",
  );
  const [saving, setSaving] = useState(false);
  const inputId = `nutrient-target-${code}`;

  const parsed = Number(value.replace(",", "."));
  const valid =
    value.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed > 0 &&
    parsed <= NUTRIENT_CATALOG[code].plausibleDailyMax;

  async function save(next: NutrientPersonalTargetDto | null) {
    setSaving(true);
    try {
      await apiPatch("/api/nutrients/targets", { targets: { [code]: next } });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.nutrientTargets(),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.nutrientDaily(code, WINDOW_DAYS),
        }),
      ]);
      onDone();
    } catch {
      toast.error(t("nutrients.macros.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="bg-muted/40 space-y-3 rounded-lg border p-3"
      data-slot="nutrients-macros-target-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save({ value: parsed, direction });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>
          {t("nutrients.macros.targetLabel", { name, unit })}
        </Label>
        <Input
          id={inputId}
          inputMode="decimal"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={value.trim() !== "" && !valid}
          className="max-w-40"
        />
      </div>
      <Segmented
        mode="toggle"
        size="sm"
        options={[
          { value: "target", label: t("nutrients.macros.directionTarget") },
          { value: "limit", label: t("nutrients.macros.directionLimit") },
        ]}
        value={direction}
        onChange={setDirection}
        label={t("nutrients.macros.directionLabel")}
        slot="nutrients-macros-direction"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!valid || saving}>
          {t("common.save")}
        </Button>
        {current ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void save(null)}
          >
            {t("nutrients.macros.clearTarget")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={onDone}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
