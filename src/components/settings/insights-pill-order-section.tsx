"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, EyeOff, GripVertical, ListOrdered, Loader2 } from "lucide-react";
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
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useInsightsLayoutQuery } from "@/hooks/use-insights-layout";
import {
  reorderById,
  rebuildTilesWithReorderedVitals,
} from "@/lib/insights-layout-reorder";
import {
  type InsightsLayoutWithToken,
  type InsightsTileConfig,
} from "@/lib/insights-layout";
import {
  MANAGER_GROUP_ORDER,
  SUB_PAGE_MANAGER_GROUP_SLUGS,
  type ManagerGroup,
} from "@/lib/insights/sub-page-metric";
import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";
import { apiPut } from "@/lib/api/api-fetch";
import {
  readUpdatedAtToken,
  withBaseToken,
  isConflict,
} from "@/lib/api/optimistic-token";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";

/**
 * v1.15.18 — dedicated pill-sort control for the Insights settings section.
 * v1.15.20 — pill VISIBILITY joins the same list: each row carries the eye
 * toggle the overview edit cards use, flipping `tiles[].visible` (the field
 * that already gates both the top-nav pill and the overview Vitals grid since
 * v1.15.14). Sorting and show/hide for the detail pages live on ONE surface;
 * the on-page edit mode's former "Manage detail pages" disclosure retired in
 * favour of a link here.
 *
 * The Insights nav PILLS persist to `insightsLayoutJson.tiles[].order`, a field
 * that is ALREADY separate from the overview `sections[].order` in layout v2.
 * Until v1.15.18 the pill order could only be changed implicitly through the
 * overview "Anpassen" → "Kacheln verwalten" disclosure (the Vitals row), which
 * the maintainer found unintuitive. This is the explicit surface: drag the
 * pills, toggle their eyes, "Speichern" PUTs the merged `{ tiles }` blob to
 * `/api/insights/layout`, which the tab strip + overview share via
 * `queryKeys.insightsLayout()`.
 *
 * Drag mirrors `insights-edit-mode` — each manager group is its OWN
 * `DndContext` + `SortableContext` so a drag never crosses a group boundary.
 */

const MANAGER_GROUP_HEADER_KEYS: Record<ManagerGroup, string> = {
  vitals: "insights.tabStrip.vitalsParent.label",
  body: "insights.tabStrip.bodyParent.label",
  activity: "insights.tabStrip.activityParent.label",
  sleep: "insights.editMode.groupSleep",
  heart: "insights.tabStrip.heartParent.label",
  hearing: "insights.tabStrip.hearingParent.label",
  environment: "insights.tabStrip.environmentParent.label",
  metabolic: "insights.tabStrip.metabolicParent.label",
  mood: "insights.editMode.groupMood",
  events: "insights.editMode.groupEvents",
};

/**
 * Stable fingerprint used to detect when the server copy changed. Carries
 * both the id order AND each tile's visibility so a save that only flipped
 * an eye still re-seeds the draft baseline.
 */
function layoutSignature(tiles: readonly InsightsTileConfig[]): string {
  return [...tiles]
    .sort((a, b) => a.order - b.order)
    .map((tile) => `${tile.id}:${tile.visible ? 1 : 0}`)
    .join(",");
}

export function InsightsPillOrderSection({ id }: { id?: string }) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { layout, isLoading, isSuccess } =
    useInsightsLayoutQuery(isAuthenticated);

  // Local draft of the tiles, seeded from the resolved layout and re-seeded in
  // render (the React-sanctioned "adjust state on prop change" pattern, no
  // effect) whenever the server copy's id-order changes — e.g. after a save or
  // once the GET settles. Tracking the last-seeded signature in STATE (not a
  // ref) keeps the reseed render-safe and idempotent while leaving in-flight
  // drag edits untouched: the baseline only advances when the *server* order
  // differs from what we last seeded from.
  // v1.30 (UX/IA audit H1) — ECG has no `MeasurementType` and therefore no
  // sub-page tile; its overview presence is the `"ecg"` SECTION. Surface it
  // here as a Heart-group row so hiding the ECG surface is reversible from the
  // same place the user manages every other Heart detail page. The eye toggles
  // the `"ecg"` section's `visible` flag (the exact flag a user flips in the
  // overview "Anpassen" editor). The tab-strip ECG pill stays a permanent,
  // data-gated route back and is deliberately NOT gated on this flag, so
  // hiding the overview card can never orphan a user's recordings again.
  const serverEcgVisible =
    layout.sections.find((s) => s.id === "ecg")?.visible ?? true;
  // Fold the ECG section flag into the re-seed fingerprint so a server-side
  // change to it (e.g. saved from the overview arrange editor) re-seeds the
  // ECG draft too, not just tile edits.
  const serverSignature = `${layoutSignature(layout.tiles)}|ecg:${
    serverEcgVisible ? 1 : 0
  }`;
  const [seededSignature, setSeededSignature] = useState(serverSignature);
  const [draftTiles, setDraftTiles] = useState<InsightsTileConfig[]>(() =>
    [...layout.tiles].sort((a, b) => a.order - b.order),
  );
  const [ecgVisibleDraft, setEcgVisibleDraft] = useState(serverEcgVisible);
  if (isSuccess && serverSignature !== seededSignature) {
    setSeededSignature(serverSignature);
    setDraftTiles([...layout.tiles].sort((a, b) => a.order - b.order));
    setEcgVisibleDraft(serverEcgVisible);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const saveMutation = useMutation({
    mutationFn: async (tiles: InsightsTileConfig[]) => {
      // Preserve the overview section order/visibility verbatim — this surface
      // owns the PILL order. The ONE exception is the `"ecg"` section, whose
      // eye lives in this manager (H1); override it only when the user actually
      // flipped it so an unchanged save stays a section no-op.
      const sections =
        ecgVisibleDraft !== serverEcgVisible
          ? layout.sections.map((s) =>
              s.id === "ecg" ? { ...s, visible: ecgVisibleDraft } : s,
            )
          : layout.sections;
      // v1.32.21 (R5a) — echo the base token so a concurrent insights write
      // (the overview edit mode, or another tab) 409s instead of clobbering.
      return apiPut<InsightsLayoutWithToken>(
        "/api/insights/layout",
        withBaseToken(
          { version: 2, sections, tiles },
          readUpdatedAtToken(queryClient, queryKeys.insightsLayout()),
        ),
      );
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.insightsLayout(), saved);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.insightsLayout(),
      });
      toast.success(t("insights.pillOrder.saveSuccess"));
    },
    onError: (err) => {
      // v1.32.21 (R5a) — explicit-Save disposition: on a 409 refetch so the
      // token advances, KEEP the draft so the user can re-save, nudge gently.
      if (isConflict(err)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.insightsLayout(),
        });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(t("insights.pillOrder.saveError"));
    },
  });

  const busy = saveMutation.isPending;

  // Group the draft tiles the same way the tab strip + manager do, so each
  // group's pills sort within their own `SortableContext`.
  const tilesByGroup = useMemo(() => {
    const byId = new Map<string, InsightsTileConfig>(
      draftTiles.map((tile) => [tile.id, tile]),
    );
    return MANAGER_GROUP_ORDER.map((group) => {
      const rows = SUB_PAGE_MANAGER_GROUP_SLUGS[group]
        .map((slug) => {
          const cfg = byId.get(slug);
          return {
            id: slug as string,
            labelKey: SUB_PAGE_TABS[slug].labelKey,
            visible: cfg?.visible ?? false,
            order: cfg?.order ?? Number.MAX_SAFE_INTEGER,
          };
        })
        .sort((a, b) => a.order - b.order);
      return { group, rows };
    }).filter((g) => g.rows.length > 0);
  }, [draftTiles]);

  function handleGroupDragEnd(group: ManagerGroup, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const groupRows = tilesByGroup.find((g) => g.group === group)?.rows ?? [];
    const groupMemberIds = new Set(groupRows.map((r) => r.id));
    const subset = groupRows.map((r) => ({ id: r.id, order: r.order }));
    const reordered = reorderById(subset, String(active.id), String(over.id));
    const reorderedIds = reordered.map((r) => r.id);

    // Substitute this group's slots in their new relative order through the
    // same tested, total-order helper the inline edit mode uses, leaving every
    // other tile's relative order untouched (QA M2).
    setDraftTiles((tiles) =>
      rebuildTilesWithReorderedVitals(tiles, reorderedIds, (id) =>
        groupMemberIds.has(id),
      ),
    );
  }

  /**
   * Flip one tile's visibility in the draft. Persisted on "Speichern" through
   * the same `{ tiles }` PUT as the order — `tiles[].visible` is the field the
   * tab strip and the overview Vitals grid already read (v1.15.14).
   */
  function toggleTileVisible(id: string, visible: boolean) {
    setDraftTiles((tiles) =>
      tiles.map((tile) => (tile.id === id ? { ...tile, visible } : tile)),
    );
  }

  const dirty = useMemo(
    () =>
      layoutSignature(layout.tiles) !== layoutSignature(draftTiles) ||
      ecgVisibleDraft !== serverEcgVisible,
    [layout.tiles, draftTiles, ecgVisibleDraft, serverEcgVisible],
  );

  return (
    <SettingsCard
      as="section"
      id={id}
      data-slot="insights-pill-order-section"
      aria-labelledby="insights-pill-order-title"
    >
      <SettingsCardHeader
        icon={ListOrdered}
        titleId="insights-pill-order-title"
        title={t("insights.pillOrder.title")}
        description={t("insights.pillOrder.description")}
      />
      <p className="text-sm">{t("insights.pillOrder.detail")}</p>

      {isLoading ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot="insights-pill-order-loading"
        >
          <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin align-text-bottom motion-reduce:animate-none" />
        </p>
      ) : tilesByGroup.length === 0 ? (
        <EmptyState
          variant="plain"
          size="compact"
          data-slot="insights-pill-order-empty"
          title={t("insights.pillOrder.empty")}
        />
      ) : (
        <div className="max-h-[60vh] space-y-3 overflow-y-auto overscroll-contain">
          {tilesByGroup.map(({ group, rows }) => (
            <div
              key={group}
              data-slot="insights-pill-order-group"
              data-group={group}
            >
              <p className="text-muted-foreground px-1 py-1 text-xs font-semibold tracking-wide uppercase">
                {t(MANAGER_GROUP_HEADER_KEYS[group])}
              </p>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => handleGroupDragEnd(group, event)}
              >
                <SortableContext
                  items={rows.map((r) => r.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {rows.map((tile) => (
                      <SortablePillRow
                        key={tile.id}
                        id={tile.id}
                        title={t(tile.labelKey)}
                        visible={tile.visible}
                        disabled={busy}
                        dragHandleLabel={t("insights.pillOrder.dragHandle")}
                        showLabel={t("insights.editMode.show")}
                        hideLabel={t("insights.editMode.hide")}
                        onToggle={toggleTileVisible}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
              {/* v1.30 (H1) — ECG rides the Heart group as a non-sortable row:
                  it has no `MeasurementType` and no tile order, so there is
                  nothing to drag. The eye toggles the `"ecg"` overview section
                  (see the draft plumbing above). */}
              {group === "heart" && (
                <div className="mt-1.5">
                  <EcgManagerRow
                    title={t("insights.navEcg")}
                    visible={ecgVisibleDraft}
                    disabled={busy}
                    showLabel={t("insights.editMode.show")}
                    hideLabel={t("insights.editMode.hide")}
                    onToggle={() => setEcgVisibleDraft((v) => !v)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <SettingsCardActions>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate(draftTiles)}
          disabled={busy || !dirty}
          data-slot="insights-pill-order-save"
          className="min-h-11 self-end sm:min-h-9 sm:self-auto"
        >
          {saveMutation.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("insights.pillOrder.save")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}

const DRAG_HANDLE_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9 sm:before:absolute sm:before:inset-[-6px] sm:before:content-['']";

const EYE_TOGGLE_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 w-11 shrink-0 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9";

/**
 * v1.30 (H1) — the ECG row in the Heart group. Unlike {@link SortablePillRow}
 * it is not draggable (ECG has no tile order), so it carries an aligned spacer
 * where the drag handle sits on its siblings and only the eye toggle. The eye
 * flips the `"ecg"` overview section's visibility.
 */
function EcgManagerRow({
  title,
  visible,
  disabled,
  showLabel,
  hideLabel,
  onToggle,
}: {
  title: string;
  visible: boolean;
  disabled: boolean;
  showLabel: string;
  hideLabel: string;
  onToggle: () => void;
}) {
  return (
    <div
      data-slot="insights-pill-order-row"
      data-tile="ecg"
      className="border-border bg-background/30 flex items-center gap-2 rounded-md border px-2 py-1.5"
    >
      {/* Alignment spacer standing in for the sortable rows' drag handle. */}
      <span
        aria-hidden="true"
        className="inline-flex h-11 w-11 shrink-0 sm:h-9 sm:w-9"
      />
      <span className="min-w-0 flex-1 truncate text-sm" title={title}>
        {title}
      </span>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={visible}
        aria-label={`${visible ? hideLabel : showLabel}: ${title}`}
        title={visible ? hideLabel : showLabel}
        data-slot="insights-pill-order-eye"
        data-visible={visible ? "true" : "false"}
        className={EYE_TOGGLE_CLASS}
      >
        {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </button>
    </div>
  );
}

function SortablePillRow({
  id,
  title,
  visible,
  disabled,
  dragHandleLabel,
  showLabel,
  hideLabel,
  onToggle,
}: {
  id: string;
  title: string;
  visible: boolean;
  disabled: boolean;
  dragHandleLabel: string;
  showLabel: string;
  hideLabel: string;
  onToggle: (id: string, visible: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="insights-pill-order-row"
      data-tile={id}
      data-dragging={isDragging ? "true" : undefined}
      className={cn(
        "border-border bg-background/30 flex items-center gap-2 rounded-md border px-2 py-1.5",
        isDragging && "ring-primary z-10 opacity-90 shadow-md ring-2",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${dragHandleLabel}: ${title}`}
        title={dragHandleLabel}
        disabled={disabled}
        data-slot="insights-pill-order-handle"
        className={DRAG_HANDLE_CLASS}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm" title={title}>
        {title}
      </span>
      {/* v1.15.20 — same eye interaction as the overview edit cards: the
          toggle flips the draft's `visible` flag; "Speichern" persists it. */}
      <button
        type="button"
        onClick={() => onToggle(id, !visible)}
        disabled={disabled}
        aria-pressed={visible}
        aria-label={`${visible ? hideLabel : showLabel}: ${title}`}
        title={visible ? hideLabel : showLabel}
        data-slot="insights-pill-order-eye"
        data-visible={visible ? "true" : "false"}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 w-11 shrink-0 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9"
      >
        {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </button>
    </div>
  );
}
