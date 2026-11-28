"use client";

/**
 * The medication detail page's Erweitert tab: lifecycle, data, the external
 * API and the danger zone, in that order.
 *
 * The owner sees all of it. #1615 — a managed profile's guardian sees it too,
 * because its lifecycle, editor and danger-zone routes (pause, end, purge,
 * delete) admit them; the rows whose routes resolve the caller rather than
 * the record (export and import, the per-medication tokens, the course
 * editor that the guardian finds on the Schedule tab) stay hidden inside a
 * shared record.
 */
import { useState } from "react";
import { Pencil } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { CoursesRow } from "@/components/medications/sections/courses-section";
import { CompositionRow } from "@/components/medications/sections/composition-section";
import { DrugCodingRow } from "@/components/medications/sections/settings-section";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { DataPortabilityRow } from "@/components/medications/sections/data-portability-row";
import {
  DangerZoneBody,
  LifecycleManageBody,
} from "@/components/medications/sections/destructive-zone-section";
import { SettingsGroup } from "@/components/medications/settings-group";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import type { MedicationCourseWire } from "@/components/medications/course-fields";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

export function MedicationAdvancedTab({
  medication,
  inSharedRecord,
  showCompositionRow,
  onEdit,
}: {
  medication: {
    id: string;
    name: string;
    active: boolean;
    canEndCourse?: boolean;
    courses?: MedicationCourseWire[];
    canStartCourse?: boolean;
    atcCode?: string | null;
    rxNormCode?: string | null;
  };
  inSharedRecord: boolean;
  showCompositionRow: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslations();
  const [importOpen, setImportOpen] = useState(false);
  const id = medication.id;

  return (
    <>
      <SettingsGroup
        label={t("medications.detail.erweitert.group.lifecycle")}
        dataSlot="erweitert-group-lifecycle"
        collapsible
        defaultOpen={false}
      >
        <div className="py-3">
          <LifecycleManageBody medication={medication} />
        </div>
        {/* The courses (#1024): when it was taken, and a new
            course once the last one has ended. */}
        {/* A guardian's courses sit on the Schedule tab. */}
        {!inSharedRecord && (
          <div className="py-3">
            <CoursesRow
              medicationId={id}
              courses={medication.courses ?? []}
              canStartCourse={medication.canStartCourse === true}
              canEdit
            />
          </div>
        )}
        {/* The structural editor (the create/edit wizard) — name,
            class, cadence kind, schedules. Replaces the former hero
            "Vollständig bearbeiten" button, which read as "edit this
            page". */}
        <div
          className="flex items-center justify-between gap-3 py-3"
          data-slot="erweitert-editor-row"
        >
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">
              {t("medications.detail.erweitert.editor.title")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("medications.detail.erweitert.editor.helper")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="medication-detail-full-edit"
          >
            <Pencil aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.erweitert.editor.button")}
          </Button>
        </div>
        {showCompositionRow && (
          <CompositionRow medicationId={id} ownRecord={!inSharedRecord} />
        )}
      </SettingsGroup>

      {/* Export, import and the per-medication tokens resolve the
          caller, so a shared record does not offer them. */}
      {!inSharedRecord && (
        <SettingsGroup
          label={t("medications.detail.erweitert.group.data")}
          dataSlot="erweitert-group-data"
          collapsible
          defaultOpen={false}
        >
          <div className="py-3">
            <DataPortabilityRow
              medicationId={id}
              onOpenImport={() => setImportOpen(true)}
            />
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup
        label={t("medications.detail.erweitert.group.externalApi")}
        dataSlot="api-group-external-api"
        collapsible
        defaultOpen={false}
      >
        {!inSharedRecord && (
          <div className="py-3">
            <ApiTokensRow medicationId={id} medicationName={medication.name} />
          </div>
        )}
        <div className="py-3">
          <DrugCodingRow
            medicationId={id}
            atcCode={medication.atcCode}
            rxNormCode={medication.rxNormCode}
          />
        </div>
      </SettingsGroup>

      <ComplianceGatedDangerZone
        medicationId={id}
        medicationName={medication.name}
      />

      {importOpen && (
        <IntakeImportDialog
          medicationId={id}
          onClose={() => setImportOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The danger zone's purge gate needs `intakeCount`. Fetch it lazily here
 * (the Erweitert tab pays for it; the other tabs never do) rather than
 * threading a count the page doesn't otherwise need.
 */
function ComplianceGatedDangerZone({
  medicationId,
  medicationName,
}: {
  medicationId: string;
  medicationName: string;
}) {
  const params = {
    sortBy: "takenAt",
    sortDir: "desc" as const,
    limit: 1,
    offset: 0,
    status: "completed",
  };
  const { data: intakeCount } = useQuery({
    queryKey: queryKeys.medicationIntakeList(medicationId, params),
    queryFn: async () => {
      const search = new URLSearchParams({
        sortBy: params.sortBy,
        sortDir: params.sortDir,
        limit: String(params.limit),
        offset: String(params.offset),
        status: params.status,
      });
      try {
        const data = await apiGet<{ meta?: { total?: number } }>(
          `/api/medications/${medicationId}/intake?${search.toString()}`,
        );
        return data?.meta?.total ?? 0;
      } catch {
        return 0;
      }
    },
    staleTime: 30_000,
  });

  const { t } = useTranslations();

  return (
    // The same neutral card chrome as every other group; only the
    // action buttons stay destructive. A red-washed card read as a
    // constant alarm on a page the user visits routinely.
    <SettingsGroup
      label={t("medications.detail.erweitert.group.danger")}
      dataSlot="erweitert-group-danger"
      collapsible
      defaultOpen={false}
    >
      <DangerZoneBody
        medicationId={medicationId}
        medicationName={medicationName}
        intakeCount={intakeCount ?? 0}
      />
    </SettingsGroup>
  );
}
