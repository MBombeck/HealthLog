"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  FolderPlus,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  type LucideIcon,
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
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  ApiError,
  apiDelete,
  apiPatch,
  apiPost,
  apiPut,
} from "@/lib/api/api-fetch";
import {
  readUpdatedAtToken,
  withBaseToken,
  isConflict,
} from "@/lib/api/optimistic-token";
import { queryKeys } from "@/lib/query-keys";
import { reorderById } from "@/lib/insights-layout-reorder";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "../mood-tag-icons";
import { MoodTagIconPicker } from "../mood-tag-icon-picker";
import {
  buildGroupOrder,
  categoryDisplayName,
  invalidateMoodTagCaches,
  reorderGroups,
  snapshotManageCache,
  updateManageCache,
  type ManageCatalog,
  type MoodTagLayoutResolved,
} from "./use-mood-tag-manage";

/**
 * v1.17 — group management card for `/settings/mood`. Lists every
 * group of the effective tree (seeded + own) in picker order and reuses
 * the medication-order-editor interaction grammar: a drag handle
 * (@dnd-kit, pointer + keyboard sensors) buffers a draft flushed by an
 * explicit Save, while the per-row arrow buttons write through
 * immediately (one optimistic layout PUT per press). Own groups carry a
 * kebab with rename (label + icon) and delete; seeded groups reorder
 * only — they are shared reference data.
 *
 * Group delete is non-destructive by contract: the server re-homes the
 * group's custom tags back to the seeded Custom group and catalogue
 * placements evaporate to their original category; the confirm dialog
 * says exactly that.
 */

const GROUP_LABEL_MAX = 40;

interface TagGroupsCardProps {
  catalog: ManageCatalog;
}

/** Arrow move bounded to the list ends (same contract as medications). */
export function moveGroupKey(
  keys: readonly string[],
  key: string,
  delta: -1 | 1,
): string[] {
  const idx = keys.indexOf(key);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= keys.length) return [...keys];
  return reorderById(
    keys.map((id, order) => ({ id, order })),
    key,
    keys[target],
  ).map((row) => row.id);
}

export function TagGroupsCard({ catalog }: TagGroupsCardProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const dragHintId = useId();

  const [draftOrder, setDraftOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [deleteKey, setDeleteKey] = useState<string | null>(null);

  const serverOrder = buildGroupOrder(catalog);
  const order = draftOrder ?? serverOrder;
  const byKey = new Map(catalog.categories.map((c) => [c.key, c]));
  const dirty = draftOrder !== null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  async function putGroupOrder(nextOrder: string[]): Promise<boolean> {
    const rollback = await snapshotManageCache(queryClient);
    updateManageCache(queryClient, (current) =>
      reorderGroups(current, nextOrder),
    );
    try {
      // v1.32.22 (R5b) — echo the base token this order was based on. The two
      // cards on this page write DIFFERENT fields of the same blob (group order
      // vs tag placements); a stale merge would resurrect the other card's
      // overwritten field, which the token now 409s instead. Seed the token
      // from the response so the next write on this surface is guarded too.
      const resolved = await apiPut<MoodTagLayoutResolved>(
        "/api/mood/tags/layout",
        withBaseToken(
          { groupOrder: nextOrder },
          readUpdatedAtToken(queryClient, queryKeys.moodTagLayout()),
        ),
      );
      queryClient.setQueryData(queryKeys.moodTagLayout(), resolved);
      toast.success(t("mood.manage.orderSaved"));
      return true;
    } catch (err) {
      rollback();
      if (isConflict(err)) {
        // Drop the stale token so a deliberate retry writes against the tree
        // the invalidation below reloads; nudge — the optimistic delta rolled
        // back and nothing was clobbered.
        queryClient.removeQueries({ queryKey: queryKeys.moodTagLayout() });
        toast.message(t("common.conflictReloaded"));
        return false;
      }
      toast.error(err instanceof ApiError ? err.message : t("common.error"));
      return false;
    } finally {
      void invalidateMoodTagCaches(queryClient);
    }
  }

  /** Arrow press: immediate optimistic PUT unless a drag draft is open. */
  function moveByArrow(key: string, delta: -1 | 1) {
    const next = moveGroupKey(order, key, delta);
    if (next.every((v, i) => v === order[i])) return;
    if (dirty) {
      setDraftOrder(next);
    } else {
      void putGroupOrder(next);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraftOrder(
      reorderById(
        order.map((id, idx) => ({ id, order: idx })),
        String(active.id),
        String(over.id),
      ).map((row) => row.id),
    );
  }

  async function saveDraft() {
    if (!draftOrder) return;
    setSaving(true);
    const ok = await putGroupOrder(draftOrder);
    setSaving(false);
    if (ok) setDraftOrder(null);
  }

  const editing = editingKey ? byKey.get(editingKey) : undefined;
  const deleting = deleteKey ? byKey.get(deleteKey) : undefined;
  const customGroupCount = catalog.categories.filter((c) => c.custom).length;

  return (
    // `relative` anchors the sr-only drag-hint paragraph: `sr-only` is
    // absolutely positioned, and without a positioned ancestor its 1px box
    // lands below the list in DOCUMENT coordinates and makes the document
    // itself scrollable (second scrollbar — UI-STANDARDS §9 one-scroll-floor).
    <div className="relative space-y-3" data-slot="mood-tag-groups-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground min-w-0 text-xs">
          {t("mood.manage.groupsDescription")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 shrink-0 sm:min-h-9"
          onClick={() => {
            setEditingKey(null);
            setEditorOpen(true);
          }}
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" />
          {t("mood.manage.newGroup")}
        </Button>
      </div>

      {customGroupCount === 0 && (
        <p
          className="text-muted-foreground text-sm"
          data-slot="mood-groups-empty"
        >
          {t("mood.manage.groupEmpty")}
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {order.map((key, index) => {
              const group = byKey.get(key);
              if (!group) return null;
              return (
                <SortableGroupRow
                  key={key}
                  groupKey={key}
                  name={categoryDisplayName(group, t)}
                  Icon={moodTagIcon(group.icon)}
                  custom={group.custom === true}
                  tagCount={group.tags.length}
                  index={index}
                  total={order.length}
                  dragHintId={dragHintId}
                  disabled={saving}
                  onMove={moveByArrow}
                  onEdit={() => {
                    setEditingKey(key);
                    setEditorOpen(true);
                  }}
                  onDelete={() => setDeleteKey(key)}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
      <p id={dragHintId} className="text-muted-foreground sr-only">
        {t("dashboard.dragHandleHint")}
      </p>

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraftOrder(null)}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => void saveDraft()} disabled={saving}>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("mood.manage.orderSave")}
          </Button>
        </div>
      )}

      {editorOpen && (
        <GroupEditorSheet
          open
          onOpenChange={(next) => {
            if (!next) setEditorOpen(false);
          }}
          group={
            editing && editing.custom
              ? {
                  key: editing.key,
                  label: categoryDisplayName(editing, t),
                  icon: editing.icon,
                }
              : undefined
          }
        />
      )}

      <AlertDialog
        open={deleteKey !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteKey(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mood.manage.groupDeleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mood.manage.groupDeleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const key = deleting?.key;
                setDeleteKey(null);
                if (!key) return;
                void (async () => {
                  try {
                    await apiDelete(
                      `/api/mood/tags/groups/${encodeURIComponent(key)}`,
                    );
                    toast.success(t("mood.manage.groupDeleted"));
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.message : t("common.error"),
                    );
                  } finally {
                    void invalidateMoodTagCaches(queryClient);
                  }
                })();
              }}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface SortableGroupRowProps {
  groupKey: string;
  name: string;
  /** Resolved by the host's map callback (react-hooks/static-components). */
  Icon: LucideIcon;
  custom: boolean;
  tagCount: number;
  index: number;
  total: number;
  dragHintId: string;
  disabled: boolean;
  onMove: (key: string, delta: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function SortableGroupRow({
  groupKey,
  name,
  Icon,
  custom,
  tagCount,
  index,
  total,
  dragHintId,
  disabled,
  onMove,
  onEdit,
  onDelete,
}: SortableGroupRowProps) {
  const { t } = useTranslations();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: groupKey });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="mood-group-row"
      data-group={groupKey}
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${t("dashboard.dragHandle")}: ${name}`}
        aria-describedby={dragHintId}
        title={t("dashboard.dragHandle")}
        disabled={disabled}
        data-slot="mood-group-drag-handle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Icon
        className="text-muted-foreground h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={name}
      >
        {name}
      </span>
      <Badge variant="outline" className="tabular-nums">
        {tagCount}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(groupKey, -1)}
        disabled={index === 0 || disabled}
        aria-label={`${t("mood.manage.moveUp")}: ${name}`}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(groupKey, 1)}
        disabled={index === total - 1 || disabled}
        aria-label={`${t("mood.manage.moveDown")}: ${name}`}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
      {custom && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 sm:size-9"
              aria-label={`${t("common.moreOptions")}: ${name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 h-4 w-4" />
              {t("common.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

interface GroupEditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → rename mode for this custom group. */
  group?: { key: string; label: string; icon: string | null };
}

function GroupEditorSheet({
  open,
  onOpenChange,
  group,
}: GroupEditorSheetProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const formId = useId();
  const labelInputId = useId();

  // The host mounts this sheet conditionally, so the field state seeds
  // fresh from props on every open — no re-seeding effect needed.
  const isEdit = group !== undefined;
  const [label, setLabel] = useState(group?.label ?? "");
  const [icon, setIcon] = useState<string | null>(group?.icon ?? "Tag");
  const [saving, setSaving] = useState(false);

  const trimmed = label.trim();
  const valid = trimmed.length > 0 && trimmed.length <= GROUP_LABEL_MAX;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      if (isEdit) {
        await apiPatch(
          `/api/mood/tags/groups/${encodeURIComponent(group.key)}`,
          {
            ...(trimmed !== group.label ? { label: trimmed } : {}),
            ...(icon !== group.icon ? { icon } : {}),
          },
        );
        toast.success(t("mood.manage.groupRenamed"));
      } else {
        await apiPost("/api/mood/tags/groups", { label: trimmed, icon });
        toast.success(t("mood.manage.groupCreated"));
      }
      onOpenChange(false);
      void invalidateMoodTagCaches(queryClient);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        toast.error(t("mood.manage.groupLimitReached"));
      } else {
        toast.error(err instanceof ApiError ? err.message : t("common.error"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t("common.edit") : t("mood.manage.newGroup")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={saving || !valid}>
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-4"
        data-slot="mood-group-editor"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={labelInputId}>{t("mood.manage.groupLabel")}</Label>
            <span
              className={`text-xs tabular-nums ${
                label.length >= GROUP_LABEL_MAX
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
              aria-live="polite"
            >
              {t("mood.noteCharCount", {
                count: String(label.length),
                max: String(GROUP_LABEL_MAX),
              })}
            </span>
          </div>
          <Input
            id={labelInputId}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={GROUP_LABEL_MAX}
            autoFocus
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="done"
            required
            aria-required="true"
          />
        </div>

        <div className="space-y-2">
          <Label>{t("mood.manage.groupIcon")}</Label>
          <MoodTagIconPicker value={icon} onChange={setIcon} />
        </div>
      </form>
    </ResponsiveSheet>
  );
}
