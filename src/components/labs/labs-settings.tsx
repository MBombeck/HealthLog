"use client";

/**
 * The Labs module's settings, in two places since v1.44:
 *
 * `LabsSettings` — Settings > Arrangement > Labs: the card-vs-list view
 * (MOD-03), the sort (recency, alphabetical or manual, MOD-04) and the manual
 * order of the biomarkers. Order and view only, persisted per account through
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
  LayoutGrid,
  ListOrdered,
  ScanText,
} from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
  type ModuleSortDir,
} from "@/lib/module-list-prefs";

import { BiomarkerManager } from "./biomarker-manager";
import type { BiomarkerDto, BiomarkerListResponse } from "./types";
import { useLabsLocalOcr, useUpdateLabsLocalOcr } from "./use-ocr-extract";
import { labUnitLabel } from "@/lib/labs/dimensionless";

export function LabsSettings() {
  const { t } = useTranslations();
  const { prefs, setView, setOrder, setSortDir } = useModuleListPrefs("labs");

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

      {manual ? (
        <SettingsCard id="labs-order" className="scroll-mt-28">
          <SettingsCardHeader
            icon={ListOrdered}
            title={t("moduleList.reorder.heading")}
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
