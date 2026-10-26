"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import {
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_IDS,
  IOS_PIN_ONLY_WIDGET_IDS,
  type DashboardLayout,
  type DashboardWidgetCatalogueId,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import { NATIVE_ONLY_WIDGET_LABEL_KEYS } from "@/lib/dashboard/widget-modules";
import { useTranslations } from "@/lib/i18n/context";
import { isSurfaceVisible } from "@/lib/modules/surface";

import { WIDGET_LABEL_KEYS } from "./layout-model";
import type { DashboardLayoutDraft } from "./use-dashboard-layout-draft";

/**
 * The widgets the web dashboard draws, in their order, each with its tile
 * and chart switches, arrow buttons and a drag handle.
 */
export function WebWidgetList({
  layout,
  draft,
  dragHintId,
}: {
  layout: DashboardLayout;
  draft: DashboardLayoutDraft;
  dragHintId: string;
}) {
  const { t } = useTranslations();
  // A widget toggle whose owning module is disabled is a dead control (the
  // snapshot gates the tile and chart out regardless of the switch), so the
  // resolved module map hides those rows. Fail-open: only an explicit
  // `false` hides one.
  const { user } = useAuth();
  const modules = user?.modules;
  const {
    unavailableIds,
    saveMutation,
    toggleTile,
    toggle,
    move,
    handleDragEnd,
  } = draft;
  // Pointer for mouse and touch, keyboard for Tab + Space + arrows. The
  // arrow buttons on every row stay the primary keyboard surface.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A 6 px move before a drag starts, so the row switches keep their
      // clicks.
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  // The stored layout now round-trips the 11 iOS-only
  // widget ids so the native client can drop its local merge
  // workarounds. The web Settings list has no tile/chart
  // surface for them, so skip any id outside the web-known
  // ids rather than render an unlabelled row with dead toggles.
  // The skipped ids stay untouched in the persisted layout
  // because the Save mutation PUTs `layout.widgets` whole and
  // the server retains every catalogue id.
  //
  // The 8 B5 ids are WRITABLE (in
  // `DASHBOARD_WIDGET_IDS` so the iOS pin PUT validates) but
  // have no web render path either, so exclude
  // `IOS_PIN_ONLY_WIDGET_IDS` too: a web toggle for them would
  // be a silent no-op on the web dashboard.
  const iosPinOnly = new Set<string>(IOS_PIN_ONLY_WIDGET_IDS);
  const webWidgetIds = new Set<string>(
    DASHBOARD_WIDGET_IDS.filter((wid) => !iosPinOnly.has(wid)),
  );
  const sortedWidgets = [...layout.widgets]
    .filter((w): w is typeof w & { id: DashboardWidgetId } =>
      webWidgetIds.has(w.id),
    )
    // Hide a widget toggle whose owning module is off, through the
    // one surface map. A core widget has no owner and always shows;
    // only an explicit `false` hides the row.
    .filter((w) => isSurfaceVisible(`widget:${w.id}`, modules))
    .filter((w) => !unavailableIds.has(w.id))
    .sort((a, b) => a.order - b.order);
  const sortedIds = sortedWidgets.map((w) => w.id);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={sortedIds} strategy={verticalListSortingStrategy}>
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
              widgetLabel: t(WIDGET_LABEL_KEYS[widget.id] ?? widget.id),
            }}
            onToggleTile={toggleTile}
            onToggleChart={toggle}
            onMove={move}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

/**
 * Widgets the mobile app draws and this page does not (#581). The native
 * client materialises them into the same stored layout, so they get their
 * own labelled group: the same two flags, no reordering, and only for ids the
 * layout holds.
 */
export function NativeWidgetList({
  layout,
  draft,
}: {
  layout: DashboardLayout;
  draft: DashboardLayoutDraft;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const modules = user?.modules;
  const { unavailableIds, saveMutation, toggleTile, toggle } = draft;
  const nativeOnlyIds = new Set<string>([
    ...IOS_PIN_ONLY_WIDGET_IDS,
    ...DASHBOARD_IOS_ONLY_WIDGET_IDS,
  ]);
  const nativeWidgets = layout.widgets
    .filter((w) => nativeOnlyIds.has(w.id))
    // Same fail-open module gate as the web list: only an explicit
    // `false` hides the row.
    .filter((w) => isSurfaceVisible(`widget:${w.id}`, modules))
    .filter((w) => !unavailableIds.has(w.id))
    .sort((a, b) => a.order - b.order);
  if (nativeWidgets.length === 0) return null;
  return (
    <div
      data-slot="native-only-widgets"
      className="border-border/60 mt-6 space-y-2 border-t pt-4"
    >
      <p className="text-sm font-medium">
        {t("dashboard.layoutNativeOnlyTitle")}
      </p>
      <p className="text-muted-foreground text-xs">
        {t("dashboard.layoutNativeOnlyHint")}
      </p>
      <div className="text-muted-foreground flex items-center gap-2 px-3 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">
        <span className="flex-1" aria-hidden="true" />
        <span className="w-12 text-center">
          {t("dashboard.layoutTileColumn")}
        </span>
        <span className="w-12 text-center">
          {t("dashboard.layoutChartColumn")}
        </span>
      </div>
      {nativeWidgets.map((widget) => {
        const label = t(NATIVE_ONLY_WIDGET_LABEL_KEYS[widget.id] ?? widget.id);
        return (
          <StaticWidgetRow
            key={widget.id}
            widget={widget}
            disabled={saveMutation.isPending}
            labels={{
              tileColumn: t("dashboard.layoutTileColumn"),
              chartColumn: t("dashboard.layoutChartColumn"),
              widgetLabel: label,
            }}
            onToggleTile={toggleTile}
            onToggleChart={toggle}
          />
        );
      })}
    </div>
  );
}

/**
 * Sortable row primitive extracted from the section render
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

  // Honour the OS `prefers-reduced-motion` preference. The
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
    // Row sized at 48 px (`min-h-12`) with 44-px mobile tap
    // targets preserved on the trailing arrow buttons (`size-11`),
    // shrunk to `sm:size-9` on desktop. v1.4.47 W4 — `isDragging`
    // raises the row visually (elevation + accent ring) so the ghost
    // overlay is unambiguous during a drag.
    <div
      ref={setNodeRef}
      style={style}
      data-slot="widget-row"
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 flex-wrap items-center gap-2 rounded-md border px-3 py-2 sm:flex-nowrap ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle}: ${labels.widgetLabel}`}
        // `aria-describedby` is set after `{...attributes}`
        // so our shared hint paragraph wins over dnd-kit's own announcer
        // hookup. The announcer still fires on drag-start / drag-over /
        // drag-end via the screenReaderInstructions slot below.
        aria-describedby={dragHintId}
        title={labels.dragHandle}
        disabled={disabled}
        data-slot="widget-drag-handle"
        // W10 design-H1 — extend the WCAG 2.5.5 hit target to
        // 44 × 44 px via a `::before` pseudo-element while keeping the
        // visible GripVertical at 28 px (matches the Switch primitive
        // pattern from v1.4.43 W5-H1). v1.4.47 W10 design-M1 — drop
        // dnd-kit's CSS transition under prefers-reduced-motion.
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex-1 truncate text-sm" title={labels.widgetLabel}>
        {labels.widgetLabel}
      </span>
      {/* On a phone the two switches and two arrows (~250 px) left the name
          five characters ("Gewic…"). Below `sm` the controls wrap onto a
          second line, right-aligned under the column heads, and the name
          keeps the first line to itself. */}
      <span className="basis-full sm:hidden" aria-hidden="true" />
      <div className="flex w-12 justify-center max-sm:ml-auto">
        <Switch
          checked={tileChecked}
          onCheckedChange={(v) => onToggleTile(widget.id, v)}
          aria-label={`${labels.widgetLabel}: ${labels.tileColumn}`}
          disabled={disabled}
          data-slot="widget-tile-switch"
        />
      </div>
      <div className="flex w-12 justify-center">
        <Switch
          checked={widget.visible}
          onCheckedChange={(v) => onToggleChart(widget.id, v)}
          aria-label={`${labels.widgetLabel}: ${labels.chartColumn}`}
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

/**
 * issue #581 — one row in the native-only group: the same two switches as a
 * widget row above, without the drag handle or the arrow buttons. Placement
 * of these widgets belongs to the client that draws them, so the web offers
 * visibility and nothing it cannot honour.
 */
function StaticWidgetRow({
  widget,
  disabled,
  labels,
  onToggleTile,
  onToggleChart,
}: {
  widget: {
    id: DashboardWidgetCatalogueId;
    visible: boolean;
    tileVisible?: boolean;
    order: number;
  };
  disabled: boolean;
  labels: { tileColumn: string; chartColumn: string; widgetLabel: string };
  onToggleTile: (id: DashboardWidgetCatalogueId, value: boolean) => void;
  onToggleChart: (id: DashboardWidgetCatalogueId, value: boolean) => void;
}) {
  const tileChecked =
    typeof widget.tileVisible === "boolean"
      ? widget.tileVisible
      : widget.visible;

  return (
    <div
      data-slot="native-widget-row"
      data-widget-id={widget.id}
      className="border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
    >
      <span className="flex-1 truncate text-sm" title={labels.widgetLabel}>
        {labels.widgetLabel}
      </span>
      <div className="flex w-12 justify-center">
        <Switch
          checked={tileChecked}
          onCheckedChange={(v) => onToggleTile(widget.id, v)}
          aria-label={`${labels.widgetLabel}: ${labels.tileColumn}`}
          disabled={disabled}
          data-slot="widget-tile-switch"
        />
      </div>
      <div className="flex w-12 justify-center">
        <Switch
          checked={widget.visible}
          onCheckedChange={(v) => onToggleChart(widget.id, v)}
          aria-label={`${labels.widgetLabel}: ${labels.chartColumn}`}
          disabled={disabled}
          data-slot="widget-chart-switch"
        />
      </div>
    </div>
  );
}
