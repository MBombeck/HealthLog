"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";

import { apiDelete, apiGet, apiPut, ApiError } from "@/lib/api/api-fetch";
import type { PriorityItemKind } from "@/lib/daily/priority-item";
import type {
  DashboardLayout,
  DashboardLayoutWithToken,
  DashboardWidgetCatalogueId,
  DashboardWidgetId,
} from "@/lib/dashboard-layout";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import {
  DASHBOARD_WIDGETS_MUTATION_SCOPE,
  mergeReorderIntoLayout,
  reorderWidgets,
  setHeroItemKindEnabled,
} from "./layout-model";

/**
 * The layout editor's state: the tokened server copy, a local draft that
 * every toggle and move edits (null means "use the server copy"), and the
 * save and reset writes, which also refresh the dashboard snapshot and the
 * daily digest so the dashboard mounts onto the saved layout.
 */
export function useDashboardLayoutDraft() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { data: remote, isLoading } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      return apiGet<DashboardLayoutWithToken>("/api/dashboard/widgets");
    },
    // The home RSC seeds
    // `dashboardWidgets()` from the dashboard SNAPSHOT layout, which carries
    // NO `updatedAt` optimistic-concurrency token (it is a token-less
    // `DashboardLayout`, not the `DashboardLayoutWithToken` this section's GET
    // returns). Within the global 5-min `staleTime` a visit to `/` then Settings
    // read that seeded token-less value with no mount refetch, so `readBaseToken()`
    // returned undefined, the Save sent no `baseUpdatedAt`, and the route's
    // compat fallback silently reverted to last-write-wins — disabling the
    // just-shipped 409 belt. Force a mount refetch so this section always holds
    // its own tokened GET response and every write carries the base token. The
    // smallest correct option: the alternatives (a distinct seed key, or
    // threading the token through the snapshot layout) touch the home client and
    // the server snapshot shape; this is one line, config-independent, and makes
    // the settings query authoritative for its own tokened read.
    refetchOnMount: "always",
  });

  // Toggles the SERVER resolved as unavailable for this account — a switch
  // that is on but can never paint a tile is exactly the confusion this
  // screen must not create. Decided server-side (see `unavailableWidgetIds`)
  // so this screen needs no dashboard data of its own. Absent field, or a
  // query still in flight, means nothing is dead: the row shows, which is
  // the fail-open direction the module gate below also takes.
  const unavailableIds = useMemo(
    () => new Set(remote?.unavailableWidgetIds ?? []),
    [remote?.unavailableWidgetIds],
  );

  /**
   * The freshest optimistic-concurrency token the
   * client knows. Read straight from the widgets query cache at mutate time
   * (not a render snapshot) so it reflects whatever the last settled write
   * or refetch advanced it to. Every write sends it as `baseUpdatedAt`.
   */
  const readBaseToken = () =>
    queryClient.getQueryData<DashboardLayoutWithToken>(
      queryKeys.dashboardWidgets(),
    )?.updatedAt;

  // Local draft state — null means "use server copy". User edits create the
  // draft so reordering/toggling doesn't fire a network call per click; Save
  // flushes it, Cancel clears it. Avoids a setState-in-effect (eslint
  // react-hooks/set-state-in-effect is strict in this repo).
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const layout = draft ?? remote ?? null;

  const saveMutation = useMutation({
    scope: { id: DASHBOARD_WIDGETS_MUTATION_SCOPE },
    mutationFn: async (next: DashboardLayout) => {
      return apiPut<DashboardLayoutWithToken>("/api/dashboard/widgets", {
        ...next,
        // Guard the write on the token this edit was based on.
        baseUpdatedAt: readBaseToken(),
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      // The Startseite reads its layout (tile/chart visibility,
      // order, comparison baseline, hero toggle) from the dashboard
      // SNAPSHOT, not from this `dashboardWidgets` key. Without an
      // invalidation the snapshot keeps its cached layout and the dashboard
      // looks stale until a manual reload. Invalidate the snapshot so the
      // next visit (or open tab) re-reads the saved layout immediately.
      //
      // `refetchType: "all"` is load-bearing: while the user sits on this
      // settings page the dashboard is UNMOUNTED, so its snapshot cell is
      // inactive — the default `refetchType: "active"` only marks it stale,
      // and the snapshot query's deliberate `refetchOnMount: false`
      // (use-dashboard-snapshot.ts) then suppresses the mount-time refetch
      // on a same-tab navigation back to `/`. The saved tile selection only
      // surfaced on the 120 s poll or a window-focus flick ("saved but the
      // dashboard shows old tiles"). Refetching ALL matching cells fires the
      // request right here, so the dashboard mounts onto fresh data.
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardSnapshot(),
        refetchType: "all",
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dailyDigest(),
        refetchType: "all",
      });
      setDraft(null);
      toast.success(t("dashboard.layoutSaveSuccess"));
    },
    onError: (err) => {
      // A 409 means another client committed since this edit was based.
      // Refetch the winning layout so the base token advances, keep the draft,
      // and let the user save the change again.
      if (err instanceof ApiError && err.status === 409) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardWidgets(),
        });
        toast.message(t("dashboard.layoutConflictReloaded"));
        return;
      }
      showErrorToast(t("dashboard.layoutSaveError"), { cause: err });
    },
  });

  const resetMutation = useMutation({
    scope: { id: DASHBOARD_WIDGETS_MUTATION_SCOPE },
    mutationFn: async () => {
      return apiDelete<DashboardLayoutWithToken>("/api/dashboard/widgets");
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      // Same snapshot invalidation as the save path so a reset
      // to defaults reflects on the Startseite without a manual reload.
      // `refetchType: "all"` for the same reason as the save path: the
      // unmounted snapshot cell must refetch NOW, not on its next poll.
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardSnapshot(),
        refetchType: "all",
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dailyDigest(),
        refetchType: "all",
      });
      setDraft(null);
      toast.success(t("dashboard.layoutResetSuccess"));
    },
  });

  const edits = layoutEdits(layout, setDraft);

  // Presence of a draft implies dirty — no JSON comparison needed.
  const dirty = draft !== null && layout !== null;

  return {
    remote,
    isLoading,
    unavailableIds,
    layout,
    setDraft,
    dirty,
    saveMutation,
    resetMutation,
    ...edits,
  };
}

export type DashboardLayoutDraft = ReturnType<typeof useDashboardLayoutDraft>;

/**
 * The draft edits: the tile and chart switches, the top card's settings, and
 * reordering by arrow or drag. Each writes a new draft from the current
 * layout; nothing is sent until Save.
 */
function layoutEdits(
  layout: DashboardLayout | null,
  setDraft: (next: DashboardLayout | null) => void,
) {
  function toggle(widgetId: DashboardWidgetCatalogueId, visible: boolean) {
    if (!layout) return;
    setDraft({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === widgetId ? { ...w, visible } : w,
      ),
    });
  }

  /**
   * Independent toggle for the *strip tile* (the upper
   * row of trend cards). Until v1.4.14 a single switch controlled both
   * the tile AND the chart for the same metric, which the maintainer found too
   * coarse: they wanted a chart visible without the tile (for metrics they
   * tracks without wanting the at-a-glance number) or vice versa.
   */
  function toggleTile(
    widgetId: DashboardWidgetCatalogueId,
    tileVisible: boolean,
  ) {
    if (!layout) return;
    setDraft({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === widgetId ? { ...w, tileVisible } : w,
      ),
    });
  }

  function toggleHeroItem(kind: PriorityItemKind, enabled: boolean) {
    if (!layout) return;
    setDraft({
      ...layout,
      enabledHeroItemKinds: setHeroItemKindEnabled(
        layout.enabledHeroItemKinds,
        kind,
        enabled,
      ),
    });
  }

  /** The server-persisted on/off switch for the dashboard's top card. */
  function setTodayCardVisible(visible: boolean) {
    if (!layout) return;
    setDraft({ ...layout, todayCardVisible: visible });
  }

  /**
   * Hero primary content — the server-persisted `hero` field on the layout
   * blob. The value set is closed ("score" | "reminders"); anything else a
   * DOM event could carry collapses to the default rather than a cast.
   */
  function setHeroContent(value: string) {
    if (!layout) return;
    setDraft({
      ...layout,
      hero: value === "reminders" ? "reminders" : "score",
    });
  }

  /**
   * The arrow buttons now delegate to `reorderWidgets()`
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
   * Drag-and-drop reorder via @dnd-kit. Persists the same
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

  return {
    toggle,
    toggleTile,
    toggleHeroItem,
    setTodayCardVisible,
    setHeroContent,
    move,
    handleDragEnd,
  };
}
