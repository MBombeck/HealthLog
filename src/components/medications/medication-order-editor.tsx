"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical, Loader2 } from "lucide-react";
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
import { formatDose } from "@/lib/medications/format-dose";
import { runSaveMedicationListOrder } from "@/lib/queries/use-medication-list-layout";

/**
 * v1.16.10 — manual medication ordering, shared by BOTH /medications
 * views (cards + table). Reuses the dashboard / insights reorder
 * vocabulary: a vertical row list with a drag handle (@dnd-kit, pointer
 * + keyboard sensors) AND per-row up/down arrow buttons as the primary
 * keyboard surface, flushed by an explicit Save. The swap-and-renumber
 * logic is the shared `reorderById` helper the inline Insights edit
 * mode rides (the standalone extraction of the dashboard's
 * `reorderWidgets` contract), so the surfaces cannot drift.
 *
 * Hosted inline by the Medikamente settings section
 * (`/settings/medications`), exactly like the dashboard layout editor
 * lives under `/settings/dashboard` — the editor used to be a dialog on
 * the /medications page; the page header now links here instead.
 *
 * The editor mirrors the page's grouping: an Aktiv section and an
 * Inaktiv section (muted heading), each with its own drag context and
 * arrow bounds, so a row can only move WITHIN its group — both views
 * pin inactive medications after the active block, and an order that
 * crossed the boundary could never render. Save persists the id order
 * (active ids first, then inactive ids) through
 * `PUT /api/medications/layout` (order-only, the stored view is
 * preserved server-side). The Save / Cancel pair only appears once a
 * draft exists, following the dashboard layout section's draft state
 * machine.
 */

export interface ReorderMedication {
  id: string;
  name: string;
  dose: string;
  active: boolean;
}

interface MedicationOrderEditorProps {
  /** The full list in its current effective order (active block first). */
  medications: ReorderMedication[];
}

/**
 * Saved-order composition: active ids always precede inactive ids,
 * matching the render grouping of both list views. Exported so tests
 * can pin that an inactive id cannot land above an active one.
 */
export function buildSavedOrder(
  activeIds: readonly string[],
  inactiveIds: readonly string[],
): string[] {
  return [...activeIds, ...inactiveIds];
}

/**
 * Arrow-button move, bounded to the section: swapping past either end
 * returns the input untouched, so the boundary between the groups is
 * unreachable by construction.
 */
export function moveWithinSection(
  ids: readonly string[],
  id: string,
  delta: -1 | 1,
): string[] {
  const idx = ids.indexOf(id);
  const targetIdx = idx + delta;
  if (idx < 0 || targetIdx < 0 || targetIdx >= ids.length) return [...ids];
  return reorderById(
    ids.map((rowId, order) => ({ id: rowId, order })),
    id,
    ids[targetIdx],
  ).map((r) => r.id);
}

export function MedicationOrderEditor({
  medications,
}: MedicationOrderEditorProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const dragHintId = useId();
  const [saving, setSaving] = useState(false);
  // Per-section draft id order — null means "the order the host passed
  // in". Created on the first move so an untouched editor renders the
  // persisted order without churn; Cancel simply clears the drafts.
  const [draftActive, setDraftActive] = useState<string[] | null>(null);
  const [draftInactive, setDraftInactive] = useState<string[] | null>(null);

  const byId = new Map(medications.map((m) => [m.id, m]));
  const activeIds =
    draftActive ?? medications.filter((m) => m.active).map((m) => m.id);
  const inactiveIds =
    draftInactive ?? medications.filter((m) => !m.active).map((m) => m.id);

  const labels = {
    moveUp: t("dashboard.moveUp"),
    moveDown: t("dashboard.moveDown"),
    dragHandle: t("dashboard.dragHandle"),
    inactive: t("common.inactive"),
  };

  async function save() {
    setSaving(true);
    const ok = await runSaveMedicationListOrder({
      order: buildSavedOrder(activeIds, inactiveIds),
      queryClient,
      t,
    });
    setSaving(false);
    if (ok) {
      setDraftActive(null);
      setDraftInactive(null);
    }
  }

  function cancel() {
    setDraftActive(null);
    setDraftInactive(null);
  }

  // Presence of a draft implies dirty — no JSON comparison needed.
  const dirty = draftActive !== null || draftInactive !== null;

  return (
    // `relative` anchors the sr-only drag-hint paragraph: `sr-only` is
    // absolutely positioned, and without a positioned ancestor its 1px box
    // lands below the list in DOCUMENT coordinates and makes the document
    // itself scrollable (second scrollbar — UI-STANDARDS §9 one-scroll-floor).
    <div className="relative space-y-4" data-slot="medication-order-editor">
      {medications.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t("medications.emptyTitle")}
        </p>
      )}
      {activeIds.length > 0 && (
        <ReorderSection
          heading={t("common.active")}
          ids={activeIds}
          byId={byId}
          dragHintId={dragHintId}
          disabled={saving}
          labels={labels}
          onChange={setDraftActive}
          dataSlot="medication-reorder-section-active"
        />
      )}
      {inactiveIds.length > 0 && (
        <ReorderSection
          heading={t("common.inactive")}
          ids={inactiveIds}
          byId={byId}
          dragHintId={dragHintId}
          disabled={saving}
          labels={labels}
          onChange={setDraftInactive}
          dataSlot="medication-reorder-section-inactive"
        />
      )}
      {activeIds.length + inactiveIds.length > 0 && (
        <p id={dragHintId} className="text-muted-foreground sr-only">
          {t("dashboard.dragHandleHint")}
        </p>
      )}

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={cancel}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </div>
      )}
    </div>
  );
}

interface ReorderSectionProps {
  heading: string;
  ids: string[];
  byId: ReadonlyMap<string, ReorderMedication>;
  dragHintId: string;
  disabled: boolean;
  labels: {
    moveUp: string;
    moveDown: string;
    dragHandle: string;
    inactive: string;
  };
  onChange: (ids: string[]) => void;
  dataSlot: string;
}

/**
 * One group (Aktiv or Inaktiv) with its OWN DndContext + SortableContext:
 * a drag started in one section cannot drop into the other, and the
 * arrow buttons stop at the section bounds — the saved order keeps the
 * active block first by construction.
 */
function ReorderSection({
  heading,
  ids,
  byId,
  dragHintId,
  disabled,
  labels,
  onChange,
  dataSlot,
}: ReorderSectionProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const rows = ids
    .map((id) => byId.get(id))
    .filter((m): m is ReorderMedication => m !== undefined);

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
    const next = moveWithinSection(ids, id, delta);
    if (next.some((v, i) => v !== ids[i])) onChange(next);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    applyReorder(String(active.id), String(over.id));
  }

  return (
    <div className="space-y-2" data-slot={dataSlot}>
      <p className="text-muted-foreground text-xs font-medium">{heading}</p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {rows.map((med, index) => (
            <SortableMedicationRow
              key={med.id}
              medication={med}
              index={index}
              total={rows.length}
              dragHintId={dragHintId}
              disabled={disabled}
              labels={labels}
              onMove={move}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface SortableMedicationRowProps {
  medication: ReorderMedication;
  index: number;
  total: number;
  dragHintId: string;
  disabled: boolean;
  labels: {
    moveUp: string;
    moveDown: string;
    dragHandle: string;
    inactive: string;
  };
  onMove: (id: string, delta: -1 | 1) => void;
}

function SortableMedicationRow({
  medication,
  index,
  total,
  dragHintId,
  disabled,
  labels,
  onMove,
}: SortableMedicationRowProps) {
  const { t } = useTranslations();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: medication.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="medication-reorder-row"
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle}: ${medication.name}`}
        aria-describedby={dragHintId}
        title={labels.dragHandle}
        disabled={disabled}
        data-slot="medication-drag-handle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 text-sm">
        <span className="block truncate font-medium" title={medication.name}>
          {medication.name}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {formatDose(medication.dose, t)}
          {!medication.active && <> · {labels.inactive}</>}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(medication.id, -1)}
        disabled={index === 0 || disabled}
        aria-label={`${labels.moveUp}: ${medication.name}`}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(medication.id, 1)}
        disabled={index === total - 1 || disabled}
        aria-label={`${labels.moveDown}: ${medication.name}`}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
