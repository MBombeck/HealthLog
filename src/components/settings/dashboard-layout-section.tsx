"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  LayoutDashboard,
  RotateCcw,
  Loader2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  type DashboardLayout,
  type DashboardWidgetId,
  type ComparisonBaseline,
  COMPARISON_BASELINES,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@/lib/dashboard-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const WIDGET_LABEL_KEYS: Record<DashboardWidgetId, string> = {
  weight: "dashboard.weight",
  bp: "dashboard.bloodPressure",
  pulse: "dashboard.pulse",
  bodyFat: "dashboard.bodyFat",
  mood: "dashboard.mood",
  medications: "dashboard.medications",
  sleep: "measurements.typeSleep",
  steps: "measurements.typeSteps",
  glucose: "measurements.typeBloodGlucose",
  totalBodyWater: "measurements.typeTotalBodyWater",
  boneMass: "measurements.typeBoneMass",
  bpInTarget: "dashboard.bpInTarget",
  oxygenSaturation: "measurements.typeOxygenSaturation",
  achievements: "achievements.title",
  // v1.4.25 W8d — VO2 max secondary-metric tile (opt-in).
  vo2Max: "dashboard.vo2Max",
};

export function DashboardLayoutSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: remote, isLoading } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("failed");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
  });

  // Local draft state — null means "use server copy". User edits create the
  // draft so reordering/toggling doesn't fire a network call per click; Save
  // flushes it, Cancel clears it. Avoids a setState-in-effect (eslint
  // react-hooks/set-state-in-effect is strict in this repo).
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const layout = draft ?? remote ?? null;

  const saveMutation = useMutation({
    mutationFn: async (next: DashboardLayout) => {
      const res = await fetch("/api/dashboard/widgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error("save failed");
      return (await res.json()).data as DashboardLayout;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      setDraft(null);
      toast.success(t("dashboard.layoutSaveSuccess"));
    },
    onError: () => toast.error(t("dashboard.layoutSaveError")),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dashboard/widgets", { method: "DELETE" });
      if (!res.ok) throw new Error("reset failed");
      return (await res.json()).data as DashboardLayout;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      setDraft(null);
      toast.success(t("dashboard.layoutResetSuccess"));
    },
  });

  function toggle(widgetId: DashboardWidgetId, visible: boolean) {
    if (!layout) return;
    setDraft({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === widgetId ? { ...w, visible } : w,
      ),
    });
  }

  /**
   * v1.4.15 Fix 5 — independent toggle for the *strip tile* (the upper
   * row of trend cards). Until v1.4.14 a single switch controlled both
   * the tile AND the chart for the same metric, which the maintainer found too
   * coarse: he wanted a chart visible without the tile (for metrics he
   * tracks without wanting the at-a-glance number) or vice versa.
   */
  function toggleTile(widgetId: DashboardWidgetId, tileVisible: boolean) {
    if (!layout) return;
    setDraft({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === widgetId ? { ...w, tileVisible } : w,
      ),
    });
  }

  /**
   * v1.4.16 phase B8 — comparison baseline picker. The toggle persists
   * via the same `/api/dashboard/widgets` PUT the existing layout
   * controls already use; saving rides through the same `Save` button.
   */
  function setComparisonBaseline(value: ComparisonBaseline) {
    if (!layout) return;
    setDraft({ ...layout, comparisonBaseline: value });
  }

  function move(widgetId: DashboardWidgetId, delta: -1 | 1) {
    if (!layout) return;
    const sorted = [...layout.widgets].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((w) => w.id === widgetId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= sorted.length) return;
    [sorted[idx], sorted[targetIdx]] = [sorted[targetIdx], sorted[idx]];
    setDraft({
      ...layout,
      widgets: sorted.map((w, i) => ({ ...w, order: i })),
    });
  }

  // Presence of a draft implies dirty — no JSON comparison needed.
  const dirty = draft !== null && layout !== null;

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-6"
    >
      {/* v1.4.19 A6 — title / action row uses the same stack-on-mobile,
          right-align-on-desktop contract as Account → Password +
          Restart onboarding tour. Avoids the long German "Auf Standard
          zurücksetzen" copy clipping the card edge at narrow widths. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("dashboard.customizeTitle")}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => resetMutation.mutate()}
          disabled={resetMutation.isPending}
          className="self-end sm:self-auto"
        >
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          {t("dashboard.layoutReset")}
        </Button>
      </div>
      {/*
        v1.4.22 D / F-32 — the surrounding `<DashboardSection>` page
        already renders a `settings.sections.dashboard.description`
        paragraph beneath the H1. The previous in-card help line
        repeated the same idea ("Choose which cards appear …
        Defaults work out of the box.") right next to the comparison
        picker, giving the page three muted-foreground help blocks
        stacked on top of each other. Removing this duplicate keeps
        the comparison picker as the only thing between the header
        and the widget table.
      */}

      {/* v1.4.16 phase B8 — comparison baseline picker. Lives at the top
          of the section because it changes how every chart + tile below
          renders, not just one. v1.4.19 A6: height standardised to the
          shared 36-px input contract used by every other Settings input
          / select; the previous `min-h-11` (44 px) made this trigger
          look like an outlier next to the 36-px Username/Email/Date-of-
          birth fields one card up. */}
      {layout && (
        <div className="space-y-2">
          <label
            htmlFor="comparison-baseline"
            className="text-foreground text-sm font-medium"
          >
            {t("comparison.toggleLabel")}
          </label>
          <Select
            value={layout.comparisonBaseline ?? "none"}
            onValueChange={(value) =>
              setComparisonBaseline(value as ComparisonBaseline)
            }
            disabled={saveMutation.isPending}
          >
            <SelectTrigger
              id="comparison-baseline"
              className="w-full sm:w-72"
              data-slot="comparison-baseline-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPARISON_BASELINES.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-slot={`comparison-baseline-option-${value}`}
                >
                  {t(`comparison.baseline.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {t("comparison.toggleHint")}
          </p>
        </div>
      )}

      {isLoading || !layout ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          {t("common.loading")}
        </div>
      ) : (
        <div className="space-y-2">
          {/* v1.4.15 Fix 5 — table-style header naming the two
              switches. The "tile" column controls the strip tile in
              the upper row; the "chart" column controls the line
              chart in the lower row. the maintainer wanted independent control
              of the two surfaces (per feedback_dashboard_top_tiles
              _selectable.md). */}
          {/* v1.4.29 — column-header alignment for the new
              horizontal arrow pair on the trailing edge. The
              right-hand spacer reserves the width of two
              size-11/sm:size-9 buttons so the Tile / Chart column
              headers continue to line up with the switches below. */}
          <div className="text-muted-foreground flex items-center gap-2 px-3 pb-1 text-[10px] font-medium tracking-wide uppercase">
            <span className="flex-1" aria-hidden="true" />
            <span className="w-12 text-center">
              {t("dashboard.layoutTileColumn")}
            </span>
            <span className="w-12 text-center">
              {t("dashboard.layoutChartColumn")}
            </span>
            <span
              className="w-22 sm:w-18"
              aria-hidden="true"
            />
          </div>
          {[...layout.widgets]
            .sort((a, b) => a.order - b.order)
            .map((widget, index, arr) => {
              const labelKey = WIDGET_LABEL_KEYS[widget.id] ?? widget.id;
              const tileChecked =
                typeof widget.tileVisible === "boolean"
                  ? widget.tileVisible
                  : widget.visible;
              return (
                // v1.4.29 — drag-list row compactness. The legacy
                // vertical 44+44-px arrow stack inflated each row
                // to ~116 px; the horizontal arrow pair on the
                // trailing edge drops the row to 48 px (`min-h-12`)
                // while preserving the 44-px mobile tap target
                // (`size-11`). `sm:size-9` shrinks the buttons
                // visually on desktop where pointer accuracy is
                // higher.
                <div
                  key={widget.id}
                  className="border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
                >
                  <span
                    className="flex-1 truncate text-sm"
                    title={t(labelKey)}
                  >
                    {t(labelKey)}
                  </span>
                  <div className="flex w-12 justify-center">
                    <Switch
                      checked={tileChecked}
                      onCheckedChange={(v) => toggleTile(widget.id, v)}
                      aria-label={`${t(labelKey)} — ${t("dashboard.layoutTileColumn")}`}
                      disabled={saveMutation.isPending}
                      data-slot="widget-tile-switch"
                    />
                  </div>
                  <div className="flex w-12 justify-center">
                    <Switch
                      checked={widget.visible}
                      onCheckedChange={(v) => toggle(widget.id, v)}
                      aria-label={`${t(labelKey)} — ${t("dashboard.layoutChartColumn")}`}
                      disabled={saveMutation.isPending}
                      data-slot="widget-chart-switch"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-9"
                    onClick={() => move(widget.id, -1)}
                    disabled={index === 0 || saveMutation.isPending}
                    aria-label={t("dashboard.moveUp")}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-9"
                    onClick={() => move(widget.id, 1)}
                    disabled={
                      index === arr.length - 1 || saveMutation.isPending
                    }
                    aria-label={t("dashboard.moveDown")}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
        </div>
      )}

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft(null)}
            disabled={saveMutation.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => layout && saveMutation.mutate(layout)}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending && (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </div>
      )}

      {!dirty && remote && (
        <p className="text-muted-foreground text-xs">
          {layout &&
          JSON.stringify(layout.widgets) ===
            JSON.stringify(DEFAULT_DASHBOARD_LAYOUT.widgets)
            ? t("dashboard.layoutUsingDefaults")
            : t("dashboard.layoutCustomized")}
        </p>
      )}
    </div>
  );
}
