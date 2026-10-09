"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
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
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  type DashboardLayout,
  type DashboardWidgetId,
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  IOS_PIN_ONLY_WIDGET_IDS,
  type DashboardWidgetCatalogueId,
  type DashboardLayoutWithToken,
} from "@/lib/dashboard-layout";
import {
  PRIORITY_ITEM_KINDS,
  type PriorityItemKind,
} from "@/lib/daily/priority-item";
import { apiDelete, apiGet, apiPut, ApiError } from "@/lib/api/api-fetch";
import { useMounted } from "@/hooks/use-mounted";
import { useAuth } from "@/hooks/use-auth";
import { NATIVE_ONLY_WIDGET_LABEL_KEYS } from "@/lib/dashboard/widget-modules";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";

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

export function setHeroItemKindEnabled(
  enabledKinds: readonly PriorityItemKind[] | undefined,
  kind: PriorityItemKind,
  enabled: boolean,
): PriorityItemKind[] {
  const next = new Set(enabledKinds ?? PRIORITY_ITEM_KINDS);
  if (enabled) next.add(kind);
  else next.delete(kind);
  return PRIORITY_ITEM_KINDS.filter((itemKind) => next.has(itemKind));
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

/** Serialise layout saves and resets against the same endpoint. */
const DASHBOARD_WIDGETS_MUTATION_SCOPE = "dashboard-widgets" as const;

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
  // v1.28.52 — muscle mass joins the body-composition strip tiles.
  muscleMass: "measurements.typeMuscleMass",
  bpInTarget: "dashboard.bpInTarget",
  oxygenSaturation: "measurements.typeOxygenSaturation",
  // v1.28.52 — HRV + respiratory rate graduate to web-writable widgets.
  hrv: "measurements.typeHeartRateVariability",
  respiratoryRate: "measurements.typeRespiratoryRate",
  achievements: "achievements.title",
  // v1.4.25 W8d — VO2 max secondary-metric tile (opt-in).
  vo2Max: "dashboard.vo2Max",
  // v1.4.32 — Recent workouts tile (default-on).
  recentWorkouts: "dashboard.recentWorkouts.title",
  // v1.11.2 B5 — v1.10 additive HealthKit signals, now pinnable. Each
  // reuses the existing measurement-type label key.
  cardioRecovery: "measurements.typeCardioRecovery",
  sixMinuteWalk: "measurements.typeSixMinuteWalkDistance",
  stairAscentSpeed: "measurements.typeStairAscentSpeed",
  stairDescentSpeed: "measurements.typeStairDescentSpeed",
  breathingDisturbances: "measurements.typeBreathingDisturbances",
  wristTemperature: "measurements.typeWristTemperature",
  falls: "measurements.typeFallCount",
  walkingSteadiness: "measurements.typeWalkingSteadiness",
  // v1.18.2 — Vorsorge preventive-care summary card.
  vorsorge: "measurementReminders.sectionTitle",
  // v1.29 — fluid intake strip tile (nutrients-store-backed).
  waterIntake: "nutrients.names.water",
};

const HERO_ITEM_LABEL_KEYS: Record<PriorityItemKind, string> = {
  coach_checkin: "dashboard.heroItems.coach_checkin",
  dose_window: "dashboard.heroItems.dose_window",
  preventive_care: "dashboard.heroItems.preventive_care",
  sync_issue: "dashboard.heroItems.sync_issue",
  milestone: "dashboard.heroItems.milestone",
  ecg_new_recording: "dashboard.heroItems.ecg_new_recording",
  tension_window: "dashboard.heroItems.tension_window",
  same_time_baseline: "dashboard.heroItems.same_time_baseline",
  upcoming_visit: "dashboard.heroItems.upcoming_visit",
};

export function DashboardLayoutSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // v1.18.0 — a widget toggle whose owning module is disabled is a dead
  // control (the snapshot gates the tile/chart out server-side regardless
  // of the switch). Read the resolved module map and hide those rows.
  // Fail-open: a missing map / absent key (stale /me payload, core widget)
  // reads as enabled, so the row always shows unless the module is
  // explicitly `false`.
  const { user } = useAuth();
  const modules = user?.modules;
  // v1.4.47 W4 — stable id namespace for the drag-handle `aria-describedby`
  // tooltip. One hint paragraph is rendered once at the bottom of the list
  // and referenced by every drag handle in this section.
  const dragHintId = useId();
  const heroDescriptionId = useId();
  const heroNotificationNoteId = useId();
  const heroContentSelectId = useId();
  const todayCardSwitchId = useId();
  // v1.34 — the "Today highlights" fieldset below is gated on `layout`,
  // which can be truthy on the very first client render whenever a
  // returning visitor's browser already has a warm, offline-persisted
  // `dashboardWidgets` cache (queryKeys.dashboardWidgets() sits in
  // PERSIST_ALLOWLIST_HEADS). The static build has no session, so
  // `layout` is always null in the server HTML — a warm cache then
  // diverges the very first client paint from that HTML (React #418).
  // `useMounted()` forces the fieldset's presence check to agree with
  // the server on the hydrating render (both false), the same pattern
  // `LayoutModuleGate` already uses for the same class of mismatch.
  const hydrated = useMounted();

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
      return apiGet<DashboardLayoutWithToken>("/api/dashboard/widgets");
    },
    // v1.32.19 (B-3, belt for the #581 fix) — the home RSC seeds
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
   * v1.32.16 (issue #581) — the freshest optimistic-concurrency token the
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
      // v1.18.10 — the Startseite reads its layout (tile/chart visibility,
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
      toast.error(t("dashboard.layoutSaveError"));
    },
  });

  const resetMutation = useMutation({
    scope: { id: DASHBOARD_WIDGETS_MUTATION_SCOPE },
    mutationFn: async () => {
      return apiDelete<DashboardLayoutWithToken>("/api/dashboard/widgets");
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), saved);
      // v1.18.10 — same snapshot invalidation as the save path so a reset
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
   * v1.4.15 Fix 5 — independent toggle for the *strip tile* (the upper
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

  /** v1.42 — the server-persisted on/off switch for the dashboard's top card. */
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
    <SettingsCard id={id} className="scroll-mt-28">
      <SettingsCardHeader
        icon={LayoutDashboard}
        title={t("dashboard.customizeTitle")}
      />
      {hydrated && layout && (
        <fieldset
          aria-describedby={`${heroDescriptionId} ${heroNotificationNoteId}`}
          data-slot="hero-content-settings"
          className="border-border bg-background/30 space-y-3 rounded-lg border px-3 py-3"
        >
          <legend className="text-foreground text-sm font-medium">
            {t("dashboard.heroItemsTitle")}
          </legend>
          <p id={heroDescriptionId} className="text-muted-foreground text-xs">
            {t("dashboard.heroItemsDescription")}
          </p>
          {/* v1.42 — the top card itself can be switched off. Shown is the
              default; the choices below shape the card while it is shown. */}
          <div className="flex min-h-11 items-center justify-between gap-3">
            <Label htmlFor={todayCardSwitchId} className="text-sm font-medium">
              {t("dashboard.todayCardVisible")}
            </Label>
            <Switch
              id={todayCardSwitchId}
              checked={layout.todayCardVisible !== false}
              onCheckedChange={setTodayCardVisible}
              disabled={saveMutation.isPending}
              data-slot="today-card-switch"
            />
          </div>
          {/* Hero primary content — a single labelled select beside the
              highlight toggles. "score" keeps the health-score read;
              "reminders" promotes the highlight rail into the hero slot. */}
          <div className="space-y-1.5">
            <Label
              htmlFor={heroContentSelectId}
              className="text-sm font-medium"
            >
              {t("dashboard.heroContentTitle")}
            </Label>
            <NativeSelect
              id={heroContentSelectId}
              value={layout.hero ?? "score"}
              onChange={(event) => setHeroContent(event.target.value)}
              disabled={saveMutation.isPending}
              data-slot="hero-content-select"
              className="sm:max-w-xs"
            >
              <option value="score">{t("dashboard.heroContentScore")}</option>
              <option value="reminders">
                {t("dashboard.heroContentReminders")}
              </option>
            </NativeSelect>
          </div>
          <div className="divide-border divide-y">
            {PRIORITY_ITEM_KINDS.map((kind) => {
              const inputId = `hero-item-${kind}`;
              const checked = (
                layout.enabledHeroItemKinds ?? PRIORITY_ITEM_KINDS
              ).includes(kind);
              return (
                <div
                  key={kind}
                  className="flex min-h-11 items-center justify-between gap-3 py-2"
                >
                  <Label htmlFor={inputId} className="text-sm font-medium">
                    {t(HERO_ITEM_LABEL_KEYS[kind])}
                  </Label>
                  <Switch
                    id={inputId}
                    checked={checked}
                    onCheckedChange={(value) => toggleHeroItem(kind, value)}
                    disabled={saveMutation.isPending}
                    aria-label={t(HERO_ITEM_LABEL_KEYS[kind])}
                    data-slot="hero-item-switch"
                    data-kind={kind}
                  />
                </div>
              );
            })}
          </div>
          <p id={heroNotificationNoteId} className="text-foreground text-sm">
            {t("dashboard.heroItemsNotificationNote")}
          </p>
        </fieldset>
      )}

      {isLoading || !layout ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          {t("common.loading")}
        </div>
      ) : (
        // `relative` anchors the sr-only drag-hint paragraph below: Tailwind's
        // `sr-only` is `position: absolute`, and without a positioned ancestor
        // its containing block is the initial containing block — the 1px box
        // then sits at its static position (below this long list) in DOCUMENT
        // coordinates and silently makes the document itself scrollable, a
        // second vertical scrollbar next to the shell-owned `<main>` scroll
        // (UI-STANDARDS §9 one-scroll-floor; guarded by
        // e2e/settings-overscroll.spec.ts).
        <div className="relative space-y-2">
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
          <div className="text-muted-foreground flex items-center gap-2 px-3 pb-1 text-xs font-medium tracking-wide uppercase">
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
            // v1.7.0 — the stored layout now round-trips the 11 iOS-only
            // widget ids so the native client can drop its local merge
            // workarounds. The web Settings list has no tile/chart
            // surface for them, so skip any id outside the web-known
            // ids rather than render an unlabelled row with dead toggles.
            // The skipped ids stay untouched in the persisted layout
            // because the Save mutation PUTs `layout.widgets` whole and
            // the server retains every catalogue id.
            //
            // v1.11.2 HIGH-1 — the 8 B5 ids are WRITABLE (in
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

          {/* issue #581 — widgets the mobile app draws and this page does
              not. Filtering them out of the list above is right (a toggle
              over something the web cannot draw would be a silent no-op),
              but the native client materialises them into the SAME stored
              layout, so the account ended up holding rows it never set and
              could not change from anywhere. They get their own labelled
              group: the same two flags, no reordering (placement is the
              native client's), and only for ids the layout actually holds —
              an account with no native client has nothing to configure here
              and sees nothing. */}
          {(() => {
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
                  const label = t(
                    NATIVE_ONLY_WIDGET_LABEL_KEYS[widget.id] ?? widget.id,
                  );
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
          })()}
        </div>
      )}

      {/* Reset is a secondary action, so it reads in the same row as save
          rather than from the header's status slot. */}
      <SettingsCardActions>
        <ConfirmButton
          slot="settings-dashboard-layout-reset"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          label={t("dashboard.layoutReset")}
          title={t("dashboard.layoutResetTitle")}
          body={t("dashboard.layoutResetBody")}
          confirmLabel={t("dashboard.layoutResetConfirm")}
          pending={resetMutation.isPending}
          onConfirm={() => resetMutation.mutate()}
        />
        {dirty && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={() => setDraft(null)}
              disabled={saveMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="settings-dashboard-layout-save"
              onClick={() => layout && saveMutation.mutate(layout)}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("common.save")}
            </Button>
          </>
        )}
      </SettingsCardActions>

      {!dirty && remote && (
        <p className="text-muted-foreground text-xs">
          {layout &&
          JSON.stringify(layout.widgets) ===
            JSON.stringify(DEFAULT_DASHBOARD_LAYOUT.widgets) &&
          JSON.stringify(layout.enabledHeroItemKinds ?? PRIORITY_ITEM_KINDS) ===
            JSON.stringify(DEFAULT_DASHBOARD_LAYOUT.enabledHeroItemKinds) &&
          (layout.hero ?? "score") === DEFAULT_DASHBOARD_LAYOUT.hero &&
          layout.todayCardVisible !== false
            ? t("dashboard.layoutUsingDefaults")
            : t("dashboard.layoutCustomized")}
        </p>
      )}
    </SettingsCard>
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
      className={`border-border bg-background/30 flex min-h-12 flex-wrap items-center gap-2 rounded-md border px-3 py-2 sm:flex-nowrap ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle}: ${labels.widgetLabel}`}
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
