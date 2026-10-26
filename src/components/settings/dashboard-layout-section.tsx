"use client";

import { useId } from "react";
import { LayoutDashboard, Loader2, RotateCcw } from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useMounted } from "@/hooks/use-mounted";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { DEFAULT_DASHBOARD_LAYOUT } from "@/lib/dashboard-layout";
import { useTranslations } from "@/lib/i18n/context";

import { HeroSettingsFieldset } from "./dashboard-layout/hero-settings-fieldset";
import { useDashboardLayoutDraft } from "./dashboard-layout/use-dashboard-layout-draft";
import {
  NativeWidgetList,
  WebWidgetList,
} from "./dashboard-layout/widget-lists";

/**
 * Settings → Dashboard: the top card's settings, the widget list (tile and
 * chart switches, order by arrows or drag), the native-only widgets, and
 * save / cancel / reset. The draft and its writes live in
 * `./dashboard-layout/`.
 */
export function DashboardLayoutSection({ id }: { id: string }) {
  const { t } = useTranslations();
  // One hint paragraph, rendered once below the list and referenced by every
  // drag handle's `aria-describedby`.
  const dragHintId = useId();
  // The "Today highlights" fieldset below is gated on `layout`,
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
  const draft = useDashboardLayoutDraft();
  const {
    remote,
    isLoading,
    layout,
    setDraft,
    dirty,
    saveMutation,
    resetMutation,
  } = draft;

  return (
    <SettingsCard id={id} className="scroll-mt-28">
      <SettingsCardHeader
        icon={LayoutDashboard}
        title={t("dashboard.customizeTitle")}
      />
      {hydrated && layout && (
        <HeroSettingsFieldset layout={layout} draft={draft} />
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
        // (ui-standards.md §9 one-scroll-floor; guarded by
        // e2e/settings-overscroll.spec.ts).
        <div className="relative space-y-2">
          {/* The column header names the two switches (the tile in the
              upper strip, the chart in the lower row); the spacers reserve
              the drag handle and the arrow pair so the headings line up with
              the switches below. */}
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
          <WebWidgetList
            layout={layout}
            draft={draft}
            dragHintId={dragHintId}
          />
          {/* Single shared aria-describedby target for all
              drag handles. Screen readers read this once per focused
              handle; sighted users see it in the native browser tooltip
              via the matching `title` attribute on each handle. Gated on
              the widget count, so an empty layout never orphans it. */}
          {layout.widgets.length > 0 && (
            <p id={dragHintId} className="text-muted-foreground sr-only">
              {t("dashboard.dragHandleHint")}
            </p>
          )}

          <NativeWidgetList layout={layout} draft={draft} />
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
          destructive
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
