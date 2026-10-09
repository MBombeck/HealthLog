"use client";

import { useId } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
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
import { reorderById } from "@/lib/insights-layout-reorder";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.18.6 (W8 / MOD-03) — generic, controlled reorder list shared by the
 * Vorsorge / Illness / Labs settings pages.
 *
 * A single section (no active/inactive split — the secondary modules have a
 * flat list) with the same vocabulary as the medication order editor: an
 * `@dnd-kit` drag handle (pointer + keyboard sensors) plus per-row up/down
 * arrow buttons as the primary keyboard surface. Unlike the medication
 * editor it is fully controlled — there is no Save/Cancel draft state
 * because the host persists each move immediately to the localStorage order
 * (the choice is presentational, not a server write). The swap-and-renumber
 * logic is the shared `reorderById` helper so the order semantics match the
 * dashboard / insights / medications surfaces exactly.
 */

export interface ReorderItem {
  id: string;
  /** Primary label (bold). */
  name: string;
  /** Optional secondary line (muted). */
  secondary?: string;
}

interface ModuleOrderEditorProps {
  /** The list in its current effective order. */
  items: ReorderItem[];
  /** Persist the full id order after every move. */
  onChange: (order: string[]) => void;
}

export function ModuleOrderEditor({ items, onChange }: ModuleOrderEditorProps) {
  const { t } = useTranslations();
  const dragHintId = useId();
  const ids = items.map((i) => i.id);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const labels = {
    moveUp: t("dashboard.moveUp"),
    moveDown: t("dashboard.moveDown"),
    dragHandle: t("dashboard.dragHandle"),
  };

  function applyReorder(fromId: string, toId: string) {
    onChange(
      reorderById(
        ids.map((id, order) => ({ id, order })),
        fromId,
        toId,
      ).map((r) => r.id),
    );
  }

  function move(id: string, delta: -1 | 1) {
    const idx = ids.indexOf(id);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= ids.length) return;
    applyReorder(id, ids[targetIdx]);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    applyReorder(String(active.id), String(over.id));
  }

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("moduleList.reorder.empty")}
      </p>
    );
  }

  return (
    // `relative` anchors the sr-only drag-hint paragraph: `sr-only` is
    // absolutely positioned, and without a positioned ancestor its 1px box
    // lands below the list in DOCUMENT coordinates and makes the document
    // itself scrollable (second scrollbar — UI-STANDARDS §9 one-scroll-floor).
    <div className="relative space-y-2" data-slot="module-order-editor">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {items.map((item, index) => (
            <SortableRow
              key={item.id}
              item={item}
              index={index}
              total={items.length}
              dragHintId={dragHintId}
              labels={labels}
              onMove={move}
            />
          ))}
        </SortableContext>
      </DndContext>
      <p id={dragHintId} className="text-muted-foreground sr-only">
        {t("dashboard.dragHandleHint")}
      </p>
    </div>
  );
}

interface SortableRowProps {
  item: ReorderItem;
  index: number;
  total: number;
  dragHintId: string;
  labels: { moveUp: string; moveDown: string; dragHandle: string };
  onMove: (id: string, delta: -1 | 1) => void;
}

function SortableRow({
  item,
  index,
  total,
  dragHintId,
  labels,
  onMove,
}: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="module-reorder-row"
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle}: ${item.name}`}
        aria-describedby={dragHintId}
        title={labels.dragHandle}
        data-slot="module-drag-handle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 text-sm">
        <span className="block truncate font-medium" title={item.name}>
          {item.name}
        </span>
        {item.secondary ? (
          <span className="text-muted-foreground block truncate text-xs">
            {item.secondary}
          </span>
        ) : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(item.id, -1)}
        disabled={index === 0}
        aria-label={`${labels.moveUp}: ${item.name}`}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(item.id, 1)}
        disabled={index === total - 1}
        aria-label={`${labels.moveDown}: ${item.name}`}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
