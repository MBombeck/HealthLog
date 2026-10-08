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
 *
 * v1.4.25 W8c — two-axis extension. The same screen now hosts three
 * vertically-stacked sections (the maintainer no-split directive):
 *   1. Global default ladder per metric class (existing).
 *   2. Per-metric override expander — collapsed by default; an
 *      explicit knob for power users (the global ladder already lives
 *      above and most users never open this).
 *   3. Device-type override expander — collapsed by default; one
 *      global ladder ("watch beats phone beats scale") with optional
 *      per-metric overrides.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Layers,
  Loader2,
  RotateCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS } from "@/lib/i18n/source-labels";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import {
  DEFAULT_DEVICE_TYPE_PRIORITY,
  DEFAULT_SOURCE_PRIORITY,
  type DeviceType,
  type DeviceTypePriority,
  type MetricPriority,
  SOURCE_PRIORITY_METRIC_KEYS,
  type SourcePriorityMetricKey,
} from "@/lib/validations/source-priority";
import { apiGet, apiPut } from "@/lib/api/api-fetch";

/**
 * Resolved shape returned by `GET /api/auth/me/source-priority`. Mirrors
 * `parseSourcePriority()`'s return: every metric ladder is defaulted,
 * the two-axis containers are present (possibly empty).
 */
interface ResolvedPriority extends Required<MetricPriority> {
  metricPriority: Required<MetricPriority>;
  deviceTypePriority: DeviceTypePriority;
}

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
  hrvRmssd: "settings.sections.sources.metrics.hrvRmssd",
  restingHeartRate: "settings.sections.sources.metrics.restingHeartRate",
  vo2Max: "settings.sections.sources.metrics.vo2Max",
  // v1.11.0 — WHOOP-overlapping metric classes + native-vs-derived recovery.
  skinTemperature: "settings.sections.sources.metrics.skinTemperature",
  respiratoryRate: "settings.sections.sources.metrics.respiratoryRate",
  recovery: "settings.sections.sources.metrics.recovery",
  // v1.18.10 I-5 — native-vs-derived stress ladder.
  stress: "settings.sections.sources.metrics.stress",
  // v1.25.0 — native-vs-computed sleep-debt ladder.
  sleepDebt: "settings.sections.sources.metrics.sleepDebt",
};

const DEVICE_TYPE_LABEL_KEYS: Record<DeviceType, string> = {
  watch: "settings.sections.sources.deviceLabels.watch",
  band: "settings.sections.sources.deviceLabels.band",
  ring: "settings.sections.sources.deviceLabels.ring",
  phone: "settings.sections.sources.deviceLabels.phone",
  scale: "settings.sections.sources.deviceLabels.scale",
  other: "settings.sections.sources.deviceLabels.other",
  unknown: "settings.sections.sources.deviceLabels.unknown",
};

/**
 * `<SourcesSection>` — the per-metric source-priority + device-type ladders.
 *
 * v1.18.1 (D4) — Sources is a standalone `/settings/sources` left-side entry
 * again (split back out of the Integrations sub-tabs). It renders its own
 * section header + the cross-link back to Integrationen.
 */
export function SourcesSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: remote, isLoading } = useQuery({
    queryKey: queryKeys.sourcePriority(),
    queryFn: async () => {
      return apiGet<ResolvedPriority>("/api/auth/me/source-priority");
    },
  });

  // Local draft state — same pattern as `<DashboardLayoutSection>`. The
  // user reorders sources via the up/down arrows; nothing hits the
  // network until they click Save.
  const [draft, setDraft] = useState<ResolvedPriority | null>(null);
  const priority = draft ?? remote ?? null;

  const [showPerMetric, setShowPerMetric] = useState(false);
  const [showDeviceType, setShowDeviceType] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (next: ResolvedPriority) => {
      // PUT the W8c-canonical shape: nested `metricPriority` +
      // `deviceTypePriority` together. The server's
      // `parseSourcePriority` echoes the resolved shape back so the
      // optimistic update is just a `setQueryData`.
      const body = {
        metricPriority: next.metricPriority,
        deviceTypePriority: next.deviceTypePriority,
      };
      return apiPut<ResolvedPriority>("/api/auth/me/source-priority", body);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.sourcePriority(), saved);
      // The analytics aggregator, the per-chart daily aggregates, the
      // measurement list and the dashboard snapshot all fold source
      // priority into their per-day canonical-row picks — flush them so
      // every chart and tile re-paints with the new picker, not only the
      // analytics report.
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      queryClient.invalidateQueries({ queryKey: queryKeys.chartDataRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.measurements() });
      void refetchInactiveDailyReads(queryClient);
      setDraft(null);
      toast.success(t("settings.sections.sources.saveSuccess"));
    },
    onError: () => toast.error(t("settings.sections.sources.saveError")),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      // Sending the empty W8c shape clears every per-user override; the
      // server's `parseSourcePriority` then returns the constant
      // defaults verbatim. Keeps the wire payload tiny.
      return apiPut<ResolvedPriority>("/api/auth/me/source-priority", {});
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.sourcePriority(), saved);
      // Same fan-out as the save arm: the defaults change the canonical-row
      // picks everywhere the overrides did.
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      queryClient.invalidateQueries({ queryKey: queryKeys.chartDataRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.measurements() });
      void refetchInactiveDailyReads(queryClient);
      setDraft(null);
      toast.success(t("settings.sections.sources.resetSuccess"));
    },
  });

  /**
   * Shared adjacent-swap for both ladder buckets. Returns a copy of
   * `list` with `index` and `index+delta` swapped, or `null` when the
   * target index falls outside the array. The helper deliberately stays
   * generic (typed via `T`) so both the source ladder (string[]) and
   * the device-type ladder (DeviceType[]) share one implementation —
   * the previous moveSource + moveDeviceType pair drifted apart twice
   * during W8c before they were re-aligned.
   */
  function reorderLadder<T>(
    list: readonly T[],
    index: number,
    delta: -1 | 1,
  ): T[] | null {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= list.length) return null;
    const next = [...list];
    [next[index], next[targetIdx]] = [next[targetIdx], next[index]];
    return next;
  }

  function moveSource(
    metric: SourcePriorityMetricKey,
    index: number,
    delta: -1 | 1,
  ) {
    if (!priority) return;
    const current =
      priority.metricPriority[metric] ?? DEFAULT_SOURCE_PRIORITY[metric];
    const list = reorderLadder(current, index, delta);
    if (!list) return;
    const nextMetric = { ...priority.metricPriority, [metric]: list };
    setDraft({
      ...priority,
      ...nextMetric,
      metricPriority: nextMetric,
    });
  }

  function moveDeviceType(
    /** `null` for the global ladder, MeasurementType-enum string otherwise. */
    bucket: string | null,
    index: number,
    delta: -1 | 1,
  ) {
    if (!priority) return;
    const key = bucket ?? "default";
    const current =
      priority.deviceTypePriority[key] ?? DEFAULT_DEVICE_TYPE_PRIORITY;
    const list = reorderLadder(current, index, delta);
    if (!list) return;
    const nextDevicePriority: DeviceTypePriority = {
      ...priority.deviceTypePriority,
      [key]: list,
    };
    setDraft({ ...priority, deviceTypePriority: nextDevicePriority });
  }

  function resetMetricToDefault(metric: SourcePriorityMetricKey) {
    if (!priority) return;
    const nextMetric: Required<MetricPriority> = {
      ...priority.metricPriority,
      [metric]: [...DEFAULT_SOURCE_PRIORITY[metric]],
    };
    setDraft({
      ...priority,
      ...nextMetric,
      metricPriority: nextMetric,
    });
  }

  function resetDeviceTypeAxis() {
    if (!priority) return;
    setDraft({ ...priority, deviceTypePriority: {} });
  }

  const dirty = draft !== null && priority !== null;

  // The per-metric expander shows every metric whose ladder has been
  // overridden, plus a hint when none has. Counter lives next to the
  // expander label so the section "asks" for attention proportional
  // to its setting.
  const overriddenMetrics = useMemo(() => {
    if (!priority) return [] as SourcePriorityMetricKey[];
    return SOURCE_PRIORITY_METRIC_KEYS.filter((metric) => {
      const list = priority.metricPriority[metric];
      const defaultList = DEFAULT_SOURCE_PRIORITY[metric];
      if (!list || list.length !== defaultList.length) return true;
      return list.some((s, i) => s !== defaultList[i]);
    });
  }, [priority]);

  // Count distinct overrides the user has set on the device-type axis.
  // `default` counts as one if present; every per-metric override
  // (`WEIGHT`, `ACTIVITY_STEPS`, …) counts as one more. The number drives
  // the expander label so the section is self-explanatory at a glance.
  const deviceTypeOverrideCount = useMemo(() => {
    if (!priority) return 0;
    return Object.keys(priority.deviceTypePriority).length;
  }, [priority]);

  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` (the off-style muted intro folded into the
  // standard subtitle). The quiet cross-link back to Integrationen — where
  // the sources this ladder ranks are added / removed — stays inside the
  // card, below the ladder.
  return (
    <div className="space-y-6">
      <SettingsCard>
        <SettingsCardHeader
          icon={Layers}
          title={t("settings.sections.sources.cardTitle")}
          description={t("settings.sections.sources.help")}
        />

        <p className="text-sm">{t("settings.sections.sources.helpDetail")}</p>

        {isLoading || !priority ? (
          <SourcesSkeletonList />
        ) : (
          <div className="space-y-3">
            {SOURCE_PRIORITY_METRIC_KEYS.map((metric) => {
              const list =
                priority.metricPriority[metric] ??
                DEFAULT_SOURCE_PRIORITY[metric];
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
                          {t(MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS[source])}
                        </span>
                        {/* Up/down sit side by side at every width: two
                            44 px buttons leave a 390 px row ~170 px for the
                            source name. Stacking them on phones (v1.4.27
                            MB2) doubled every row and pushed this page past
                            twelve thousand pixels. */}
                        <div className="flex shrink-0 gap-1 sm:gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11"
                            onClick={() => moveSource(metric, index, -1)}
                            disabled={index === 0 || saveMutation.isPending}
                            aria-label={t("settings.sections.sources.moveUp")}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11"
                            onClick={() => moveSource(metric, index, 1)}
                            disabled={
                              index === list.length - 1 ||
                              saveMutation.isPending
                            }
                            aria-label={t("settings.sections.sources.moveDown")}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {/* ── v1.4.25 W8c — per-metric override expander ──
            Collapsed by default. The global ladder above already
            covers every metric; this section lets a power user reset
            a single metric back to the constant default in one click. */}
        {priority && (
          <div className="border-border space-y-2 border-t pt-4">
            <button
              type="button"
              onClick={() => setShowPerMetric((prev) => !prev)}
              aria-expanded={showPerMetric}
              aria-controls="sources-per-metric-panel"
              className="text-foreground hover:text-primary flex items-center gap-2 text-sm font-medium transition-colors"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${
                  showPerMetric ? "rotate-180" : ""
                }`}
              />
              {t("settings.sections.sources.perMetricToggle", {
                count: overriddenMetrics.length,
              })}
            </button>
            {showPerMetric && (
              <div
                id="sources-per-metric-panel"
                role="region"
                className="bg-background/30 border-border space-y-3 rounded-md border p-3"
              >
                <p className="text-muted-foreground text-xs">
                  {t("settings.sections.sources.perMetricHelp")}
                </p>
                {overriddenMetrics.length === 0 ? (
                  <EmptyState
                    variant="plain"
                    size="compact"
                    title={t("settings.sections.sources.perMetricEmpty")}
                  />
                ) : (
                  <ul className="space-y-2">
                    {overriddenMetrics.map((metric) => (
                      <li
                        key={metric}
                        className="border-border bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                      >
                        <span className="text-sm">
                          {t(METRIC_LABEL_KEYS[metric])}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => resetMetricToDefault(metric)}
                          disabled={saveMutation.isPending}
                        >
                          {t("settings.sections.sources.resetMetric")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── v1.4.25 W8c — device-type override expander ──
            One global ladder ("watch beats phone beats scale"). When
            multiple device-types stream the same source's metric
            (Apple Watch + iPhone → APPLE_HEALTH steps), the higher-
            ranked device-type wins. Collapsed by default. */}
        {priority && (
          <div className="border-border space-y-2 border-t pt-4">
            <button
              type="button"
              onClick={() => setShowDeviceType((prev) => !prev)}
              aria-expanded={showDeviceType}
              aria-controls="sources-device-type-panel"
              className="text-foreground hover:text-primary flex items-center gap-2 text-sm font-medium transition-colors"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${
                  showDeviceType ? "rotate-180" : ""
                }`}
              />
              {t("settings.sections.sources.deviceTypeToggle", {
                count: deviceTypeOverrideCount,
              })}
            </button>
            {showDeviceType && (
              <div
                id="sources-device-type-panel"
                role="region"
                className="bg-background/30 border-border space-y-3 rounded-md border p-3"
              >
                <p className="text-muted-foreground text-xs">
                  {t("settings.sections.sources.deviceTypeHelp")}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {t("settings.sections.sources.deviceTypeDefault")}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={resetDeviceTypeAxis}
                    disabled={saveMutation.isPending}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t("settings.sections.sources.resetDeviceTypes")}
                  </Button>
                </div>
                <ul className="space-y-1">
                  {(
                    priority.deviceTypePriority.default ??
                    DEFAULT_DEVICE_TYPE_PRIORITY
                  ).map((deviceType, index, list) => (
                    <li
                      key={`device-default-${deviceType}-${index}`}
                      className="border-border bg-card flex items-center gap-2 rounded-md border px-2 py-1.5"
                    >
                      <span className="text-muted-foreground w-5 text-xs font-medium tabular-nums">
                        {index + 1}.
                      </span>
                      <span className="flex-1 text-sm">
                        {t(DEVICE_TYPE_LABEL_KEYS[deviceType])}
                      </span>
                      {/* v1.4.27 R3d MB2 — same stacked-on-mobile shape
                          as the metric source rows above. */}
                      <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11"
                          onClick={() => moveDeviceType(null, index, -1)}
                          disabled={index === 0 || saveMutation.isPending}
                          aria-label={t("settings.sections.sources.moveUp")}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11"
                          onClick={() => moveDeviceType(null, index, 1)}
                          disabled={
                            index === list.length - 1 || saveMutation.isPending
                          }
                          aria-label={t("settings.sections.sources.moveDown")}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* v1.18.6 (W9) — quiet pointer back to Integrationen, where the
            sources this ladder ranks are connected / removed. Above the
            action row: nothing follows a card's actions. */}
        <p className="text-muted-foreground border-border border-t pt-3 text-xs">
          {t("settings.sections.sources.integrationsHint")}{" "}
          <Link
            href="/settings/integrations"
            className="text-primary underline underline-offset-2"
            data-slot="sources-integrations-cross-link"
          >
            {t("settings.sections.sources.integrationsHintLink")}
          </Link>
        </p>

        {/* One action row, last in the card (design standards §12). The
            reset used to ride the header's status slot, which carries
            status, not actions; Cancel + Save join it while a draft is open. */}
        <SettingsCardActions>
          <ConfirmButton
            slot="settings-sources-reset"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label={t("settings.sections.sources.resetDefaults")}
            title={t("settings.sections.sources.resetDefaultsTitle")}
            body={t("settings.sections.sources.resetDefaultsBody")}
            confirmLabel={t("settings.sections.sources.resetDefaultsConfirm")}
            disabled={saveMutation.isPending}
            pending={resetMutation.isPending}
            onConfirm={() => resetMutation.mutate()}
          />
          {dirty && priority ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => setDraft(null)}
                disabled={saveMutation.isPending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => saveMutation.mutate(priority)}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("common.save")}
              </Button>
            </>
          ) : null}
        </SettingsCardActions>
      </SettingsCard>

      {/* v1.28 shipped `<NutrientIntakeCard>` here; the 2026-07-17 UX/IA
          audit (M7) moved it to Settings → Integrations — it is a read-only
          Apple-Health sync inventory, not a which-connection-wins ranking,
          so it never belonged on the "source priority" ladder. See
          `<IntegrationsSection>` for the card's new home. */}
    </div>
  );
}

/**
 * Skeleton placeholder rendered while `/api/auth/me/source-priority`
 * is in flight. Reserves one row per `SOURCE_PRIORITY_METRIC_KEYS`
 * entry at roughly the loaded height so the page does not jump when
 * the fetched ladder list swaps in. The pulsing animation honours
 * `prefers-reduced-motion` via Tailwind's `motion-reduce:animate-none`.
 */
function SourcesSkeletonList() {
  return (
    <div
      className="space-y-3"
      data-testid="sources-skeleton"
      aria-hidden="true"
    >
      {SOURCE_PRIORITY_METRIC_KEYS.map((metric) => (
        <div
          key={metric}
          className="border-border bg-background/30 space-y-2 rounded-md border p-3"
        >
          <Skeleton className="h-4 w-40" />
          <div className="space-y-1">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
