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
import {
  type DashboardLayout,
  type DashboardWidgetId,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@/lib/dashboard-layout";

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
};

export function DashboardLayoutSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: remote, isLoading } = useQuery({
    queryKey: ["user", "dashboardWidgets"],
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
      queryClient.setQueryData(["user", "dashboardWidgets"], saved);
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
      queryClient.setQueryData(["user", "dashboardWidgets"], saved);
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
      className="bg-card border-border scroll-mt-28 space-y-5 rounded-xl border p-6"
    >
      <div className="flex items-center justify-between gap-3">
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
        >
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          {t("dashboard.layoutReset")}
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        {t("dashboard.customizeSubtitle")}
      </p>

      {isLoading || !layout ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <div className="space-y-2">
          {[...layout.widgets]
            .sort((a, b) => a.order - b.order)
            .map((widget, index, arr) => {
              const labelKey = WIDGET_LABEL_KEYS[widget.id] ?? widget.id;
              return (
                <div
                  key={widget.id}
                  className="border-border bg-background/30 flex items-center gap-3 rounded-md border p-3"
                >
                  <div className="flex flex-col gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={() => move(widget.id, -1)}
                      disabled={index === 0 || saveMutation.isPending}
                      aria-label={t("dashboard.moveUp")}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={() => move(widget.id, 1)}
                      disabled={
                        index === arr.length - 1 || saveMutation.isPending
                      }
                      aria-label={t("dashboard.moveDown")}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </div>
                  <span className="flex-1 text-sm">{t(labelKey)}</span>
                  <Switch
                    checked={widget.visible}
                    onCheckedChange={(v) => toggle(widget.id, v)}
                    aria-label={t(labelKey)}
                    disabled={saveMutation.isPending}
                  />
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
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
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
