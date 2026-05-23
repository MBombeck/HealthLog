"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  LayoutDashboard,
  RotateCcw,
  Loader2,
  ArrowUp,
  ArrowDown,
  GripVertical,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
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

/**
 * v1.4.47 W4 — pure reorder helper shared by the arrow buttons and the
 * @dnd-kit drag-end handler. Both surfaces produce the same `widgets[]`
 * shape (`order: 0..n-1`) so the existing PUT contract stays untouched
 * and either input mode flushes via the same Save mutation. Exported so
 * the unit test can pin the contract without spinning up a DndContext.
 *
 * v1.4.48 M6a — also drives the arrow-button `move()` handler below;
 * the previous in-file swap-and-renumber implementation was a second
 * copy of the same logic.
 */
export function reorderWidgets(
  widgets: readonly { id: string; order: number }[],
  fromId: string,
  toId: string,
): { id: string; order: number }[] {
  const sorted = [...widgets].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((w) => w.id === fromId);
  const toIdx = sorted.findIndex((w) => w.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
    return sorted.map((w, i) => ({ ...w, order: i }));
  }
  const next = [...sorted];
  const [removed] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, removed);
  return next.map((w, i) => ({ ...w, order: i }));
}

/**
 * v1.4.48 M6a — merge the `{ id, order }` shape returned by
 * `reorderWidgets()` back into the full `DashboardWidgetConfig[]` so
 * the section's draft state keeps every per-row flag (`visible`,
 * `tileVisible`) while the order is rewritten. The arrow buttons and
 * the @dnd-kit drag-end handler both flow through this helper so
 * neither surface can silently drop a flag.
 */
function mergeReorderIntoLayout(
  widgets: DashboardLayout["widgets"],
  reordered: readonly { id: string; order: number }[],
): DashboardLayout["widgets"] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  return reordered.map((r, i) => {
    const original = byId.get(r.id as DashboardWidgetId);
    if (!original) {
      // v1.4.49 — defence-in-depth dev warning for the orphan branch.
      // Today this branch is statically unreachable: every id in
      // `reordered` is sourced from `layout.widgets`, so `byId.get`
      // always hits. The upcoming per-tile Suspense refactor will
      // introduce dynamic widgets where this invariant could break;
      // the warning fires in dev only so a regression surfaces in the
      // console instead of silently dropping the row via the cast.
      if (
        typeof window !== "undefined" &&
        process.env.NODE_ENV === "development"
      ) {
        console.warn(
          `mergeReorderIntoLayout: orphan widget id "${r.id}" dropped`,
        );
      }
      return { ...r, order: i } as never;
    }
    return { ...original, order: i };
  });
}

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
  // v1.4.32 — Recent workouts tile (default-on).
  recentWorkouts: "dashboard.recentWorkouts.title",
};

export function DashboardLayoutSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // v1.4.47 W4 — stable id namespace for the drag-handle `aria-describedby`
  // tooltip. One hint paragraph is rendered once at the bottom of the list
  // and referenced by every drag handle in this section.
  const dragHintId = useId();

  // v1.4.47 W4 — sensors: pointer for mouse/touch, keyboard for Tab + Space
  // + arrow-key reordering. The KeyboardSensor still works for users who
  // tab to the GripVertical handle; the legacy ArrowUp / ArrowDown buttons
  // below remain the primary keyboard surface for accessibility.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Activation distance avoids the drag stealing every click on the row
      // switches — only a 6 px pointer-down → move counts as drag intent.
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

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

  /**
   * v1.4.48 M6a — the arrow buttons now delegate to `reorderWidgets()`
   * so the swap-and-renumber logic lives in exactly one place. The
   * neighbour id is derived from the sorted layout index + delta;
   * out-of-bounds clicks (top row + ArrowUp, bottom row + ArrowDown)
   * short-circuit before the helper sees them so the button disabled
   * state stays the single source of truth for the boundary.
   */
  function move(widgetId: DashboardWidgetId, delta: -1 | 1) {
    if (!layout) return;
    const sorted = [...layout.widgets].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((w) => w.id === widgetId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= sorted.length) return;
    const neighbourId = sorted[targetIdx].id;
    const reordered = reorderWidgets(layout.widgets, widgetId, neighbourId);
    setDraft({
      ...layout,
      widgets: mergeReorderIntoLayout(layout.widgets, reordered),
    });
  }

  /**
   * v1.4.47 W4 — drag-and-drop reorder via @dnd-kit. Persists the same
   * `order` rewrite shape the arrow buttons already use, so save / cancel
   * / reset and the existing draft state machine work unchanged. The
   * pointer + keyboard sensors are wired in the same `useSensors` call;
   * keyboard a11y still also works through the legacy arrow buttons that
   * remain on every row.
   */
  function handleDragEnd(event: DragEndEvent) {
    if (!layout) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const reordered = reorderWidgets(
      layout.widgets,
      String(active.id),
      String(over.id),
    );
    setDraft({
      ...layout,
      widgets: mergeReorderIntoLayout(layout.widgets, reordered),
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
          {/* v1.4.47 W4 — column header spacer additionally reserves the
              width of the new drag-handle icon (w-7) so Tile / Chart
              alignment with the row switches below stays pixel-perfect. */}
          <div className="text-muted-foreground flex items-center gap-2 px-3 pb-1 text-[10px] font-medium tracking-wide uppercase">
            <span className="w-7" aria-hidden="true" />
            <span className="flex-1" aria-hidden="true" />
            <span className="w-12 text-center">
              {t("dashboard.layoutTileColumn")}
            </span>
            <span className="w-12 text-center">
              {t("dashboard.layoutChartColumn")}
            </span>
            <span className="w-22 sm:w-18" aria-hidden="true" />
          </div>
          {(() => {
            const sortedWidgets = [...layout.widgets].sort(
              (a, b) => a.order - b.order,
            );
            const sortedIds = sortedWidgets.map((w) => w.id);
            return (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={sortedIds}
                  strategy={verticalListSortingStrategy}
                >
                  {sortedWidgets.map((widget, index, arr) => (
                    <SortableWidgetRow
                      key={widget.id}
                      widget={widget}
                      labelKey={WIDGET_LABEL_KEYS[widget.id] ?? widget.id}
                      index={index}
                      total={arr.length}
                      dragHintId={dragHintId}
                      disabled={saveMutation.isPending}
                      labels={{
                        tileColumn: t("dashboard.layoutTileColumn"),
                        chartColumn: t("dashboard.layoutChartColumn"),
                        moveUp: t("dashboard.moveUp"),
                        moveDown: t("dashboard.moveDown"),
                        dragHandle: t("dashboard.dragHandle"),
                        widgetLabel: t(
                          WIDGET_LABEL_KEYS[widget.id] ?? widget.id,
                        ),
                      }}
                      onToggleTile={toggleTile}
                      onToggleChart={toggle}
                      onMove={move}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            );
          })()}
          {/* v1.4.47 W4 — single shared aria-describedby target for all
              drag handles. Screen readers read this once per focused
              handle; sighted users see it in the native browser tooltip
              via the matching `title` attribute on each handle.
              v1.4.48 L8 — gate on widget count so an empty layout never
              orphans the paragraph (no handles to describe). */}
          {layout.widgets.length > 0 && (
            <p id={dragHintId} className="text-muted-foreground sr-only">
              {t("dashboard.dragHandleHint")}
            </p>
          )}
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

/**
 * v1.4.47 W4 — sortable row primitive extracted from the section render
 * so the @dnd-kit `useSortable` hook stays scoped to one row. Translation
 * strings are passed in pre-resolved (rather than calling `useTranslations`
 * inside) so this component stays cheap to re-render for the 13+ rows.
 *
 * The drag handle is the only listener-bearing surface — the row body
 * stays click-through so the switches and arrow buttons keep working.
 * Pointer activation has a 6 px distance constraint (configured on the
 * parent sensor) so a tap on the handle never accidentally drags.
 */
interface SortableWidgetRowProps {
  widget: {
    id: DashboardWidgetId;
    visible: boolean;
    tileVisible?: boolean;
    order: number;
  };
  labelKey: string;
  index: number;
  total: number;
  dragHintId: string;
  disabled: boolean;
  labels: {
    tileColumn: string;
    chartColumn: string;
    moveUp: string;
    moveDown: string;
    dragHandle: string;
    widgetLabel: string;
  };
  onToggleTile: (id: DashboardWidgetId, value: boolean) => void;
  onToggleChart: (id: DashboardWidgetId, value: boolean) => void;
  onMove: (id: DashboardWidgetId, delta: -1 | 1) => void;
}

function SortableWidgetRow({
  widget,
  index,
  total,
  dragHintId,
  disabled,
  labels,
  onToggleTile,
  onToggleChart,
  onMove,
}: SortableWidgetRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id });

  // v1.4.48 L7 — honour the OS `prefers-reduced-motion` preference. The
  // rest of HealthLog pairs every transition with a `motion-reduce`
  // companion; dnd-kit's default `transform 250ms ease` was the lone
  // surface that ignored it. Short-circuit to `none` when reduced
  // motion is requested so dragged rows snap to place instead of
  // sliding through the list.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  const tileChecked =
    typeof widget.tileVisible === "boolean"
      ? widget.tileVisible
      : widget.visible;

  return (
    // v1.4.29 — row sized at 48 px (`min-h-12`) with 44-px mobile tap
    // targets preserved on the trailing arrow buttons (`size-11`),
    // shrunk to `sm:size-9` on desktop. v1.4.47 W4 — `isDragging`
    // raises the row visually (elevation + accent ring) so the ghost
    // overlay is unambiguous during a drag.
    <div
      ref={setNodeRef}
      style={style}
      data-slot="widget-row"
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle} — ${labels.widgetLabel}`}
        // v1.4.47 W4 — `aria-describedby` is set after `{...attributes}`
        // so our shared hint paragraph wins over dnd-kit's own announcer
        // hookup. The announcer still fires on drag-start / drag-over /
        // drag-end via the screenReaderInstructions slot below.
        aria-describedby={dragHintId}
        title={labels.dragHandle}
        disabled={disabled}
        data-slot="widget-drag-handle"
        // v1.4.47 W10 design-H1 — extend the WCAG 2.5.5 hit target to
        // 44 × 44 px via a `::before` pseudo-element while keeping the
        // visible GripVertical at 28 px (matches the Switch primitive
        // pattern from v1.4.43 W5-H1). v1.4.47 W10 design-M1 — drop
        // dnd-kit's CSS transition under prefers-reduced-motion.
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background -m-1 relative inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex-1 truncate text-sm" title={labels.widgetLabel}>
        {labels.widgetLabel}
      </span>
      <div className="flex w-12 justify-center">
        <Switch
          checked={tileChecked}
          onCheckedChange={(v) => onToggleTile(widget.id, v)}
          aria-label={`${labels.widgetLabel} — ${labels.tileColumn}`}
          disabled={disabled}
          data-slot="widget-tile-switch"
        />
      </div>
      <div className="flex w-12 justify-center">
        <Switch
          checked={widget.visible}
          onCheckedChange={(v) => onToggleChart(widget.id, v)}
          aria-label={`${labels.widgetLabel} — ${labels.chartColumn}`}
          disabled={disabled}
          data-slot="widget-chart-switch"
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(widget.id, -1)}
        disabled={index === 0 || disabled}
        aria-label={labels.moveUp}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(widget.id, 1)}
        disabled={index === total - 1 || disabled}
        aria-label={labels.moveDown}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
