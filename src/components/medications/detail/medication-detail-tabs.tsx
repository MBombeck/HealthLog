"use client";

/**
 * The medication detail page: a one-line header with the page menu, then
 * four tabs (Übersicht, Verlauf, Wirkung, Einstellungen), with Injektion as a
 * fifth for an injectable medication.
 *
 *   Übersicht      three cards built the same way (today, intake, effect)
 *                  and the plan; then the composition, the related records
 *                  and the leaflet.
 *   Verlauf        the dose history, one row per day, or the full intake
 *                  list.
 *   Wirkung        the effect view: the result sentence first, the chart,
 *                  the method behind a fold.
 *   Einstellungen  every setting in one line each; the schedule, supply and
 *                  advanced tabs folded into it in v1.50.
 *
 * Tab state lives in the URL (`?tab=<slug>`); old slugs resolve through
 * `LEGACY_TAB_SLUGS`, and an old supply link opens the supply sheet. The
 * medications list's "Bearbeiten" arrives as `?edit=1` and opens the wizard.
 * Only the active tab body mounts (Radix `Tabs`), so inactive tabs do not
 * fetch. Every value shown is the server's (`nextDueAt`, the compliance read,
 * the dose-history ledger, the efficacy DTO with its result sentence).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MoreVertical } from "lucide-react";

import type { MedicationCourseWire } from "@/components/medications/course-fields";
import {
  COMPOSITION_CATEGORIES,
  CompositionSection,
} from "@/components/medications/sections/composition-section";
import type { MedicationIngredientDto } from "@/components/medications/sections/use-composition";
import { useAuth } from "@/hooks/use-auth";
import {
  holdsGuardianSurfaces,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { useUrlSearch, writeUrlState } from "@/lib/url-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Segmented } from "@/components/ui/segmented";
import { MedicationDetailSummary } from "@/components/medications/medication-detail-summary";
import { EfficacyTab } from "@/components/medications/detail/efficacy/efficacy-tab";
import {
  RetargetSheet,
  useMayRetarget,
} from "@/components/medications/detail/efficacy/retarget-sheet";
import { resolveMedicationTargets } from "@/lib/medications/med-target-map";
import { DoseHistoryLedger } from "@/components/medications/dose-history-ledger";
import { LedgerAddDialog } from "@/components/medications/dose-history-add-dialog";
import { IntakeHistoryListV2 } from "@/components/medications/intake-history-list-v2";
import type { DoseWindowEntry } from "@/components/medications/scheduling/dose-window";
import {
  EndCourseDialog,
  usePauseToggle,
} from "@/components/medications/sections/destructive-zone-section";
import { SideEffectsSection } from "@/components/medications/side-effects-section";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { TitrationTimeline } from "@/components/medications/titration-timeline";
import { MedicationWizardDialog } from "@/components/medications/wizard/medication-wizard-dialog";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { formatDose } from "@/lib/medications/format-dose";
import type { MedicationEfficacyDTO } from "@/lib/medications/efficacy/build-efficacy";
import { MedicationRelatedSection } from "@/components/medications/detail/medication-related-section";
import { snapshotToWizardPayload } from "@/components/medications/detail/snapshot-wizard-payload";
import type { LeafletSearch } from "@/lib/medications/leaflet-registries";
import type { RelatedLink } from "@/lib/links/related";
import {
  LEGACY_TAB_SHEETS,
  resolveTabSlug,
  scrollActiveIntoRow,
  TAB_LABEL_KEYS,
  TAB_SLUGS,
  type TabSlug,
} from "@/components/medications/detail/tab-slugs";
import type { OverviewCompliance } from "@/components/medications/detail/overview/anatomy";
import { EffectCard } from "@/components/medications/detail/overview/effect-card";
import {
  GRID_DAYS,
  IntakeCard,
  useOverviewLedger,
} from "@/components/medications/detail/overview/intake-card";
import { PlanCard } from "@/components/medications/detail/overview/plan-card";
import {
  TodayCard,
  useTodayDoses,
} from "@/components/medications/detail/overview/today-card";
import { MedicationSettingsTab } from "@/components/medications/detail/settings/settings-tab";
import { useTodayKey } from "@/components/day/use-today-key";

// Recharts stays out of the detail page's initial bundle: both chart bodies
// load through `next/dynamic` (client-only) with the shared chart skeleton
// standing in while the chunk streams.
const DrugLevelChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DrugLevelChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const DoseStrengthCurve = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DoseStrengthCurve,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

interface ScheduleSnapshot {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  reminderGraceMinutes?: number | null;
  scheduleType?: string | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
  // v1.15.18 — per-dose on-time windows; the GET returns the raw Json
  // column, the Zeitplan inline editor round-trips it on save.
  doseWindows?: DoseWindowEntry[] | null;
}

export interface MedicationDetailSnapshot {
  id: string;
  name: string;
  dose: string;
  category: string;
  /** v1.40 — the label of a custom category; null for a built-in one. */
  categoryLabel?: string | null;
  treatmentClass?: string;
  deliveryForm?: string;
  dosesPerUnit?: number | null;
  /** v1.16.10 — inventory units one dose consumes (default 1). */
  unitsPerDose?: number | null;
  trackInjectionSites?: boolean;
  allowedInjectionSites?: string[];
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  oneShot?: boolean;
  /** v1.16.11 (#316) — as-needed (PRN): no schedules, never due. */
  asNeeded?: boolean;
  atcCode?: string | null;
  rxNormCode?: string | null;
  /** #1371 — the person's own note on the medication; null = none. */
  note?: string | null;
  /** #1430 — the saved leaflet link, and the registry search. */
  leafletUrl?: string | null;
  leafletSearch?: LeafletSearch | null;
  /**
   * v1.15.20 — server-computed next due instant (the detail GET carries
   * it alongside the row). The Übersicht status surface renders it
   * directly; no client-side recurrence walking.
   */
  nextDueAt?: string | null;
  /** True while `nextDueAt` is an open slot past its on-time window. */
  nextDueOverdue?: boolean;
  /**
   * v1.37.19 — server-resolved slot-aware runway (days); null = inventory
   * tracking off or no consuming cadence. Preferred over the client
   * estimate; the estimate remains only as the stale-payload fallback.
   */
  runwayDays?: number | null;
  /**
   * v1.39.1 (#1033) — false keeps the medication as a record. The detail
   * GET then serves `schedules: []` and the stored rows in
   * `recordedSchedules`; the page shows (and edits) the stored rows.
   */
  trackIntake?: boolean;
  /** v1.42.2 — doses recorded automatically. */
  autoMarkTaken?: boolean;
  /** v1.39.4 (#1040) — where today sits in the course (server-resolved). */
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED";
  /** v1.40 (#1024) — the server-resolved courses. */
  courses?: MedicationCourseWire[];
  canStartCourse?: boolean;
  canEndCourse?: boolean;
  recordedSchedules?: ScheduleSnapshot[];
  schedules: ScheduleSnapshot[];
  /** v1.43 — the composition per unit, as the server delivered it. */
  ingredients?: MedicationIngredientDto[];
  /** v1.43 — the records this medication relates to (server-resolved). */
  related?: RelatedLink[];
}

/**
 * Whether the settings tab has anything for this viewer. In somebody else's
 * record its plan rows need the schedule (a managed profile's guardian,
 * #1408) or the supply (a MANAGE grant under `medications`); its period,
 * data and delete groups are the owner's.
 */
function offersSettings({
  inSharedRecord,
  runsSchedule,
  canManageMedications,
}: {
  inSharedRecord: boolean;
  runsSchedule: boolean;
  canManageMedications: boolean;
}): boolean {
  return !inSharedRecord || runsSchedule || canManageMedications;
}

export function MedicationDetailTabs({
  medication: served,
}: {
  medication: MedicationDetailSnapshot;
}) {
  // v1.39.1 (#1033) — a record-only medication arrives with `schedules: []`
  // and its stored schedule in `recordedSchedules`; this page reads and
  // edits the stored rows. Nothing here derives a due dose from them.
  const recordOnly = served.trackIntake === false;
  const medication = useMemo<MedicationDetailSnapshot>(
    () =>
      served.recordedSchedules
        ? { ...served, schedules: served.recordedSchedules }
        : served,
    [served],
  );
  const { t } = useTranslations();
  const recordCaps = useRecordCapabilities();
  const { canManageDomain, canWriteDomain, inSharedRecord } = recordCaps;
  const canManageMedications = canManageDomain("medications");
  const canRecord = canWriteDomain("medications");
  const runsSchedule = holdsGuardianSurfaces(recordCaps);
  const searchParams = useUrlSearch();
  const todayKey = useTodayKey();

  // `?edit=1` (the list's "Bearbeiten") opens the wizard on the first
  // render; the effect below strips it so a close + reload stays closed.
  const shouldOpenEditFromUrl = searchParams?.get("edit") === "1";
  const [editOpen, setEditOpen] = useState(shouldOpenEditFromUrl);
  const [endOpen, setEndOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [retargetOpen, setRetargetOpen] = useState(false);
  // Verlauf: the ledger covers a trailing 90-day window; "all" swaps in the
  // full paginated intake list so older doses stay reachable.
  const [historyView, setHistoryView] = useState<"recent" | "all">("recent");

  const id = medication.id;
  const oneShot = medication.oneShot === true;
  const asNeeded = medication.asNeeded === true;
  const isGlp1 = !oneShot && medication.treatmentClass === "GLP1";
  const { user: account } = useAuth();
  const nutrientsOn = account?.modules?.nutrients === true;
  const ingredients = medication.ingredients ?? [];
  const showComposition =
    nutrientsOn &&
    (COMPOSITION_CATEGORIES.has(medication.category) || ingredients.length > 0);
  const isInjectable = medication.deliveryForm === "INJECTION";

  // The effect tab and card appear only when the medication resolves to a
  // known outcome target and is not a single dose: the same resolver the
  // server's efficacy builder uses.
  const hasEfficacyTarget = useMemo(
    () =>
      !oneShot &&
      resolveMedicationTargets({
        name: medication.name,
        treatmentClass: medication.treatmentClass,
        atcCode: medication.atcCode,
      }) !== null,
    [oneShot, medication.name, medication.treatmentClass, medication.atcCode],
  );

  const payload = useMemo(
    () => snapshotToWizardPayload(medication),
    [medication],
  );

  const availableTabs = useMemo<TabSlug[]>(
    () =>
      TAB_SLUGS.filter(
        (slug) =>
          (slug !== "injection" || isInjectable) &&
          (slug !== "effect" || hasEfficacyTarget) &&
          (slug !== "settings" ||
            offersSettings({
              inSharedRecord,
              runsSchedule,
              canManageMedications,
            })),
      ),
    [
      isInjectable,
      hasEfficacyTarget,
      inSharedRecord,
      runsSchedule,
      canManageMedications,
    ],
  );

  const rawTab = searchParams?.get("tab");
  const activeTab = resolveTabSlug(rawTab, availableTabs);
  // An old supply link (the low-stock push) opens the supply sheet.
  const initialSheet =
    activeTab === "settings" &&
    rawTab &&
    Object.hasOwn(LEGACY_TAB_SHEETS, rawTab)
      ? LEGACY_TAB_SHEETS[rawTab]
      : null;
  const scrollActiveTabIntoRow = useCallback(
    (row: HTMLDivElement | null) => scrollActiveIntoRow(row, activeTab),
    [activeTab],
  );

  useEffect(() => {
    if (shouldOpenEditFromUrl) {
      writeUrlState((params) => params.delete("edit"), { afterPaint: true });
    }
  }, [shouldOpenEditFromUrl]);

  const onTabChange = useCallback((next: string) => {
    writeUrlState((params) => params.set("tab", next));
  }, []);

  const jumpTo = useCallback(
    (slug: TabSlug): (() => void) | undefined =>
      availableTabs.includes(slug) ? () => onTabChange(slug) : undefined,
    [availableTabs, onTabChange],
  );

  const { data: compliance } = useQuery<OverviewCompliance | null>({
    queryKey: queryKeys.medicationCompliance(id),
    queryFn: async () => {
      try {
        return await apiGet<OverviewCompliance>(
          `/api/medications/${id}/compliance`,
        );
      } catch {
        return null;
      }
    },
    // No compliance read for an as-needed medication: no rate to show.
    enabled: activeTab === "overview" && !asNeeded,
    staleTime: 30_000,
  });

  const efficacy = useQuery({
    queryKey: queryKeys.medicationEfficacy(id),
    queryFn: () =>
      apiGet<MedicationEfficacyDTO>(`/api/medications/${id}/efficacy`),
    enabled: activeTab === "overview" && hasEfficacyTarget,
    staleTime: 60_000,
  });
  const mayRetarget = useMayRetarget(efficacy.data?.overrideOptions);

  const ledger = useOverviewLedger(id);
  const todayDoses = useTodayDoses(id, activeTab === "overview");
  const schedulesForAdd = medication.schedules.map((s) => ({
    windowStart: s.windowStart,
    label: s.label,
    dose: s.dose,
    timesOfDay: s.timesOfDay,
  }));

  const pause = usePauseToggle({ medicationId: id, active: medication.active });
  const onEdit = canManageMedications ? () => setEditOpen(true) : undefined;
  const ownRecord = !inSharedRecord;

  const menu =
    onEdit || ownRecord ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            aria-label={t("medications.detail.menu.label")}
            data-slot="medication-detail-menu"
          >
            <MoreVertical aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onEdit && (
            <DropdownMenuItem
              onClick={onEdit}
              data-slot="medication-detail-menu-edit"
            >
              {t("common.edit")}
            </DropdownMenuItem>
          )}
          {ownRecord && (
            <DropdownMenuItem
              onClick={() => void pause.toggle(!pause.paused)}
              disabled={pause.busy}
              data-slot="medication-detail-menu-pause"
            >
              {pause.paused
                ? t("medications.detail.menu.resume")
                : t("medications.detail.zone.pause.title")}
            </DropdownMenuItem>
          )}
          {ownRecord && medication.canEndCourse === true && (
            <DropdownMenuItem
              onClick={() => setEndOpen(true)}
              data-slot="medication-detail-menu-end"
            >
              {t("medications.detail.zone.end.button")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const threeCards = hasEfficacyTarget;

  const historyToggle = (
    <div data-slot="chart-header-controls">
      <Segmented
        size="sm"
        mode="toggle"
        value={historyView}
        options={[
          {
            value: "recent",
            label: t("medications.detail.intake.viewRecentShort"),
          },
          {
            value: "all",
            label: t("medications.detail.intake.viewAllShort"),
          },
        ]}
        onChange={setHistoryView}
        label={t("medications.detail.intake.viewToggleLabel")}
        slot="medication-verlauf-view-toggle"
      />
    </div>
  );

  return (
    <div className="space-y-6" data-slot="medication-detail-page">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit" asChild>
        <Link href="/medications">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("nav.medications")}
        </Link>
      </Button>

      <MedicationDetailSummary
        name={medication.name}
        dose={formatDose(medication.dose, t)}
        active={medication.active}
        courseStatus={served.courseStatus}
        payload={payload}
        oneShot={oneShot}
        asNeeded={asNeeded}
        startsOn={medication.startsOn}
        recordOnly={recordOnly}
        menu={menu}
      />

      <Tabs
        value={activeTab}
        onValueChange={onTabChange}
        data-slot="medication-detail-tabs"
      >
        <TabsList
          // One row on a phone, scrolling sideways when a locale runs long.
          ref={scrollActiveTabIntoRow}
          className="scroll-touch w-full max-w-full justify-start overflow-x-auto"
          aria-label={t("medications.detail.shell.tablistLabel")}
        >
          {availableTabs.map((slug) => (
            <TabsTrigger
              key={slug}
              value={slug}
              data-slot={`medication-tab-${slug}`}
              className="flex-none max-sm:px-2"
            >
              {t(TAB_LABEL_KEYS[slug])}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ÜBERSICHT */}
        <TabsContent value="overview" className="space-y-6 pt-2">
          <div
            className={
              threeCards
                ? "grid gap-4 lg:grid-cols-3"
                : "grid gap-4 md:grid-cols-2"
            }
            data-slot="medication-overview-cards"
          >
            <TodayCard
              medication={medication}
              recordOnly={recordOnly}
              asNeeded={asNeeded}
              courseStatus={served.courseStatus}
              compliance={compliance}
              todayDoses={todayDoses}
              onBackfill={() => setAddOpen(true)}
              onHistory={jumpTo("history")}
            />
            <IntakeCard
              asNeeded={asNeeded}
              recordOnly={recordOnly}
              compliance={compliance}
              byDay={ledger.byDay}
              todayKey={todayKey}
              loading={ledger.isLoading}
              onBackfill={canRecord ? () => setAddOpen(true) : undefined}
              onHistory={jumpTo("history")}
            />
            {threeCards && (
              <EffectCard
                query={efficacy}
                mayRetarget={mayRetarget}
                onRetarget={() => setRetargetOpen(true)}
                onDetails={jumpTo("effect")}
              />
            )}
          </div>

          <PlanCard
            medication={medication}
            recordOnly={recordOnly}
            asNeeded={asNeeded}
            onEdit={onEdit}
          />

          {showComposition && (
            <CompositionSection
              medicationId={id}
              ingredients={ingredients}
              canEdit={canManageMedications}
              ownRecord={ownRecord}
            />
          )}

          <MedicationRelatedSection
            medicationId={medication.id}
            startsOn={medication.startsOn ?? null}
            related={medication.related}
          />
        </TabsContent>

        {/* WIRKUNG */}
        {hasEfficacyTarget && (
          <TabsContent value="effect" className="space-y-6 pt-2">
            <EfficacyTab
              medicationId={id}
              active={activeTab === "effect"}
              isGlp1={isGlp1}
              medicationName={medication.name}
              medicationDose={medication.dose}
            />
          </TabsContent>
        )}

        {/* VERLAUF — the dose history (90 days) or the full intake list. */}
        <TabsContent value="history" className="space-y-6 pt-2">
          <div className="space-y-6" data-slot="medication-verlauf-section">
            {historyView === "recent" ? (
              <DoseHistoryLedger
                medicationId={id}
                medicationName={medication.name}
                medicationDose={medication.dose}
                schedules={schedulesForAdd}
                controls={historyToggle}
              />
            ) : (
              <>
                <div className="flex justify-end">{historyToggle}</div>
                <IntakeHistoryListV2 medicationId={id} />
              </>
            )}
          </div>
        </TabsContent>

        {/* INJEKTION — injectable routes only. */}
        {isInjectable && (
          <TabsContent value="injection" className="space-y-6 pt-2">
            <TitrationTimeline medicationId={id} />
            {isGlp1 && <SideEffectsSection medicationId={id} />}
            {isGlp1 && (
              <div
                className="space-y-6"
                data-slot="injektion-drug-level-section"
              >
                <DrugLevelChart
                  medication={{
                    id: medication.id,
                    name: medication.name,
                    dose: medication.dose,
                  }}
                />
                <DoseStrengthCurve medicationId={id} />
              </div>
            )}
            {!isGlp1 && <DoseStrengthCurve medicationId={id} />}
          </TabsContent>
        )}

        {/* EINSTELLUNGEN */}
        <TabsContent value="settings" className="pt-2">
          <MedicationSettingsTab
            medication={medication}
            recordOnly={recordOnly}
            asNeeded={asNeeded}
            courseEnded={served.courseStatus === "ENDED"}
            showComposition={showComposition}
            initialSheet={initialSheet}
            onEdit={onEdit}
          />
        </TabsContent>
      </Tabs>

      {/* The structural editor. `PUT /api/medications/[id]` is not delegable,
          so the wizard (and `?edit=1`) is gated on MANAGE. */}
      <MedicationWizardDialog
        open={editOpen && canManageMedications}
        onOpenChange={setEditOpen}
        mode="edit"
        initial={payload}
        onSuccess={() => setEditOpen(false)}
      />

      {ownRecord && medication.canEndCourse === true && (
        <EndCourseDialog
          medicationId={id}
          medicationName={medication.name}
          open={endOpen}
          onOpenChange={setEndOpen}
        />
      )}

      {addOpen && (
        <LedgerAddDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          medicationId={id}
          medicationName={medication.name}
          medicationDose={medication.dose}
          schedules={schedulesForAdd}
          ledgerKey={queryKeys.medicationDoseHistory(id, GRID_DAYS)}
        />
      )}

      {mayRetarget && efficacy.data && (
        <RetargetSheet
          medicationId={id}
          options={efficacy.data.overrideOptions}
          isOverride={efficacy.data.resolution.tier === "override"}
          open={retargetOpen}
          onOpenChange={setRetargetOpen}
        />
      )}
    </div>
  );
}
