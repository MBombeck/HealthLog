"use client";

/**
 * The Labs module's settings, in two places since v1.44:
 *
 * `LabsSettings` — Settings > Arrangement > Labs: the card-vs-list view
 * (MOD-03), the sort (recency, alphabetical or manual, MOD-04) and the manual
 * order of the biomarkers, and whether the list shows its categories, which
 * of them start open and their order. Persisted per account through
 * `useModuleListPrefs("labs")`.
 *
 * `LabsModuleSettings` — Settings > Modules > Labs: the on-device text
 * recognition opt-in and the biomarker catalog (`BiomarkerManager`). Reached
 * from the wrench on the labs page.
 */
import { useQuery } from "@tanstack/react-query";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  ArrowDownUp,
  FlaskConical,
  FolderTree,
  Layers,
  LayoutGrid,
  ListOrdered,
  ScanText,
} from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { apiGet } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import {
  applyOrder,
  useModuleListPrefs,
  type ModuleGroupBy,
  type ModuleGroupsOpen,
  type ModuleSortDir,
} from "@/lib/module-list-prefs";
import { mergeCategoryOrder } from "@/lib/settings/module-list-layout";

import { BiomarkerManager } from "./biomarker-manager";
import type {
  BiomarkerDto,
  BiomarkerListResponse,
  LabOverviewResponse,
} from "./types";
import { useLabsLocalOcr, useUpdateLabsLocalOcr } from "./use-ocr-extract";
import { labUnitLabel } from "@/lib/labs/dimensionless";

export function LabsSettings() {
  const { t } = useTranslations();
  const {
    prefs,
    setView,
    setOrder,
    setSortDir,
    setGroupBy,
    setGroupsOpen,
    setCategoryOrder,
  } = useModuleListPrefs("labs");

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
  });
  const markers: BiomarkerDto[] = data?.biomarkers ?? [];

  const ordered = applyOrder(markers, prefs.order, (m) => m.id);
  const reorderItems: ReorderItem[] = ordered.map((m) => ({
    id: m.id,
    name: m.name,
    secondary: [labUnitLabel(m.unit, t), m.panel].filter(Boolean).join(" · "),
  }));

  const manual = prefs.sortDir === "manual";

  // v1.18.9 (#44) — the Labs settings sub-page now follows the canonical
  // Settings dialect: every block is a `<SettingsCard>` with a
  // `<SettingsCardHeader>` (neutral icon + title + short description), the
  // same shape as Stimmung / AI / Mitteilungen, instead of bare `<section>` +
  // `text-sm` headings.
  return (
    <div className="space-y-6">
      {/* View — card vs compact list. */}
      <SettingsCard id="labs-view" className="scroll-mt-28">
        <SettingsCardHeader
          icon={LayoutGrid}
          title={t("moduleList.viewHeading")}
          description={t("moduleList.viewDescription")}
          status={<ModuleViewToggle view={prefs.view} onChange={setView} />}
        />
      </SettingsCard>

      {/* Sort order — recency, alphabetical, or manual. */}
      <SettingsCard id="labs-sort-card" className="scroll-mt-28">
        <SettingsCardHeader
          icon={ArrowDownUp}
          title={t("labs.sort.heading")}
          description={t("labs.sort.hint")}
        />
        <div className="space-y-2">
          <Label htmlFor="labs-sort">{t("labs.sort.label")}</Label>
          <NativeSelect
            id="labs-sort"
            value={prefs.sortDir}
            onChange={(e) => setSortDir(e.target.value as ModuleSortDir)}
          >
            <option value="recentDesc">{t("labs.sort.recentDesc")}</option>
            <option value="recentAsc">{t("labs.sort.recentAsc")}</option>
            <option value="alphaAsc">{t("labs.sort.alphaAsc")}</option>
            <option value="alphaDesc">{t("labs.sort.alphaDesc")}</option>
            <option value="manual">{t("labs.sort.manual")}</option>
          </NativeSelect>
        </div>
      </SettingsCard>

      <LabsGroupingCard
        groupBy={prefs.groupBy}
        groupsOpen={prefs.groupsOpen}
        onGroupBy={setGroupBy}
        onGroupsOpen={setGroupsOpen}
      />

      {prefs.groupBy === "category" ? (
        <LabsCategoryOrderCard
          onChange={(shown) =>
            setCategoryOrder(mergeCategoryOrder(shown, prefs.categoryOrder))
          }
        />
      ) : null}

      {manual ? (
        <SettingsCard id="labs-order" className="scroll-mt-28">
          <SettingsCardHeader
            icon={ListOrdered}
            title={t("moduleList.reorder.heading")}
            description={
              prefs.groupBy === "category"
                ? t("labs.groups.orderWithinGroups")
                : undefined
            }
          />
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ModuleOrderEditor items={reorderItems} onChange={setOrder} />
          )}
        </SettingsCard>
      ) : null}
    </div>
  );
}

/**
 * Categories on or off, and which of them start open. The second choice only
 * shows while categories are on; it means nothing for a flat list.
 */
function LabsGroupingCard({
  groupBy,
  groupsOpen,
  onGroupBy,
  onGroupsOpen,
}: {
  groupBy: ModuleGroupBy;
  groupsOpen: ModuleGroupsOpen;
  onGroupBy: (value: ModuleGroupBy) => void;
  onGroupsOpen: (value: ModuleGroupsOpen) => void;
}) {
  const { t } = useTranslations();
  return (
    <SettingsCard id="labs-groups" className="scroll-mt-28">
      <SettingsCardHeader
        icon={FolderTree}
        title={t("labs.groups.heading")}
        description={t("labs.groups.description")}
      />
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("labs.groups.label")}</p>
        <Segmented
          mode="toggle"
          value={groupBy}
          onChange={onGroupBy}
          label={t("labs.groups.label")}
          optionSlot={(value) => `labs-group-by-${value}`}
          options={[
            { value: "none", label: t("labs.groups.none") },
            { value: "category", label: t("labs.groups.category") },
          ]}
        />
      </div>
      {groupBy === "category" ? (
        <div className="space-y-2" data-slot="labs-groups-open">
          <p className="text-sm font-medium">{t("labs.groups.openLabel")}</p>
          <Segmented
            mode="toggle"
            value={groupsOpen}
            onChange={onGroupsOpen}
            label={t("labs.groups.openLabel")}
            optionSlot={(value) => `labs-groups-open-${value}`}
            options={[
              { value: "expanded", label: t("labs.groups.openExpanded") },
              { value: "flagged", label: t("labs.groups.openFlagged") },
              { value: "collapsed", label: t("labs.groups.openCollapsed") },
            ]}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}

/**
 * The order of the categories. The server answers them already in the
 * person's order (`GET /api/labs/overview` applies `categoryOrder`), so the
 * editor lists them as given, under the labels the overview carries, and
 * sends the whole order after every move.
 */
function LabsCategoryOrderCard({
  onChange,
}: {
  onChange: (categoryOrder: string[]) => void;
}) {
  const { t, locale } = useTranslations();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.labResultsOverview(locale),
    queryFn: () => apiGet<LabOverviewResponse>("/api/labs/overview"),
  });
  const items: ReorderItem[] = (data?.categories ?? []).map((category) => ({
    id: category.key,
    name: category.label,
  }));

  return (
    <SettingsCard id="labs-category-order" className="scroll-mt-28">
      <SettingsCardHeader
        icon={Layers}
        title={t("labs.groups.orderHeading")}
        description={t("labs.groups.orderDefault", {
          other: t("labs.groups.other"),
        })}
      />
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <QueryErrorRow
          error={error}
          inset
          slot="labs-category-order-error"
          onRetry={() => void refetch()}
        />
      ) : (
        <ModuleOrderEditor items={items} onChange={onChange} />
      )}
    </SettingsCard>
  );
}

export function LabsModuleSettings() {
  const { t } = useTranslations();
  // v1.18.10 — local (in-browser) OCR opt-in. Lets a user whose AI provider
  // can't read images still scan a report: the image is OCR'd on-device and
  // only the extracted text is sent to the text-only provider.
  const localOcr = useLabsLocalOcr();
  const updateLocalOcr = useUpdateLabsLocalOcr();

  return (
    <div className="space-y-6">
      {/* v1.18.10 — local (in-browser) OCR opt-in for lab scans. */}
      <SettingsCard id="labs-local-ocr" className="scroll-mt-28">
        <SettingsCardHeader
          icon={ScanText}
          title={t("labs.localOcr.heading")}
          description={t("labs.localOcr.description")}
          status={
            <Switch
              checked={localOcr.data?.labsLocalOcrEnabled ?? false}
              disabled={localOcr.isLoading || updateLocalOcr.isPending}
              onCheckedChange={(checked) =>
                updateLocalOcr.mutate(checked, {
                  onSuccess: () =>
                    toastWrittenOutcome("success", t("settings.saved")),
                  onError: (failure) =>
                    showErrorToast(t("settings.savingError"), {
                      cause: failure,
                    }),
                })
              }
              aria-label={t("labs.localOcr.heading")}
            />
          }
        />
        {/* "Less accurate — review every value" is safety copy, so it reads
            foreground in the body rather than muted beside the switch. */}
        <p className="text-sm">{t("labs.localOcr.detail")}</p>
      </SettingsCard>

      {/* Biomarker catalog — define / edit / delete. */}
      <SettingsCard id="labs-biomarkers" className="scroll-mt-28">
        <SettingsCardHeader
          icon={FlaskConical}
          title={t("labs.biomarker.manageTitle")}
          description={t("labs.biomarker.managerDescription")}
        />
        <BiomarkerManager />
      </SettingsCard>
    </div>
  );
}
