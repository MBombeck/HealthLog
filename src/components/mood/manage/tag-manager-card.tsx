"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  FolderInput,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
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

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError, apiPatch, apiPut } from "@/lib/api/api-fetch";
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
import { TagEditorSheet } from "./tag-editor-sheet";
import {
  categoryDisplayName,
  invalidateMoodTagCaches,
  moveTagToGroup,
  reorderGroupTags,
  setTagArchived,
  setTagHidden,
  snapshotManageCache,
  tagDisplayName,
  updateManageCache,
  type ManageCatalog,
  type ManageCategory,
  type ManageTag,
  type MoodTagLayoutResolved,
} from "./use-mood-tag-manage";

/**
 * v1.17 — per-group tag management for `/settings/mood`. Mirrors the
 * picker's grouping; every row carries: icon, label (custom label first,
 * i18n key second), a scale badge for RATED factors, the historical
 * usage count, an eye toggle (catalogue tag → per-user hide via
 * `PUT /[key]/hidden`; custom tag → archive via `PATCH … isActive`),
 * and a kebab with edit (custom only), move-to-group, and archive.
 *
 * Ordering follows the medication-order-editor grammar: drag buffers a
 * draft (explicit Save, one layout PUT), arrows write through
 * immediately (optimistic, rollback on error). Moving a catalogue tag
 * between groups is a per-user PLACEMENT (layout blob) — the shared
 * catalogue row itself never changes group; a custom tag moves for real
 * (`categoryKey` PATCH) with the placement map updated alongside so the
 * resolved order stays deterministic.
 */

interface TagManagerCardProps {
  catalog: ManageCatalog;
}

/** The card manages visible (non-archived) tags; archived rows live in the archived card. */
export function visibleCatalog(catalog: ManageCatalog): ManageCatalog {
  return {
    categories: catalog.categories.map((category) => ({
      ...category,
      tags: category.tags.filter((tag) => tag.archived !== true),
    })),
  };
}

/** Placement map of the visible tree: every group → its visible tag keys in order. */
export function buildVisiblePlacements(
  catalog: ManageCatalog,
): Record<string, string[]> {
  const placements: Record<string, string[]> = {};
  for (const category of visibleCatalog(catalog).categories) {
    placements[category.key] = category.tags.map((tag) => tag.key);
  }
  return placements;
}

export function TagManagerCard({ catalog }: TagManagerCardProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const dragHintId = useId();

  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTag, setEditorTag] = useState<
    | { key: string; label: string; icon: string | null; groupKey: string }
    | undefined
  >(undefined);

  const visible = visibleCatalog(catalog);
  const dirty = Object.keys(drafts).length > 0;

  const groupOptions = visible.categories.map((category) => ({
    key: category.key,
    name: categoryDisplayName(category, t),
  }));

  function orderedKeys(category: ManageCategory): string[] {
    return drafts[category.key] ?? category.tags.map((tag) => tag.key);
  }

  /** Apply current drafts onto the visible tree, then PUT the placement map. */
  async function putPlacements(nextCatalog: ManageCatalog): Promise<boolean> {
    const rollback = await snapshotManageCache(queryClient);
    updateManageCache(queryClient, () => mergeBack(catalog, nextCatalog));
    try {
      // v1.32.22 (R5b) — echo + seed the layout token (see `putGroupOrder` in
      // the groups card): the sibling group-order card writes the same blob, so
      // a stale placements merge is exactly the overwrite the token 409s.
      const resolved = await apiPut<MoodTagLayoutResolved>(
        "/api/mood/tags/layout",
        withBaseToken(
          { placements: buildVisiblePlacements(nextCatalog) },
          readUpdatedAtToken(queryClient, queryKeys.moodTagLayout()),
        ),
      );
      queryClient.setQueryData(queryKeys.moodTagLayout(), resolved);
      toast.success(t("mood.manage.orderSaved"));
      return true;
    } catch (err) {
      rollback();
      if (isConflict(err)) {
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

  /** Arrow press: immediate optimistic PUT unless a drag session is open. */
  function moveByArrow(groupKey: string, tagKey: string, delta: -1 | 1) {
    const category = visible.categories.find((c) => c.key === groupKey);
    if (!category) return;
    const keys = orderedKeys(category);
    const idx = keys.indexOf(tagKey);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= keys.length) return;
    const next = reorderById(
      keys.map((id, order) => ({ id, order })),
      tagKey,
      keys[target],
    ).map((row) => row.id);
    if (dirty) {
      setDrafts((prev) => ({ ...prev, [groupKey]: next }));
    } else {
      void putPlacements(reorderGroupTags(visible, groupKey, next));
    }
  }

  function handleDragEnd(groupKey: string, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const category = visible.categories.find((c) => c.key === groupKey);
    if (!category) return;
    const keys = orderedKeys(category);
    const next = reorderById(
      keys.map((id, order) => ({ id, order })),
      String(active.id),
      String(over.id),
    ).map((row) => row.id);
    setDrafts((prev) => ({ ...prev, [groupKey]: next }));
  }

  async function saveDrafts() {
    setSaving(true);
    let next = visible;
    for (const [groupKey, keys] of Object.entries(drafts)) {
      next = reorderGroupTags(next, groupKey, keys);
    }
    const ok = await putPlacements(next);
    setSaving(false);
    if (ok) setDrafts({});
  }

  /** Eye toggle — catalogue hide/show or custom archive. */
  async function toggleVisibility(tag: ManageTag) {
    const rollback = await snapshotManageCache(queryClient);
    try {
      if (tag.custom) {
        updateManageCache(queryClient, (c) => setTagArchived(c, tag.key, true));
        await apiPatch(`/api/mood/tags/custom/${encodeURIComponent(tag.key)}`, {
          isActive: false,
        });
      } else {
        const nextHidden = tag.hidden !== true;
        updateManageCache(queryClient, (c) =>
          setTagHidden(c, tag.key, nextHidden),
        );
        await apiPut(`/api/mood/tags/${encodeURIComponent(tag.key)}/hidden`, {
          hidden: nextHidden,
        });
      }
    } catch (err) {
      rollback();
      toast.error(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      void invalidateMoodTagCaches(queryClient);
    }
  }

  /** Move a tag to another group (custom: relational; catalogue: placement). */
  async function moveToGroup(tag: ManageTag, targetGroupKey: string) {
    const moved = moveTagToGroup(visible, tag.key, targetGroupKey);
    const rollback = await snapshotManageCache(queryClient);
    updateManageCache(queryClient, () => mergeBack(catalog, moved));
    try {
      if (tag.custom) {
        await apiPatch(`/api/mood/tags/custom/${encodeURIComponent(tag.key)}`, {
          categoryKey: targetGroupKey,
        });
      }
      // Both kinds pin the resulting per-group order in the layout blob
      // so the resolved tree matches what the user just saw happen.
      // v1.32.22 (R5b) — echo + seed the layout token so a concurrent write to
      // the same blob 409s instead of clobbering.
      const resolved = await apiPut<MoodTagLayoutResolved>(
        "/api/mood/tags/layout",
        withBaseToken(
          { placements: buildVisiblePlacements(moved) },
          readUpdatedAtToken(queryClient, queryKeys.moodTagLayout()),
        ),
      );
      queryClient.setQueryData(queryKeys.moodTagLayout(), resolved);
      toast.success(t("common.saved"));
    } catch (err) {
      rollback();
      if (isConflict(err)) {
        queryClient.removeQueries({ queryKey: queryKeys.moodTagLayout() });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      void invalidateMoodTagCaches(queryClient);
    }
  }

  return (
    // `relative` anchors the sr-only drag-hint paragraph: `sr-only` is
    // absolutely positioned, and without a positioned ancestor its 1px box
    // lands below the list in DOCUMENT coordinates and makes the document
    // itself scrollable (second scrollbar — UI-STANDARDS §9 one-scroll-floor).
    <div className="relative space-y-4" data-slot="mood-tag-manager-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground min-w-0 text-xs">
          {t("mood.manage.tagsDescription")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 shrink-0 sm:min-h-9"
          onClick={() => {
            setEditorTag(undefined);
            setEditorOpen(true);
          }}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("mood.manage.newTag")}
        </Button>
      </div>

      {visible.categories.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("common.noData")}</p>
      )}

      {visible.categories.map((category) => {
        const keys = orderedKeys(category);
        const byKey = new Map(category.tags.map((tag) => [tag.key, tag]));
        return (
          <TagGroupSection
            key={category.key}
            heading={categoryDisplayName(category, t)}
            HeadingIcon={moodTagIcon(category.icon)}
            groupKey={category.key}
            keys={keys}
            byKey={byKey}
            dragHintId={dragHintId}
            disabled={saving}
            groupOptions={groupOptions}
            onDragEnd={handleDragEnd}
            onMove={moveByArrow}
            onToggleVisibility={(tag) => void toggleVisibility(tag)}
            onMoveToGroup={(tag, target) => void moveToGroup(tag, target)}
            onEdit={(tag) => {
              setEditorTag({
                key: tag.key,
                label: tagDisplayName(tag, t),
                icon: tag.icon,
                groupKey: category.key,
              });
              setEditorOpen(true);
            }}
          />
        );
      })}

      <p id={dragHintId} className="text-muted-foreground sr-only">
        {t("dashboard.dragHandleHint")}
      </p>

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDrafts({})}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => void saveDrafts()} disabled={saving}>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("mood.manage.orderSave")}
          </Button>
        </div>
      )}

      {editorOpen && (
        <TagEditorSheet
          open
          onOpenChange={(next) => {
            if (!next) setEditorOpen(false);
          }}
          groups={groupOptions}
          tag={editorTag}
        />
      )}
    </div>
  );
}

/**
 * Write an updated VISIBLE tree back over the full manage tree without
 * losing the archived rows the visible projection filtered out.
 */
export function mergeBack(
  full: ManageCatalog,
  nextVisible: ManageCatalog,
): ManageCatalog {
  const archivedByGroup = new Map<string, ManageTag[]>();
  for (const category of full.categories) {
    archivedByGroup.set(
      category.key,
      category.tags.filter((tag) => tag.archived === true),
    );
  }
  return {
    categories: nextVisible.categories.map((category) => ({
      ...category,
      tags: [...category.tags, ...(archivedByGroup.get(category.key) ?? [])],
    })),
  };
}

interface TagGroupSectionProps {
  heading: string;
  /** Resolved by the host's map callback (react-hooks/static-components). */
  HeadingIcon: LucideIcon;
  groupKey: string;
  keys: string[];
  byKey: ReadonlyMap<string, ManageTag>;
  dragHintId: string;
  disabled: boolean;
  groupOptions: { key: string; name: string }[];
  onDragEnd: (groupKey: string, event: DragEndEvent) => void;
  onMove: (groupKey: string, tagKey: string, delta: -1 | 1) => void;
  onToggleVisibility: (tag: ManageTag) => void;
  onMoveToGroup: (tag: ManageTag, targetGroupKey: string) => void;
  onEdit: (tag: ManageTag) => void;
}

function TagGroupSection({
  heading,
  HeadingIcon,
  groupKey,
  keys,
  byKey,
  dragHintId,
  disabled,
  groupOptions,
  onDragEnd,
  onMove,
  onToggleVisibility,
  onMoveToGroup,
  onEdit,
}: TagGroupSectionProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const rows = keys
    .map((key) => byKey.get(key))
    .filter((tag): tag is ManageTag => tag !== undefined);

  return (
    <div
      className="space-y-2"
      data-slot="mood-tag-manage-group"
      data-group={groupKey}
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <HeadingIcon className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{heading}</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => onDragEnd(groupKey, event)}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          {rows.map((tag, index) => (
            <SortableTagRow
              key={tag.key}
              tag={tag}
              Icon={moodTagIcon(tag.icon)}
              groupKey={groupKey}
              index={index}
              total={rows.length}
              dragHintId={dragHintId}
              disabled={disabled}
              groupOptions={groupOptions}
              onMove={onMove}
              onToggleVisibility={onToggleVisibility}
              onMoveToGroup={onMoveToGroup}
              onEdit={onEdit}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface SortableTagRowProps {
  tag: ManageTag;
  /** Resolved by the host's map callback (react-hooks/static-components). */
  Icon: LucideIcon;
  groupKey: string;
  index: number;
  total: number;
  dragHintId: string;
  disabled: boolean;
  groupOptions: { key: string; name: string }[];
  onMove: (groupKey: string, tagKey: string, delta: -1 | 1) => void;
  onToggleVisibility: (tag: ManageTag) => void;
  onMoveToGroup: (tag: ManageTag, targetGroupKey: string) => void;
  onEdit: (tag: ManageTag) => void;
}

function SortableTagRow({
  tag,
  Icon,
  groupKey,
  index,
  total,
  dragHintId,
  disabled,
  groupOptions,
  onMove,
  onToggleVisibility,
  onMoveToGroup,
  onEdit,
}: SortableTagRowProps) {
  const { t } = useTranslations();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tag.key });
  const name = tagDisplayName(tag, t);
  const isHidden = tag.hidden === true;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="mood-tag-manage-row"
      data-tag={tag.key}
      data-hidden={isHidden ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      } ${isHidden ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${t("dashboard.dragHandle")}: ${name}`}
        aria-describedby={dragHintId}
        title={t("dashboard.dragHandle")}
        disabled={disabled}
        data-slot="mood-tag-drag-handle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Icon
        className="text-muted-foreground h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-[8rem] flex-1 truncate text-sm" title={name}>
        {name}
      </span>
      {tag.kind === "RATED" && (
        <Badge variant="outline" className="tabular-nums">
          {tag.scaleMin}–{tag.scaleMax}
        </Badge>
      )}
      {typeof tag.usageCount === "number" && tag.usageCount > 0 && (
        <Badge variant="secondary" className="tabular-nums">
          {t("mood.manage.usageCount", { count: String(tag.usageCount) })}
        </Badge>
      )}
      {/* The action cluster wraps to its own line on a narrow row so the
          tag name keeps a readable floor instead of truncating away. */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 sm:size-9"
          onClick={() => onToggleVisibility(tag)}
          disabled={disabled}
          aria-pressed={tag.custom ? undefined : isHidden}
          aria-label={`${
            tag.custom
              ? t("mood.manage.archive")
              : isHidden
                ? t("mood.manage.showTag")
                : t("mood.manage.hideTag")
          }: ${name}`}
          title={
            tag.custom
              ? t("mood.manage.archive")
              : isHidden
                ? t("mood.manage.showTag")
                : t("mood.manage.hideTag")
          }
        >
          {tag.custom ? (
            <Archive className="h-4 w-4" aria-hidden="true" />
          ) : isHidden ? (
            <EyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 sm:size-9"
          onClick={() => onMove(groupKey, tag.key, -1)}
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
          onClick={() => onMove(groupKey, tag.key, 1)}
          disabled={index === total - 1 || disabled}
          aria-label={`${t("mood.manage.moveDown")}: ${name}`}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
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
            {tag.custom && (
              <DropdownMenuItem onClick={() => onEdit(tag)}>
                <Pencil className="mr-2 h-4 w-4" />
                {t("common.edit")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput className="mr-2 h-4 w-4" />
                {t("mood.manage.moveToGroup")}
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  {groupOptions
                    .filter((group) => group.key !== groupKey)
                    .map((group) => (
                      <DropdownMenuItem
                        key={group.key}
                        onClick={() => onMoveToGroup(tag, group.key)}
                      >
                        {group.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
            {tag.custom && (
              <DropdownMenuItem onClick={() => onToggleVisibility(tag)}>
                <Archive className="mr-2 h-4 w-4" />
                {t("mood.manage.archive")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
