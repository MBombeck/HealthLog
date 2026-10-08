"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, ListOrdered } from "lucide-react";

import {
  MedicationOrderEditor,
  type ReorderMedication,
} from "@/components/medications/medication-order-editor";
import { MedicationViewToggle } from "@/components/medications/medication-view-toggle";
import { SettingsCard } from "@/components/settings/settings-card";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { InjectionSitesCard } from "@/components/settings/injection-sites-card";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { applyMedicationOrder } from "@/lib/medications/medication-order";
import { queryKeys } from "@/lib/query-keys";
import { useMedicationListLayout } from "@/lib/queries/use-medication-list-layout";

/**
 * v1.16.10 — the "Medikamente" settings section. v1.18.0 (S5) promoted it
 * from a Layout-hub child to its own standalone nav entry and gathered the
 * medication-specific preferences here. v1.18.1 (D3) made medications a
 * toggleable fail-open module, so this nav entry hides when the account
 * turns the module off (the medication data routes stay live). Hosts three
 * blocks:
 *   1. The list VIEW preference — cards vs table, written optimistically
 *      through the same `PUT /api/medications/layout` the page header
 *      toggle uses (the toggle component is shared).
 *   2. The manual ORDER editor — two grouped lists (Aktiv / Inaktiv)
 *      with drag + arrow reordering, flushed by an explicit Save,
 *      persisted as active-ids-then-inactive-ids on the same layout row.
 *   3. Injection-site exclusions — moved here from the account profile so
 *      every medication-specific preference lives on one screen.
 *
 * The list view + order both write through the same `/api/medications/layout`
 * contract the /medications page reads, so a save here repaints both views.
 */

/** The slice of the medications list the order editor needs. */
interface MedicationListEntry {
  id: string;
  name: string;
  dose: string;
  active: boolean;
}

export function MedicationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { layout, isLayoutLoading, setView } = useMedicationListLayout();

  const { data: medications, isLoading } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      return apiGet<MedicationListEntry[]>("/api/medications");
    },
  });

  // Defensive against stale service-worker responses or any future API
  // shape change: only map when we actually have an array. The editor
  // receives the page's current effective order (active block first,
  // inactive after) so it opens showing exactly what both views render.
  const medsArray = Array.isArray(medications) ? medications : [];
  const ordered: ReorderMedication[] = [
    ...applyMedicationOrder(
      medsArray.filter((m) => m.active),
      layout.order,
    ),
    ...applyMedicationOrder(
      medsArray.filter((m) => !m.active),
      layout.order,
    ),
  ].map((m) => ({ id: m.id, name: m.name, dose: m.dose, active: m.active }));

  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the medication cards.
  return (
    <div className="space-y-6">
      {/* View preference — cards vs table. The shared header toggle
          writes optimistically, so there is no Save button here. */}
      <SettingsCard id="medications-view" className="scroll-mt-28">
        {/* Same shape as the Labs and Documents view cards: the hint is the
            header description, the toggle sits in the status slot. */}
        <SettingsCardHeader
          icon={LayoutGrid}
          title={t("medications.viewToggleLabel")}
          description={t("medications.viewToggleHint")}
          status={
            // Painted from the first frame, like the Labs and Documents
            // toggles: a spinner the width of one icon swapped for a
            // two-button toggle moved the cards below it.
            <MedicationViewToggle view={layout.view} onChange={setView} />
          }
        />
      </SettingsCard>

      {/* Manual order — applies to both list views. */}
      <SettingsCard id="medications-order" className="scroll-mt-28">
        <SettingsCardHeader
          icon={ListOrdered}
          title={t("moduleList.reorder.heading")}
          description={t("medications.reorderDescription")}
        />
        {isLoading || isLayoutLoading ? (
          // Row-shaped placeholders instead of a one-line spinner, so the
          // card below moves less when the list arrives.
          <div
            className="space-y-2"
            role="status"
            aria-label={t("common.loading")}
          >
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <MedicationOrderEditor medications={ordered} />
        )}
      </SettingsCard>

      {/* v1.18.0 (S5) — injection-site exclusions are a medication setting;
          they moved here from the account profile so all medication-specific
          preferences live in one place. */}
      <InjectionSitesCard isAuthenticated={isAuthenticated} />
    </div>
  );
}
