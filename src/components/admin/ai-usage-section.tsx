"use client";

/**
 * v1.43 (#1217) — the operator's AI usage bounds.
 *
 * The operator pays for the shared key, so the operator sets the highest
 * level an account may choose and the level an account without a choice runs
 * at; each person picks within that under Settings > AI. Beside them, the
 * gap between two status-card regenerations after a sync at `standard`
 * (whole hours, 1 to 48; empty follows `AI_SYNC_REGEN_GAP_HOURS`, else six).
 *
 * Reads and writes the `aiUsage` block of the assistant-flags route, the same
 * query the assistant switches use. Lowering the ceiling caps every account
 * above it at once; their stored choice is kept.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { toast } from "sonner";

import { showErrorToast } from "@/lib/errors/error-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  AI_USAGE_LEVELS,
  SYNC_REGEN_GAP_HOURS_MAX,
  SYNC_REGEN_GAP_HOURS_MIN,
  usageLevelRank,
  type AiUsageLevel,
} from "@/lib/ai/usage-level";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

interface AiUsageBounds {
  maxLevel: AiUsageLevel;
  defaultLevel: AiUsageLevel;
  syncRegenGapHours: number | null;
  effectiveSyncRegenGapHours: number;
}

const LEVEL_LABEL_KEYS = {
  frugal: "settings.ai.usage.levels.frugal.label",
  standard: "settings.ai.usage.levels.standard.label",
  full: "settings.ai.usage.levels.full.label",
} as const satisfies Record<AiUsageLevel, string>;

export function AiUsageSection() {
  const { t } = useTranslations();
  const { data } = useQuery({
    queryKey: queryKeys.adminAssistantFlags(),
    queryFn: () =>
      apiGet<{ aiUsage?: AiUsageBounds }>(
        "/api/admin/settings/assistant-flags",
      ),
  });
  const bounds = data?.aiUsage;
  if (!bounds) {
    return (
      <SettingsCard>
        <SettingsCardHeader
          icon={Gauge}
          title={t("admin.aiUsage.title")}
          description={t("admin.aiUsage.description")}
        />
      </SettingsCard>
    );
  }
  // Keyed on the stored values, so a save (or another operator's) re-seeds
  // the form instead of leaving it on stale edits.
  return (
    <AiUsageForm
      key={`${bounds.maxLevel}:${bounds.defaultLevel}:${bounds.syncRegenGapHours}`}
      bounds={bounds}
    />
  );
}

function AiUsageForm({ bounds }: { bounds: AiUsageBounds }) {
  const { t } = useTranslations();
  const client = useQueryClient();
  const [maxLevel, setMaxLevel] = useState<AiUsageLevel>(bounds.maxLevel);
  const [defaultLevel, setDefaultLevel] = useState<AiUsageLevel>(
    bounds.defaultLevel,
  );
  const [gap, setGap] = useState(
    bounds.syncRegenGapHours === null ? "" : String(bounds.syncRegenGapHours),
  );

  const gapValue = gap.trim() === "" ? null : Number(gap);
  const gapValid =
    gapValue === null ||
    (Number.isInteger(gapValue) &&
      gapValue >= SYNC_REGEN_GAP_HOURS_MIN &&
      gapValue <= SYNC_REGEN_GAP_HOURS_MAX);
  const defaultAbove = usageLevelRank(defaultLevel) > usageLevelRank(maxLevel);

  const save = useMutation({
    mutationFn: () =>
      apiPut<{ aiUsage: AiUsageBounds }>(
        "/api/admin/settings/assistant-flags",
        {
          aiUsage: { maxLevel, defaultLevel, syncRegenGapHours: gapValue },
        },
      ),
    onSuccess: (result) => {
      client.setQueryData(queryKeys.adminAssistantFlags(), result);
      void client.invalidateQueries({
        queryKey: queryKeys.adminProviderHealth(),
      });
      void invalidateKeys(client, aiInputDependentKeys);
      toast.success(t("common.saved"));
    },
    onError: (err) => {
      showErrorToast(localizedApiError(err, t, "admin.settingsSaveError"), {
        cause: err,
      });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!gapValid || defaultAbove) return;
    save.mutate();
  }

  return (
    <SettingsCard data-slot="admin-ai-usage">
      <SettingsCardHeader
        icon={Gauge}
        title={t("admin.aiUsage.title")}
        description={t("admin.aiUsage.description")}
      />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="admin-ai-usage-max">
              {t("admin.aiUsage.maxLabel")}
            </Label>
            <NativeSelect
              id="admin-ai-usage-max"
              value={maxLevel}
              disabled={save.isPending}
              onChange={(e) => setMaxLevel(e.target.value as AiUsageLevel)}
            >
              {AI_USAGE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(LEVEL_LABEL_KEYS[level])}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-ai-usage-default">
              {t("admin.aiUsage.defaultLabel")}
            </Label>
            <NativeSelect
              id="admin-ai-usage-default"
              value={defaultLevel}
              disabled={save.isPending}
              aria-invalid={defaultAbove || undefined}
              onChange={(e) => setDefaultLevel(e.target.value as AiUsageLevel)}
            >
              {AI_USAGE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(LEVEL_LABEL_KEYS[level])}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        {defaultAbove ? (
          <p role="alert" className="text-destructive text-xs">
            {t("admin.aiUsage.defaultAboveCeiling")}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="admin-ai-usage-gap" className="block leading-snug">
            {t("admin.aiUsage.gapLabel")}
          </Label>
          <Input
            id="admin-ai-usage-gap"
            type="number"
            inputMode="numeric"
            min={SYNC_REGEN_GAP_HOURS_MIN}
            max={SYNC_REGEN_GAP_HOURS_MAX}
            step={1}
            className="sm:max-w-40"
            value={gap}
            placeholder={String(bounds.effectiveSyncRegenGapHours)}
            disabled={save.isPending}
            aria-invalid={!gapValid || undefined}
            aria-describedby="admin-ai-usage-gap-hint"
            onChange={(e) => setGap(e.target.value)}
          />
          <p
            id="admin-ai-usage-gap-hint"
            className="text-muted-foreground text-xs"
          >
            {t("admin.aiUsage.gapHint", {
              hours: bounds.effectiveSyncRegenGapHours,
            })}
          </p>
        </div>
        <SettingsCardActions>
          <Button
            type="submit"
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={save.isPending || !gapValid || defaultAbove}
          >
            {t("common.save")}
          </Button>
        </SettingsCardActions>
      </form>
    </SettingsCard>
  );
}
