"use client";

import { useMemo } from "react";

import { LayoutGrid, Loader2 } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useInsightsLayoutQuery } from "@/hooks/use-insights-layout";
import { InsightsEditMode } from "@/components/insights/insights-edit-mode";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  INSIGHTS_SECTION_IDS,
  type InsightsSectionId,
} from "@/lib/insights-layout";
import { isSurfaceVisible } from "@/lib/modules/surface";

/**
 * v1.15.18 — overview-arrange block for the Insights settings section.
 *
 * Embeds the existing v1.15.11 `<InsightsEditMode>` (section show/hide + order,
 * persisted to `insightsLayoutJson.sections`) as an always-open surface. There
 * is no "Anpassen" toggle here — Settings IS the customise surface — so `onClose`
 * is a no-op (after a "Fertig" save the layout query has already settled into the
 * shared cache; the editor simply stays mounted).
 *
 * `gatedOffSectionIds` mirrors the mother page's gate logic so a section whose
 * feature flag or owning module is off renders its row disabled-with-a-hint
 * rather than offering a toggle that does nothing. The row stays in the list
 * (not filtered out) so a save keeps the section's stored place for when the
 * module comes back.
 */
export function InsightsOverviewArrangeSection({ id }: { id?: string }) {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();
  // The daily briefing is model-written: its row is live only while the
  // `briefing` capability is available. The period review always renders
  // (its narrative is composed from the numbers), so it stays a live row.
  const briefing = useAiCapability("briefing");
  const { layout, isLoading } = useInsightsLayoutQuery(isAuthenticated);

  const gatedOffSectionIds = useMemo(() => {
    const gated = new Set<InsightsSectionId>();
    if (!briefing.available) gated.add("daily-briefing");
    // A block whose module is off cannot appear on the overview, so its row
    // is not offered as a live toggle. Read from the one surface map the
    // overview renders from (`overview:<id>`); cycle follows the resolved
    // `modules.cycle` like the overview's cycle ring, not the raw column.
    for (const id of INSIGHTS_SECTION_IDS) {
      if (!isSurfaceVisible(`overview:${id}`, user?.modules)) gated.add(id);
    }
    return gated;
  }, [briefing.available, user?.modules]);

  return (
    <section
      id={id}
      data-slot="insights-overview-arrange-section"
      aria-labelledby="insights-overview-arrange-title"
      className="scroll-mt-28"
    >
      {/* Gate the editor mount until the layout GET settles. The editor seeds
          its draft once from `layout` on mount, which is the canonical default
          while in flight; mounting it early would let a Save flush defaults
          over the user's real saved layout (the same QA-L1 gate the mother
          page applies to its "Anpassen" toggle). The loading card paints the
          same header the loaded card carries (design standards §13), so the
          page does not reflow under the cursor when the list arrives. */}
      {isLoading ? (
        <SettingsCard data-slot="insights-overview-arrange-loading">
          <SettingsCardHeader
            icon={LayoutGrid}
            title={t("insights.settings.overviewTitle")}
            titleId="insights-overview-arrange-title"
            description={t("insights.settings.overviewDescription")}
          />
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
        </SettingsCard>
      ) : (
        <InsightsEditMode
          variant="settings"
          layout={layout}
          gatedOffSectionIds={gatedOffSectionIds}
          onClose={() => {}}
        />
      )}
    </section>
  );
}
