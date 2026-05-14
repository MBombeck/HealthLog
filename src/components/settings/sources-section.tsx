"use client";

/**
 * v1.4.25 W5e — Settings → Sources.
 *
 * Per-metric-class source priority. When more than one ingest source
 * records the same metric for the same day, the analytics aggregator
 * picks ONE canonical source per day (for cumulative metrics like
 * steps / sleep duration) or surfaces a "preferred" source (for point
 * measurements like weight / BP). Non-picked rows stay in the DB as an
 * audit trail.
 *
 * Today (v1.4.25) only WITHINGS + MANUAL coexist; the cumulative-metric
 * aggregator no-ops because no user has two ingest paths reporting the
 * same daily total. The UI lands now so v1.5's Apple Health passthrough
 * drops onto a known foundation — every user's preferences carry
 * straight into iOS-era analytics without an extra migration step.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Layers, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  DEFAULT_SOURCE_PRIORITY,
  SOURCE_PRIORITY_METRIC_KEYS,
  type SourcePriority,
  type SourcePriorityMetricKey,
} from "@/lib/validations/source-priority";

type ResolvedPriority = Required<SourcePriority>;

const METRIC_LABEL_KEYS: Record<SourcePriorityMetricKey, string> = {
  steps: "settings.sections.sources.metrics.steps",
  activeEnergy: "settings.sections.sources.metrics.activeEnergy",
  walkingRunningDistance:
    "settings.sections.sources.metrics.walkingRunningDistance",
  flightsClimbed: "settings.sections.sources.metrics.flightsClimbed",
  sleep: "settings.sections.sources.metrics.sleep",
  weight: "settings.sections.sources.metrics.weight",
  bloodPressure: "settings.sections.sources.metrics.bloodPressure",
  pulse: "settings.sections.sources.metrics.pulse",
  bodyFat: "settings.sections.sources.metrics.bodyFat",
  bodyTemperature: "settings.sections.sources.metrics.bodyTemperature",
  spo2: "settings.sections.sources.metrics.spo2",
  hrv: "settings.sections.sources.metrics.hrv",
  restingHeartRate: "settings.sections.sources.metrics.restingHeartRate",
  vo2Max: "settings.sections.sources.metrics.vo2Max",
};

const SOURCE_LABEL_KEYS: Record<string, string> = {
  WITHINGS: "settings.sections.sources.sourceLabels.WITHINGS",
  APPLE_HEALTH: "settings.sections.sources.sourceLabels.APPLE_HEALTH",
  MANUAL: "settings.sections.sources.sourceLabels.MANUAL",
  IMPORT: "settings.sections.sources.sourceLabels.IMPORT",
};

export function SourcesSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: remote, isLoading } = useQuery({
    queryKey: queryKeys.sourcePriority(),
    queryFn: async () => {
      const res = await fetch("/api/auth/me/source-priority");
      if (!res.ok) throw new Error("failed");
      const json = await res.json();
      return json.data as ResolvedPriority;
    },
  });

  // Local draft state — same pattern as `<DashboardLayoutSection>`. The
  // user reorders sources via the up/down arrows; nothing hits the
  // network until they click Save.
  const [draft, setDraft] = useState<ResolvedPriority | null>(null);
  const priority = draft ?? remote ?? null;

  const saveMutation = useMutation({
    mutationFn: async (next: ResolvedPriority) => {
      const res = await fetch("/api/auth/me/source-priority", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error("save failed");
      return (await res.json()).data as ResolvedPriority;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.sourcePriority(), saved);
      // The analytics aggregator folds source priority into the
      // SLEEP_DURATION daily total — flush its cache so the chart
      // re-paints with the new picker on the next mount.
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      setDraft(null);
      toast.success(t("settings.sections.sources.saveSuccess"));
    },
    onError: () => toast.error(t("settings.sections.sources.saveError")),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      // The PUT validator accepts an empty partial object too, but
      // sending the full default keeps the round-trip body
      // representative of "this is what should be active".
      const res = await fetch("/api/auth/me/source-priority", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DEFAULT_SOURCE_PRIORITY),
      });
      if (!res.ok) throw new Error("reset failed");
      return (await res.json()).data as ResolvedPriority;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.sourcePriority(), saved);
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      setDraft(null);
      toast.success(t("settings.sections.sources.resetSuccess"));
    },
  });

  function moveSource(
    metric: SourcePriorityMetricKey,
    index: number,
    delta: -1 | 1,
  ) {
    if (!priority) return;
    const list = [...(priority[metric] ?? DEFAULT_SOURCE_PRIORITY[metric])];
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= list.length) return;
    [list[index], list[targetIdx]] = [list[targetIdx], list[index]];
    setDraft({ ...priority, [metric]: list });
  }

  const dirty = draft !== null && priority !== null;

  return (
    <section
      aria-labelledby="settings-section-sources-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-sources-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.sources.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.sources.description")}
        </p>
      </header>

      <div className="bg-card border-border space-y-4 rounded-xl border p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex items-center gap-2">
            <Layers className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">
              {t("settings.sections.sources.cardTitle")}
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending || saveMutation.isPending}
            className="self-end sm:self-auto"
          >
            <RotateCcw className="mr-2 h-3.5 w-3.5" />
            {t("settings.sections.sources.resetDefaults")}
          </Button>
        </div>

        <p className="text-muted-foreground text-xs">
          {t("settings.sections.sources.help")}
        </p>

        {isLoading || !priority ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : (
          <div className="space-y-3">
            {SOURCE_PRIORITY_METRIC_KEYS.map((metric) => {
              const list = priority[metric] ?? DEFAULT_SOURCE_PRIORITY[metric];
              return (
                <div
                  key={metric}
                  className="border-border bg-background/30 space-y-2 rounded-md border p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {t(METRIC_LABEL_KEYS[metric])}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {list.map((source, index) => (
                      <li
                        key={`${metric}-${source}-${index}`}
                        className="border-border bg-card flex items-center gap-2 rounded-md border px-2 py-1.5"
                      >
                        <span className="text-muted-foreground w-5 text-xs font-medium tabular-nums">
                          {index + 1}.
                        </span>
                        <span className="flex-1 text-sm">
                          {t(SOURCE_LABEL_KEYS[source] ?? source)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => moveSource(metric, index, -1)}
                          disabled={index === 0 || saveMutation.isPending}
                          aria-label={t("settings.sections.sources.moveUp")}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => moveSource(metric, index, 1)}
                          disabled={
                            index === list.length - 1 || saveMutation.isPending
                          }
                          aria-label={t("settings.sections.sources.moveDown")}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {dirty && priority && (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft(null)}
              disabled={saveMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => saveMutation.mutate(priority)}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
