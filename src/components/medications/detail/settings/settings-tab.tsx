"use client";

/**
 * The medication's settings tab: four headings, one line per setting, the
 * name on the left and its control on the right. It replaces the schedule,
 * supply and advanced tabs.
 *
 *   Plan       medication (wizard), dose times, tracking, reminder, reminder
 *              length, reminder phases, record automatically, channels,
 *              supply
 *   Period     pause, end, courses, plan history
 *   Data       export, import, API access, clinical codes, composition
 *   Delete     history, medication
 *
 * A switch or a short choice sits in the row. Anything with more to it (the
 * dose-time editor, the supply ledger, the courses, the plan history, the
 * export options, the API token, the codes) opens a sheet from a row with a
 * chevron; the explanations live there, not on the tab. Each row keeps the
 * gate its control had on the old tabs: inside somebody else's record only
 * what the delegation's routes answer is offered.
 */

import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarRange,
  ChevronRight,
  Database,
  Pill,
  Trash2,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SectionHeading } from "@/components/ui/section-heading";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import { ScheduleTimesEditor } from "@/components/medications/scheduling/schedule-times-editor";
import { ScheduleHistoryTimeline } from "@/components/medications/scheduling/schedule-history-timeline";
import { InventorySection } from "@/components/medications/sections/inventory-section";
import { NotificationsBody } from "@/components/medications/sections/notifications-section";
import {
  DrugCodingRow,
  GraceRow,
} from "@/components/medications/sections/settings-section";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { DataPortabilityRow } from "@/components/medications/sections/data-portability-row";
import {
  DangerZoneBody,
  LifecycleManageBody,
} from "@/components/medications/sections/destructive-zone-section";
import { PhaseConfigSheet } from "@/components/medications/sections/phase-config-sheet";
import { AutoMarkTakenBody } from "@/components/medications/sections/auto-mark-taken-section";
import { IntakeTrackingBody } from "@/components/medications/sections/intake-tracking-section";
import {
  CoursesRow,
  GuardianCoursesSection,
} from "@/components/medications/sections/courses-section";
import { CompositionRow } from "@/components/medications/sections/composition-section";
import type { MedicationDetailSnapshot } from "@/components/medications/detail/medication-detail-tabs";
import { useJoinTimes } from "@/components/medications/medication-detail-summary";
import {
  holdsGuardianSurfaces,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { formatDose } from "@/lib/medications/format-dose";

export type SettingsSheet =
  "times" | "supply" | "courses" | "history" | "export" | "api" | "codes";

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function Group({
  icon,
  title,
  slot,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  slot: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" data-slot={slot}>
      <SectionHeading icon={icon} title={title} />
      <Card className="gap-0 py-1 md:gap-0 md:py-1">
        <ul className="divide-border/60 divide-y px-4 md:px-6">{children}</ul>
      </Card>
    </section>
  );
}

/** A row whose control is inline: a switch, a choice, a button. */
function InlineRow({ slot, children }: { slot: string; children: ReactNode }) {
  return (
    <li className="py-2.5" data-slot={slot}>
      {children}
    </li>
  );
}

/** A row that opens a sheet or another page: the name, its value, a chevron. */
function OpenRow({
  label,
  value,
  onOpen,
  href,
  slot,
}: {
  label: string;
  value?: ReactNode;
  onOpen?: () => void;
  href?: string;
  slot: string;
}) {
  const body = (
    <>
      <span className="text-foreground text-sm font-medium">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        {value != null && value !== "" && (
          <span className="text-muted-foreground truncate text-sm">
            {value}
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
      </span>
    </>
  );
  const className =
    "focus-visible:ring-ring/50 -mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-md px-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-[3px]";
  return (
    <li data-slot={slot}>
      {href ? (
        <Link href={href} className={className}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onOpen} className={className}>
          {body}
        </button>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Tab                                                                        */
/* -------------------------------------------------------------------------- */

export function MedicationSettingsTab({
  medication,
  recordOnly,
  asNeeded,
  courseEnded,
  showComposition,
  initialSheet = null,
  onEdit,
}: {
  medication: MedicationDetailSnapshot;
  recordOnly: boolean;
  asNeeded: boolean;
  courseEnded: boolean;
  /** The composition card is on the overview; the row only offers one. */
  showComposition: boolean;
  /** A sheet to open on arrival (an old `?tab=supply` link). */
  initialSheet?: SettingsSheet | null;
  /** Open the structural editor; absent when it is not offered. */
  onEdit?: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const joinTimes = useJoinTimes();
  const recordCaps = useRecordCapabilities();
  const { canManageDomain, inSharedRecord } = recordCaps;
  const canManage = canManageDomain("medications");
  // #1408 — the owner or a managed profile's guardian; no adult delegate.
  const runsSchedule = holdsGuardianSurfaces(recordCaps);
  const ownRecord = !inSharedRecord;
  const schedulePlan = ownRecord || runsSchedule;
  const { user: account } = useAuth();
  const nutrientsOn = account?.modules?.nutrients === true;

  const [sheet, setSheet] = useState<SettingsSheet | null>(initialSheet);
  const [phaseSheetOpen, setPhaseSheetOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const id = medication.id;
  const schedules = medication.schedules;
  const times = schedules.flatMap((s) =>
    s.timesOfDay && s.timesOfDay.length > 0 ? s.timesOfDay : [s.windowStart],
  );
  const scheduleSnapshots = scheduleSnapshotsOf(schedules);

  return (
    <div className="space-y-10" data-slot="medication-settings-tab">
      <div className="grid gap-10 lg:grid-cols-2 lg:gap-x-6">
        {/* PLAN */}
        {(schedulePlan || canManage) && (
          <Group
            icon={Pill}
            title={t("medications.detail.overview.plan.title")}
            slot="medication-settings-plan"
          >
            {onEdit && (
              <OpenRow
                label={t("medications.detail.settingsTab.rows.medication")}
                value={[medication.name, formatDose(medication.dose, t)]
                  .filter(Boolean)
                  .join(", ")}
                onOpen={onEdit}
                slot="medication-detail-full-edit"
              />
            )}
            {schedulePlan && schedules.length > 0 && (
              <OpenRow
                label={t("medications.detail.zeitplan.timesTitle")}
                value={joinTimes(
                  [...new Set(times)].sort().map((time) => fmt.wallTime(time)),
                )}
                onOpen={() => setSheet("times")}
                slot="medication-settings-times"
              />
            )}
            {schedulePlan && (
              <InlineRow slot="medication-settings-track-intake">
                <IntakeTrackingBody
                  key={recordOnly ? "off" : "on"}
                  medicationId={id}
                  trackIntake={!recordOnly}
                  courseEnded={courseEnded}
                  compact
                />
              </InlineRow>
            )}
            {schedulePlan && !recordOnly && (
              <>
                <InlineRow slot="medication-settings-reminder">
                  <NotificationsBody
                    medicationId={id}
                    notificationsEnabled={medication.notificationsEnabled}
                    autoMarkTaken={medication.autoMarkTaken === true}
                    compact
                  />
                </InlineRow>
                <InlineRow slot="medication-settings-grace">
                  <GraceRow
                    medicationId={id}
                    schedules={scheduleSnapshots}
                    compact
                  />
                </InlineRow>
                {!asNeeded && medication.autoMarkTaken !== true && (
                  <OpenRow
                    label={t("medications.phaseConfig")}
                    onOpen={() => setPhaseSheetOpen(true)}
                    slot="medication-detail-phase-management-row"
                  />
                )}
                {!asNeeded && (
                  <InlineRow slot="medication-settings-auto-mark">
                    <AutoMarkTakenBody
                      key={medication.autoMarkTaken ? "on" : "off"}
                      medicationId={id}
                      autoMarkTaken={medication.autoMarkTaken === true}
                      compact
                    />
                  </InlineRow>
                )}
                {ownRecord && (
                  <OpenRow
                    label={t("medications.detail.settingsTab.rows.channels")}
                    href="/settings/integrations#channels"
                    slot="zeitplan-manage-channels-link"
                  />
                )}
              </>
            )}
            {canManage && (
              <OpenRow
                label={t("medications.detail.bestand.title")}
                onOpen={() => setSheet("supply")}
                slot="medication-settings-supply"
              />
            )}
          </Group>
        )}

        {(ownRecord || runsSchedule) && (
          <PeriodGroup
            medication={medication}
            manageLifecycle={ownRecord || runsSchedule}
            onOpenSheet={setSheet}
          />
        )}

        {/* #1615: a managed profile's guardian pauses, ends and deletes a
            medication there, whose routes admit them; export, import and
            the per-medication tokens resolve the caller and stay the
            owner's. */}
        {(ownRecord || runsSchedule) && (
          <DataAndDeleteGroups
            medication={medication}
            showData={ownRecord}
            offerComposition={nutrientsOn && !showComposition}
            onOpenSheet={setSheet}
            onOpenImport={() => setImportOpen(true)}
          />
        )}
      </div>

      {sheet && (
        <SettingsSheetView
          sheet={sheet}
          onClose={() => setSheet(null)}
          medication={medication}
          recordOnly={recordOnly}
          ownRecord={ownRecord}
          times={times}
          schedules={scheduleSnapshots}
          onOpenImport={() => {
            setSheet(null);
            setImportOpen(true);
          }}
        />
      )}

      {importOpen && (
        <IntakeImportDialog
          medicationId={id}
          onClose={() => setImportOpen(false)}
        />
      )}

      <PhaseConfigSheet
        medicationId={id}
        open={phaseSheetOpen}
        onOpenChange={setPhaseSheetOpen}
      />
    </div>
  );
}

/** The delete row's count of recorded intakes; the owner's read. */
function useIntakeCount(id: string, enabled: boolean): number {
  const countParams = {
    sortBy: "takenAt",
    sortDir: "desc" as const,
    limit: 1,
    offset: 0,
    status: "completed",
  };
  const { data: intakeCount } = useQuery({
    queryKey: queryKeys.medicationIntakeList(id, countParams),
    queryFn: async () => {
      const search = new URLSearchParams({
        sortBy: countParams.sortBy,
        sortDir: countParams.sortDir,
        limit: String(countParams.limit),
        offset: String(countParams.offset),
        status: countParams.status,
      });
      try {
        const data = await apiGet<{ meta?: { total?: number } }>(
          `/api/medications/${id}/intake?${search.toString()}`,
        );
        return data?.meta?.total ?? 0;
      } catch {
        return 0;
      }
    },
    enabled,
    staleTime: 30_000,
  });

  return intakeCount ?? 0;
}

/** The sheet a settings row opens: the full control, with its explanations. */
function SettingsSheetView({
  sheet,
  onClose,
  medication,
  recordOnly,
  ownRecord,
  times,
  schedules,
  onOpenImport,
}: {
  sheet: SettingsSheet;
  onClose: () => void;
  medication: MedicationDetailSnapshot;
  recordOnly: boolean;
  ownRecord: boolean;
  times: string[];
  schedules: ScheduleSnapshotRow[];
  onOpenImport: () => void;
}) {
  const { t } = useTranslations();
  const sheetTitle: Record<SettingsSheet, string> = {
    times: t("medications.detail.zeitplan.timesTitle"),
    supply: t("medications.detail.bestand.title"),
    courses: t("medications.course.title"),
    history: t("medications.detail.zeitplan.history.title"),
    export: t("medications.detail.settingsTab.rows.export"),
    api: t("medications.detail.settingsTab.rows.api"),
    codes: t("medications.detail.settingsTab.rows.codes"),
  };
  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={sheetTitle[sheet]}
      contentWidth={sheet === "supply" || sheet === "history" ? "lg" : "md"}
    >
      <div
        className="space-y-4"
        data-slot={`medication-settings-sheet-${sheet}`}
      >
        {sheet === "times" && (
          <ScheduleTimesEditor
            medicationId={medication.id}
            trackIntake={!recordOnly}
            schedules={schedules}
          />
        )}
        {sheet === "supply" && (
          <InventorySection
            medicationId={medication.id}
            dosesPerUnit={medication.dosesPerUnit}
            unitsPerDose={medication.unitsPerDose}
            deliveryForm={medication.deliveryForm}
          />
        )}
        {sheet === "courses" &&
          (ownRecord ? (
            <CoursesRow
              medicationId={medication.id}
              courses={medication.courses ?? []}
              canStartCourse={medication.canStartCourse === true}
              canEdit
              showTitle={false}
            />
          ) : (
            <GuardianCoursesSection
              medicationId={medication.id}
              courses={medication.courses ?? []}
              canStartCourse={medication.canStartCourse === true}
            />
          ))}
        {sheet === "history" && (
          <ScheduleHistoryTimeline
            medicationId={medication.id}
            currentTimes={times}
          />
        )}
        {sheet === "export" && (
          <DataPortabilityRow
            medicationId={medication.id}
            onOpenImport={onOpenImport}
          />
        )}
        {sheet === "api" && (
          <ApiTokensRow
            medicationId={medication.id}
            medicationName={medication.name}
          />
        )}
        {sheet === "codes" && (
          <DrugCodingRow
            medicationId={medication.id}
            atcCode={medication.atcCode}
            rxNormCode={medication.rxNormCode}
          />
        )}
      </div>
    </ResponsiveSheet>
  );
}

type ScheduleSnapshotRow = ReturnType<typeof scheduleSnapshotsOf>[number];

/** The stored schedules as the times editor and the grace row take them. */
function scheduleSnapshotsOf(schedules: MedicationDetailSnapshot["schedules"]) {
  return schedules.map((s) => ({
    id: s.id,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    label: s.label,
    dose: s.dose,
    daysOfWeek: s.daysOfWeek,
    timesOfDay: s.timesOfDay,
    rrule: s.rrule,
    rollingIntervalDays: s.rollingIntervalDays,
    reminderGraceMinutes: s.reminderGraceMinutes,
    scheduleType: s.scheduleType,
    cyclicOnWeeks: s.cyclicOnWeeks,
    cyclicOffWeeks: s.cyclicOffWeeks,
    doseWindows: s.doseWindows,
  }));
}

/** The owner's data and delete groups. */
function DataAndDeleteGroups({
  medication,
  showData,
  offerComposition,
  onOpenSheet,
  onOpenImport,
}: {
  medication: MedicationDetailSnapshot;
  /** Export, import, API access and codes: the owner's only. */
  showData: boolean;
  offerComposition: boolean;
  onOpenSheet: (sheet: SettingsSheet) => void;
  onOpenImport: () => void;
}) {
  const { t } = useTranslations();
  const intakeCount = useIntakeCount(medication.id, true);
  return (
    <>
      {/* DATA */}
      {showData && (
        <Group
          icon={Database}
          title={t("medications.detail.erweitert.group.data")}
          slot="medication-settings-data"
        >
          <OpenRow
            label={t("medications.detail.settingsTab.rows.export")}
            value="CSV"
            onOpen={() => onOpenSheet("export")}
            slot="medication-settings-export"
          />
          <OpenRow
            label={t("medications.detail.settingsTab.rows.import")}
            value="JSON"
            onOpen={onOpenImport}
            slot="medication-settings-import"
          />
          <OpenRow
            label={t("medications.detail.settingsTab.rows.api")}
            onOpen={() => onOpenSheet("api")}
            slot="api-group-external-api"
          />
          <OpenRow
            label={t("medications.detail.settingsTab.rows.codes")}
            value={[medication.atcCode, medication.rxNormCode]
              .filter(Boolean)
              .join(", ")}
            onOpen={() => onOpenSheet("codes")}
            slot="medication-settings-codes"
          />
          {offerComposition && (
            <InlineRow slot="medication-settings-composition">
              <CompositionRow medicationId={medication.id} ownRecord />
            </InlineRow>
          )}
        </Group>
      )}

      {/* DELETE */}
      <Group
        icon={Trash2}
        title={t("common.delete")}
        slot="erweitert-group-danger"
      >
        <li>
          <DangerZoneBody
            medicationId={medication.id}
            medicationName={medication.name}
            intakeCount={intakeCount}
            compact
          />
        </li>
      </Group>
    </>
  );
}

/** Pause, end, the courses and the plan history. */
function PeriodGroup({
  medication,
  manageLifecycle,
  onOpenSheet,
}: {
  medication: MedicationDetailSnapshot;
  /** Pause and end: the owner's, and a managed profile's guardian's. */
  manageLifecycle: boolean;
  onOpenSheet: (sheet: SettingsSheet) => void;
}) {
  const { t } = useTranslations();
  const courses = medication.courses ?? [];
  return (
    <Group
      icon={CalendarRange}
      title={t("medications.detail.settingsTab.groups.period")}
      slot="medication-settings-period"
    >
      {manageLifecycle && (
        <li data-slot="medication-settings-lifecycle">
          <LifecycleManageBody medication={medication} compact />
        </li>
      )}
      <OpenRow
        label={t("medications.course.title")}
        value={
          courses.length > 0
            ? t("medications.detail.settingsTab.courseCount", {
                count: courses.length,
              })
            : undefined
        }
        onOpen={() => onOpenSheet("courses")}
        slot="medication-settings-courses"
      />
      <OpenRow
        label={t("medications.detail.zeitplan.history.title")}
        onOpen={() => onOpenSheet("history")}
        slot="medication-zeitplan-history"
      />
    </Group>
  );
}
