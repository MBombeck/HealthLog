"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Eye,
  EyeOff,
  GripVertical,
  LayoutGrid,
  Loader2,
  RotateCcw,
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
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { reorderById } from "@/lib/insights-layout-reorder";
import {
  type InsightsLayout,
  type InsightsLayoutWithToken,
  type InsightsSectionConfig,
  type InsightsSectionId,
} from "@/lib/insights-layout";
import {
  arrangeSavePayload,
  arrangementSignature,
  reconcileArrangeDraft,
  seedArrangeDraft,
  sortByOrder,
} from "@/lib/insights-arrange-draft";
import { apiDelete, apiPut } from "@/lib/api/api-fetch";
import {
  readUpdatedAtToken,
  withBaseToken,
  isConflict,
} from "@/lib/api/optimistic-token";

/**
 * v1.15.11 W3 — inline "Anpassen" edit mode for the customizable Insights
 * overview.
 *
 * Renders LIGHTWEIGHT edit cards (drag handle + localized title + eye toggle)
 * instead of the live, heavy section content, so toggling into edit mode never
 * refetches the section data — it swaps the JSX, not the queries. Edits mutate a
 * local draft; "Fertig" PUTs the merged `{ version: 2, sections, tiles }` blob
 * and invalidates `queryKeys.insightsLayout()`; "Zurücksetzen" DELETEs to
 * defaults.
 *
 * Tile-level management (the per-metric detail pages + their nav pills)
 * moved to Settings → Insights in v1.15.20 — the pill-order section there
 * carries both sorting AND the eye toggles, so the disclosure this card used
 * to nest under the Vitals row was a duplicate surface. A save sends the
 * CURRENT server tiles (never a copy taken at mount), so a pill-order save
 * made beside this card survives a later section save.
 */

/** Localized title key per section id — used for the edit-card label. */
const SECTION_TITLE_KEYS: Record<InsightsSectionId, string> = {
  "wellness-scores": "insights.derived.scores.sectionTitle",
  "daily-briefing": "insights.dailyBriefing.title",
  vitals: "insights.derived.vitals.sectionTitle",
  trends: "insights.trendsRow.title",
  "period-review": "insights.narrativeTitle",
  "cycle-summary": "cycle.insightsSummary.title",
  signals: "insights.derived.coincident.cardTitle",
  "rhythm-events": "insights.rhythmEvents.sectionTitle",
  "health-status": "insights.healthStatus.sectionTitle",
  breathing: "insights.breathingScreening.sectionTitle",
  "labs-changes": "insights.labsChanges.sectionTitle",
  ecg: "insights.ecg.sectionTitle",
};

interface InsightsEditModeProps {
  /** Resolved layout currently in effect (server copy, defaults while loading). */
  layout: InsightsLayout;
  /**
   * Which section ids are gated off right now (feature flag / data gate), so
   * the edit row renders disabled with a hint rather than offering a toggle
   * that does nothing.
   */
  gatedOffSectionIds: ReadonlySet<InsightsSectionId>;
  /** Close edit mode (the "Fertig" / save-success path calls this). */
  onClose: () => void;
  /**
   * `page` (default) is the inline editor the Insights overview opens: its own
   * title, Reset + Done beside it, and a pointer to the Settings pill manager.
   * `settings` is the same editor as a standing Settings card: a settings
   * header, the actions in one row at the bottom (design standards §12), no
   * pointer back to the page it already sits on, and no focus grab on mount —
   * the card is part of the page, not a surface the user just opened.
   */
  variant?: "page" | "settings";
}

export function InsightsEditMode({
  layout,
  gatedOffSectionIds,
  onClose,
  variant = "page",
}: InsightsEditModeProps) {
  const inSettings = variant === "settings";
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Local section draft seeded from the resolved layout. Edits mutate the
  // draft only; "Fertig" flushes it via the PUT mutation. When the server copy
  // changes underneath (the pill manager beside the Settings card also flips
  // the "ecg" section), an untouched draft re-seeds in render — the
  // React-sanctioned "adjust state on prop change" pattern — so it never turns
  // someone else's save into a pending edit of its own.
  const [draftState, setDraftState] = useState(() =>
    seedArrangeDraft(layout.sections),
  );
  const reconciled = reconcileArrangeDraft(draftState, layout.sections);
  if (reconciled) setDraftState(reconciled);
  const draftSections = (reconciled ?? draftState).sections;
  const setDraftSections = (
    update: (sections: InsightsSectionConfig[]) => InsightsSectionConfig[],
  ) => setDraftState((d) => ({ ...d, sections: update(d.sections) }));

  // v1.15.11 QA L5 — on mount move focus to the edit-card heading so keyboard /
  // screen-reader users land on the surface they just opened (not the top of
  // the document). Inline, not modal, so no focus trap — focus returns to the
  // "Anpassen" toggle on close via the page's onClose handler.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (inSettings) return;
    headingRef.current?.focus();
  }, [inSettings]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const saveMutation = useMutation({
    mutationFn: async (sections: InsightsSectionConfig[]) => {
      // v1.32.21 (R5a) — echo the optimistic-concurrency base token this edit
      // was based on so an interleaved write (a Settings pill-order Save, or
      // this surface open in another tab) 409s instead of clobbering.
      return apiPut<InsightsLayoutWithToken>(
        "/api/insights/layout",
        withBaseToken(
          arrangeSavePayload(sections, layout),
          readUpdatedAtToken(queryClient, queryKeys.insightsLayout()),
        ),
      );
    },
    onSuccess: (saved) => {
      // Optimistic-style settle: write the server-resolved layout (carrying
      // the advanced token) into the shared cache so the overview repaints in
      // the new order, then close.
      queryClient.setQueryData(queryKeys.insightsLayout(), saved);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.insightsLayout(),
      });
      toast.success(t("insights.editMode.saveSuccess"));
      onClose();
    },
    onError: (err) => {
      // v1.32.21 (R5a) — explicit-Save disposition: a 409 means someone else
      // committed since this edit was based. Refetch so the token advances,
      // KEEP the draft (stay in edit mode) so the user can re-save, and nudge
      // gently — nothing was lost.
      if (isConflict(err)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.insightsLayout(),
        });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(t("insights.editMode.saveError"));
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      return apiDelete<InsightsLayout>("/api/insights/layout");
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.insightsLayout(), saved);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.insightsLayout(),
      });
      // Re-seed the draft so the open editor reflects the restored defaults.
      setDraftState(seedArrangeDraft(saved.sections));
      toast.success(t("insights.editMode.resetSuccess"));
    },
    onError: () => toast.error(t("insights.editMode.saveError")),
  });

  const busy = saveMutation.isPending || resetMutation.isPending;
  // The Settings card's Save waits for a change, like the pill-order Save
  // beside it; the overview's inline editor keeps "Done" live because it
  // also closes the editor.
  const dirty =
    arrangementSignature(draftSections) !==
    arrangementSignature(layout.sections);

  const sections = sortByOrder(draftSections);
  const sectionIds = sections.map((s) => s.id);

  function toggleSection(id: InsightsSectionId, visible: boolean) {
    setDraftSections((rows) =>
      rows.map((s) => (s.id === id ? { ...s, visible } : s)),
    );
  }

  function handleSectionDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const reordered = reorderById<InsightsSectionConfig>(
      draftSections,
      String(active.id),
      String(over.id),
    );
    setDraftSections(() => reordered);
  }

  const allHidden = draftSections.every((s) => !s.visible);

  return (
    <SettingsCard data-slot="insights-edit-mode">
      {inSettings ? (
        <SettingsCardHeader
          icon={LayoutGrid}
          title={t("insights.settings.overviewTitle")}
          titleId="insights-overview-arrange-title"
          description={t("insights.settings.overviewDescription")}
        />
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div>
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-lg font-semibold focus-visible:outline-none"
            >
              {t("insights.editMode.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("insights.editMode.description")}
            </p>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <ConfirmButton
              slot="insights-edit-reset"
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              label={t("insights.editMode.reset")}
              title={t("insights.editMode.resetTitle")}
              body={t("insights.editMode.resetBody")}
              confirmLabel={t("insights.editMode.resetConfirm")}
              disabled={busy && !resetMutation.isPending}
              pending={resetMutation.isPending}
              onConfirm={() => resetMutation.mutate()}
            />
            <Button
              size="sm"
              onClick={() => saveMutation.mutate(draftSections)}
              disabled={busy}
              data-slot="insights-edit-done"
            >
              {saveMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("insights.editMode.done")}
            </Button>
          </div>
        </div>
      )}

      {allHidden && (
        <p
          className="text-muted-foreground text-sm"
          data-slot="insights-edit-all-hidden"
        >
          {t("insights.editMode.allHiddenHint")}
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleSectionDragEnd}
      >
        <SortableContext
          items={sectionIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {sections.map((section) => {
              const gatedOff = gatedOffSectionIds.has(section.id);
              return (
                <SortableSectionRow
                  key={section.id}
                  section={section}
                  title={t(SECTION_TITLE_KEYS[section.id])}
                  gatedOff={gatedOff}
                  disabled={busy}
                  labels={{
                    dragHandle: t("insights.editMode.dragHandle"),
                    show: t("insights.editMode.show"),
                    hide: t("insights.editMode.hide"),
                    gatedHint: t("insights.editMode.gatedHint"),
                  }}
                  onToggle={toggleSection}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {inSettings ? (
        <SettingsCardActions>
          <ConfirmButton
            slot="insights-edit-reset"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label={t("insights.editMode.reset")}
            title={t("insights.editMode.resetTitle")}
            body={t("insights.editMode.resetBody")}
            confirmLabel={t("insights.editMode.resetConfirm")}
            disabled={busy && !resetMutation.isPending}
            pending={resetMutation.isPending}
            onConfirm={() => resetMutation.mutate()}
          />
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => saveMutation.mutate(draftSections)}
            disabled={busy || !dirty}
            data-slot="insights-edit-done"
          >
            {saveMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </SettingsCardActions>
      ) : (
        // v1.15.20 — the per-detail-page manager (sort + show/hide) lives on
        // Settings → Insights; the disclosure this card used to nest under
        // the Vitals row duplicated it. Keep a quiet pointer instead.
        <p className="text-muted-foreground text-xs">
          <Link
            href="/settings/layout/insights#insights-pill-order"
            data-slot="insights-edit-manage-link"
            className="hover:text-foreground focus-visible:ring-ring rounded underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            {t("insights.editMode.manageInSettings")}
          </Link>
        </p>
      )}
    </SettingsCard>
  );
}

interface RowLabels {
  dragHandle: string;
  show: string;
  hide: string;
}

const DRAG_HANDLE_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9 sm:before:absolute sm:before:inset-[-6px] sm:before:content-['']";

function EyeToggle({
  visible,
  disabled,
  label,
  onClick,
  slot,
}: {
  visible: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  slot: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-pressed={visible}
      aria-label={label}
      title={label}
      data-slot={slot}
      data-visible={visible ? "true" : "false"}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 w-11 shrink-0 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9"
    >
      {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
    </button>
  );
}

interface SortableSectionRowProps {
  section: InsightsSectionConfig;
  title: string;
  gatedOff: boolean;
  disabled: boolean;
  labels: RowLabels & { gatedHint: string };
  onToggle: (id: InsightsSectionId, visible: boolean) => void;
}

function SortableSectionRow({
  section,
  title,
  gatedOff,
  disabled,
  labels,
  onToggle,
}: SortableSectionRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: section.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="insights-edit-section-row"
      data-section={section.id}
      data-dragging={isDragging ? "true" : undefined}
      data-gated={gatedOff ? "true" : undefined}
      className={cn(
        "border-border bg-background/30 w-full rounded-md border px-2 py-2 sm:px-3",
        isDragging && "ring-primary z-10 opacity-90 shadow-lg ring-2",
        gatedOff && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`${labels.dragHandle} — ${title}`}
          title={labels.dragHandle}
          disabled={disabled}
          data-slot="insights-edit-section-handle"
          className={DRAG_HANDLE_CLASS}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={title}>
            {title}
          </span>
          {/* v1.15.11 QA M1-design — the gated hint reads as a caption BELOW the
              title so the row's right-edge control position stays stable whether
              the section is gated or not. */}
          {gatedOff && (
            <span
              className="text-muted-foreground truncate text-xs"
              data-slot="insights-edit-section-gated-hint"
            >
              {labels.gatedHint}
            </span>
          )}
        </div>
        {/* v1.15.11 QA M1-design — a gated section keeps a DISABLED eye toggle in
            the SAME position rather than swapping it for a text span, so the row
            layout never jumps. The section stays reorderable; only the toggle is
            inert until the gate opens. */}
        <EyeToggle
          visible={section.visible}
          disabled={disabled || gatedOff}
          label={`${section.visible ? labels.hide : labels.show} — ${title}`}
          onClick={() => onToggle(section.id, !section.visible)}
          slot="insights-edit-section-eye"
        />
      </div>
    </div>
  );
}
