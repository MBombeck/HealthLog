"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FolderTree,
  Layers,
  LayoutGrid,
  ListOrdered,
  Loader2,
} from "lucide-react";

import {
  MedicationOrderEditor,
  type ReorderMedication,
} from "@/components/medications/medication-order-editor";
import { MedicationViewToggle } from "@/components/medications/medication-view-toggle";
import { SettingsCard } from "@/components/settings/settings-card";
import { MedicineRegistryCard } from "@/components/settings/medicine-registry-card";
import { useAuth } from "@/hooks/use-auth";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/segmented";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { applyMedicationOrder } from "@/lib/medications/medication-order";
import { queryKeys } from "@/lib/query-keys";
import { useMedicationListLayout } from "@/lib/queries/use-medication-list-layout";
import {
  sortMedicationCategoriesByDefault,
  type MedicationGroupBy,
  type MedicationGroupsOpen,
} from "@/lib/medication-list-layout";
import {
  applyCategoryOrder,
  mergeCategoryOrder,
} from "@/lib/settings/module-list-layout";
import { MEDICATION_CATEGORY_VALUES } from "@/lib/medications/category-values";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import { useMedicationCategories } from "@/components/medications/use-medication-categories";

/**
 * v1.16.10 — the "Medikamente" settings section. v1.18.0 (S5) promoted it
 * from a Layout-hub child to its own standalone nav entry and gathered the
 * medication-specific preferences here. v1.18.1 (D3) made medications a
 * toggleable fail-open module, so this nav entry hides when the account
 * turns the module off (the medication data routes stay live). Hosts:
 *   1. The list VIEW preference — cards vs table, written optimistically
 *      through the same `PUT /api/medications/layout` the page header
 *      toggle uses (the toggle component is shared).
 *   2. Grouping and default open preferences — the category grouping toggle
 *      and the open mode (expanded / flagged / collapsed), written optimistically.
 *   3. The manual ORDER editor — two grouped lists (Aktiv / Inaktiv)
 *      with drag + arrow reordering, flushed by an explicit Save,
 *      persisted as active-ids-then-inactive-ids on the same layout row.
 *   4. #1430 — the medicine registry the leaflet search opens, first,
 *      because it is a choice rather than an arrangement.
 *
 * v1.44 — Arrangement holds order and view only; the injection-site
 * exclusions moved to the medications page under Modules.
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
  const {
    layout,
    isLayoutLoading,
    setView,
    setGroupBy,
    setGroupsOpen,
    saveCategoryOrder,
  } = useMedicationListLayout();

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

  // v1.18.6 — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the medication cards.
  return (
    <div className="space-y-6">
      {/* #1430 — where "Find leaflet" searches; independent of language. */}
      <MedicineRegistryCard isAuthenticated={isAuthenticated} />

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

      {/* Category grouping on/off & default open preference */}
      <MedicationsGroupingCard
        groupBy={layout.groupBy ?? "none"}
        groupsOpen={layout.groupsOpen ?? "expanded"}
        onGroupBy={setGroupBy}
        onGroupsOpen={setGroupsOpen}
      />

      {/* Category ordering for built-in and custom categories */}
      {(layout.groupBy ?? "none") === "category" ? (
        <MedicationsCategoryOrderCard
          savedCategoryOrder={layout.categoryOrder ?? []}
          onSave={saveCategoryOrder}
        />
      ) : null}

      {/* Manual order — applies to both list views. */}
      <SettingsCard id="medications-order" className="scroll-mt-28">
        <SettingsCardHeader
          icon={ListOrdered}
          title={t("moduleList.reorder.heading")}
          description={
            (layout.groupBy ?? "none") === "category"
              ? t("medications.groups.orderWithinGroups")
              : t("medications.reorderDescription")
          }
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
    </div>
  );
}

function MedicationsGroupingCard({
  groupBy,
  groupsOpen,
  onGroupBy,
  onGroupsOpen,
}: {
  groupBy: MedicationGroupBy;
  groupsOpen: MedicationGroupsOpen;
  onGroupBy: (value: MedicationGroupBy) => void;
  onGroupsOpen: (value: MedicationGroupsOpen) => void;
}) {
  const { t } = useTranslations();
  return (
    <SettingsCard id="medications-groups" className="scroll-mt-28">
      <SettingsCardHeader
        icon={FolderTree}
        title={t("medications.groups.heading")}
        description={t("medications.groups.description")}
      />
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("medications.groups.label")}</p>
        <Segmented
          mode="toggle"
          value={groupBy}
          onChange={onGroupBy}
          label={t("medications.groups.label")}
          optionSlot={(value) => `medications-group-by-${value}`}
          options={[
            { value: "none", label: t("medications.groups.none") },
            { value: "category", label: t("medications.groups.category") },
          ]}
        />
      </div>
      {groupBy === "category" ? (
        <div className="space-y-2" data-slot="medications-groups-open">
          <p className="text-sm font-medium">
            {t("medications.groups.openLabel")}
          </p>
          <Segmented
            mode="toggle"
            value={groupsOpen}
            onChange={onGroupsOpen}
            label={t("medications.groups.openLabel")}
            optionSlot={(value) => `medications-groups-open-${value}`}
            options={[
              {
                value: "expanded",
                label: t("medications.groups.openExpanded"),
              },
              {
                value: "flagged",
                label: t("medications.groups.openFlagged"),
              },
              {
                value: "collapsed",
                label: t("medications.groups.openCollapsed"),
              },
            ]}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}

/**
 * Resolves the draft after a save attempt: if successful, clears only the
 * exact submitted snapshot. Any in-flight reorders made while the PUT was
 * pending are preserved in the current draft.
 */
export function clearSubmittedDraft(
  current: string[] | null,
  submitted: string[],
): string[] | null {
  return current === submitted ? null : current;
}

export function MedicationsCategoryOrderCard({
  savedCategoryOrder,
  onSave,
}: {
  savedCategoryOrder: readonly string[];
  onSave: (categoryOrder: string[]) => Promise<boolean>;
}) {
  const { t } = useTranslations();
  const customCategories = useMedicationCategories();
  const [saving, setSaving] = useState(false);
  const [draftOrder, setDraftOrder] = useState<string[] | null>(null);

  // Built-in categories:
  // Default order follows Labs patterns: built-ins (excluding OTHER), then custom categories, then OTHER last.
  const builtInsWithoutOther = MEDICATION_CATEGORY_VALUES.filter(
    (c) => c !== "OTHER",
  ).map((c) => ({
    key: c,
    label: getMedicationCategoryLabel(c, t),
  }));

  const customItems = (customCategories.data ?? []).map((c) => ({
    key: c.key,
    label: c.label,
  }));

  const otherItem = {
    key: "OTHER",
    label: getMedicationCategoryLabel("OTHER", t),
  };

  const defaultCategories = sortMedicationCategoriesByDefault([
    ...builtInsWithoutOther,
    ...customItems,
    otherItem,
  ]);

  const effectiveOrder = draftOrder ?? savedCategoryOrder;
  const orderedCategories = applyCategoryOrder(
    defaultCategories,
    effectiveOrder,
    "OTHER",
  );

  const reorderItems: ReorderItem[] = orderedCategories.map((c) => ({
    id: c.key,
    name: c.label,
  }));

  const dirty = draftOrder !== null;

  async function handleSave() {
    if (saving || !draftOrder) return;
    const submitted = draftOrder;
    setSaving(true);
    const merged = mergeCategoryOrder(submitted, savedCategoryOrder);
    let ok = false;
    try {
      ok = await onSave(merged);
    } finally {
      setSaving(false);
    }
    if (ok) {
      setDraftOrder((current) => clearSubmittedDraft(current, submitted));
    }
  }

  function handleCancel() {
    setDraftOrder(null);
  }

  return (
    <SettingsCard id="medications-category-order" className="scroll-mt-28">
      <SettingsCardHeader
        icon={Layers}
        title={t("medications.groups.orderHeading")}
        description={t("medications.groups.orderDefault", {
          other: t("medications.categoryOther"),
        })}
      />
      {customCategories.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div
          className="space-y-4"
          data-slot="medications-category-order-editor"
        >
          <ModuleOrderEditor items={reorderItems} onChange={setDraftOrder} />
          {dirty && (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                disabled={saving}
              >
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("common.save")}
              </Button>
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
