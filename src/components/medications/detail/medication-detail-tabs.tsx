"use client";

/**
 * v1.15.18 — medication detail full-page tabbed shell.
 *
 * Promotes the detail page from a read-only history view to the
 * canonical home for ONE medication. The modal `<AdvancedSettingsSheet>`
 * is dissolved into the Erweitert tab (no more five-card stack in a
 * sheet) and the separate `/history` route folds into the Verlauf tab
 * (the route now redirects to `?tab=verlauf`).
 *
 * Tab state lives in the URL (`?tab=<slug>`), so a tab is deep-linkable,
 * survives reload, and is reachable from the medications-list card kebab
 * (History→verlauf). The kebab's Edit arrives as `?edit=1`, which opens
 * the wizard in edit mode on top of the landing tab. Slugs are ASCII /
 * locale-independent; the visible labels are i18n.
 *
 * v1.15.20 — six tabs: the former Erinnerung tab dissolved into Zeitplan
 * (a "Erinnerung" card under the times editor owns the notifications
 * switch + the reminder grace), and Übersicht grew from a lone
 * compliance bar into the status landing surface (next due dose,
 * reminder state, supply runway — each with a jump link into its owner
 * tab). Stale `?tab=erinnerung` deep-links land on Zeitplan.
 *
 * Only the active tab body mounts (Radix `Tabs` default) so inactive tabs
 * do not fetch. The hero stays above the tabs as the always-visible
 * read-only summary plus the "Vollständig bearbeiten" jump into the
 * creation/edit wizard (the structural-edit tool — name / class /
 * cadence kind / schedules). Everyday levers (reminders, supply, history)
 * live inline in the tabs. Injektion is gated to injectable routes of
 * administration.
 */

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MedicationDetailSummary } from "@/components/medications/medication-detail-summary";
import { EfficacyTab } from "@/components/medications/detail/efficacy/efficacy-tab";
import { resolveMedicationTargets } from "@/lib/medications/med-target-map";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { MedicationComplianceBars } from "@/components/medications/card-parts/medication-compliance-bars";
import { DoseHistoryLedger } from "@/components/medications/dose-history-ledger";
import { IntakeHistoryListV2 } from "@/components/medications/intake-history-list-v2";
import { SegmentedToggle } from "@/components/medications/detail/segmented-toggle";
import { ScheduleTimesEditor } from "@/components/medications/scheduling/schedule-times-editor";
import { ScheduleHistoryTimeline } from "@/components/medications/scheduling/schedule-history-timeline";
import type { DoseWindowEntry } from "@/components/medications/scheduling/dose-window";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import { InventorySection } from "@/components/medications/sections/inventory-section";
import { NotificationsBody } from "@/components/medications/sections/notifications-section";
import {
  DrugCodingRow,
  GraceRow,
  PhasesRow,
} from "@/components/medications/sections/settings-section";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { DataPortabilityRow } from "@/components/medications/sections/data-portability-row";
import {
  DangerZoneBody,
  LifecycleManageBody,
} from "@/components/medications/sections/destructive-zone-section";
import { SettingsGroup } from "@/components/medications/settings-group";
import { PhaseConfigSheet } from "@/components/medications/sections/phase-config-sheet";
import { SideEffectsSection } from "@/components/medications/side-effects-section";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { TitrationTimeline } from "@/components/medications/titration-timeline";
import { estimateRunwayDays } from "@/components/medications/detail/supply-runway";
import type { SupplySummary } from "@/lib/medications/inventory/summary";
import { MedicationWizardDialog } from "@/components/medications/wizard/medication-wizard-dialog";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { formatUnitCount } from "@/components/medications/units-per-dose";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { formatDose } from "@/lib/medications/format-dose";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";

// v1.15.20 — Recharts stays out of the detail page's initial bundle:
// both chart bodies load through `next/dynamic` (client-only) with the
// shared chart skeleton standing in while the chunk streams.
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
  /**
   * v1.15.20 — server-computed next due instant (the detail GET carries
   * it alongside the row). The Übersicht status surface renders it
   * directly; no client-side recurrence walking.
   */
  nextDueAt?: string | null;
  /**
   * v1.37.19 — server-resolved slot-aware runway (days); null = inventory
   * tracking off or no consuming cadence. Preferred over the client
   * estimate; the estimate remains only as the stale-payload fallback.
   */
  runwayDays?: number | null;
  schedules: ScheduleSnapshot[];
}

// Slugs are ASCII / locale-independent so the URL stays stable across
// locales; the visible labels resolve through i18n. The list drives both
// the tab strip render and the `?tab=` round-trip validation.
const TAB_SLUGS = [
  "uebersicht",
  "wirkung",
  "zeitplan",
  "bestand",
  "verlauf",
  "injektion",
  "api",
  "erweitert",
] as const;
type TabSlug = (typeof TAB_SLUGS)[number];

/**
 * Tabs whose entire content is owner-only work: the schedule editor and its
 * plan history, the supply ledger, the external-token row, and the advanced
 * surface (wizard, import, pause, end, purge, delete). A delegation admits
 * none of it at any level.
 */
const OWNER_ONLY_TABS: ReadonlySet<TabSlug> = new Set([
  // Schedule times are a MANAGE route, but the tab also carries the reminder
  // and notification settings, which resolve the caller.
  "zeitplan",
  // Per-medication tokens: a credential surface, never delegated.
  "api",
  // Phase config, export and the token-adjacent rows resolve the caller.
  "erweitert",
]);

/**
 * v1.38.12 — tabs whose every write is a MANAGE route under `medications`,
 * so a grant that reaches those routes is shown the tab. The supply ledger
 * is one; the three above are not, because each mixes in a route that
 * resolves the caller and would 403 under a switch.
 */
const MANAGE_TABS: ReadonlySet<TabSlug> = new Set(["bestand"]);

/**
 * Legacy slugs that point at a dissolved tab. The Erinnerung tab folded
 * into Zeitplan in v1.15.20; old deep-links keep landing on the surface
 * that now owns the reminder controls instead of falling back to the
 * landing tab.
 */
const LEGACY_TAB_SLUGS: Record<string, TabSlug> = {
  erinnerung: "zeitplan",
};

function snapshotToWizardPayload(
  med: MedicationDetailSnapshot,
): MedicationPayload {
  return {
    id: med.id,
    name: med.name,
    dose: med.dose,
    category: med.category,
    treatmentClass: med.treatmentClass,
    deliveryForm: med.deliveryForm,
    dosesPerUnit: med.dosesPerUnit ?? null,
    unitsPerDose: med.unitsPerDose ?? 1,
    trackInjectionSites: med.trackInjectionSites ?? false,
    allowedInjectionSites: med.allowedInjectionSites ?? [],
    notificationsEnabled: med.notificationsEnabled,
    startsOn: med.startsOn ? new Date(med.startsOn) : null,
    endsOn: med.endsOn ? new Date(med.endsOn) : null,
    oneShot: med.oneShot ?? false,
    asNeeded: med.asNeeded ?? false,
    schedules: med.schedules.map((s) => ({
      id: s.id,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      label: s.label ?? null,
      dose: s.dose ?? null,
      ...parseScheduleRecurrence(s.daysOfWeek),
      timesOfDay: s.timesOfDay,
      rrule: s.rrule ?? null,
      rollingIntervalDays: s.rollingIntervalDays ?? null,
      doseWindows: s.doseWindows ?? null,
    })),
  };
}

export function MedicationDetailTabs({
  medication,
}: {
  medication: MedicationDetailSnapshot;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  const canManageMedications = canManageDomain("medications");
  const router = useRouter();
  const searchParams = useSearchParams();

  // v1.15.20 — the medications-list kebab's "Bearbeiten" arrives as
  // `?edit=1` and opens the wizard straight away (the same editOpen the
  // hero button drives). Read synchronously so the wizard mounts open on
  // the first render; the effect below strips the param so a close +
  // reload stays closed.
  const shouldOpenEditFromUrl = searchParams?.get("edit") === "1";
  const [editOpen, setEditOpen] = useState(shouldOpenEditFromUrl);
  const [importOpen, setImportOpen] = useState(false);
  const [phaseSheetOpen, setPhaseSheetOpen] = useState(false);
  // Verlauf tab: the schedule-expanded ledger covers only a trailing 90-day
  // window; "all" swaps in the full paginated intake history so older doses
  // stay reachable.
  const [historyView, setHistoryView] = useState<"recent" | "all">("recent");

  const id = medication.id;
  const oneShot = medication.oneShot === true;
  const asNeeded = medication.asNeeded === true;
  const isGlp1 = !oneShot && medication.treatmentClass === "GLP1";
  const isInjectable = medication.deliveryForm === "INJECTION";

  // v1.28 — the "Wirkung" tab appears only when the medication resolves to a
  // known outcome target (ATC class prefix → whole-word name inference) and is
  // not a single-dose med. Same pure resolver the server efficacy builder's
  // derived tier uses, so the tab's presence agrees with the DTO's eligibility.
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

  // Only the active tab body mounts, but the tab REGISTRY must agree with
  // whatever `?tab=` carries — Injektion is absent for non-injectable
  // medications, so a stale `?tab=injektion` deep-link falls back to the
  // landing tab instead of rendering an empty surface.
  // v1.16.11 — an as-needed medication has no schedule and never
  // reminds, so the Zeitplan tab (times editor + reminder card +
  // plan-history) does not apply and is dropped from the registry; a
  // stale `?tab=zeitplan` deep-link falls back to the landing tab.
  // v1.36.x — four tabs are nothing BUT owner work: the schedule editor, the
  // supply ledger, the external-token row and the advanced surface that holds
  // the wizard, the import and the destructive zone. None of it is delegated,
  // so inside somebody else's record they leave the registry entirely rather
  // than opening onto controls the server refuses — which also means a stale
  // `?tab=erweitert` deep link lands on the landing tab, the same way an
  // inapplicable tab already does.
  const availableTabs = useMemo<TabSlug[]>(
    () =>
      TAB_SLUGS.filter(
        (slug) =>
          (slug !== "injektion" || isInjectable) &&
          (slug !== "zeitplan" || !asNeeded) &&
          (slug !== "wirkung" || hasEfficacyTarget) &&
          (!inSharedRecord || !OWNER_ONLY_TABS.has(slug)) &&
          (canManageMedications || !MANAGE_TABS.has(slug)),
      ),
    [
      isInjectable,
      asNeeded,
      hasEfficacyTarget,
      inSharedRecord,
      canManageMedications,
    ],
  );

  const requestedRaw = searchParams?.get("tab");
  const requested = (
    requestedRaw && requestedRaw in LEGACY_TAB_SLUGS
      ? LEGACY_TAB_SLUGS[requestedRaw]
      : requestedRaw
  ) as TabSlug | null;
  const activeTab: TabSlug =
    requested && availableTabs.includes(requested) ? requested : "uebersicht";

  useEffect(() => {
    if (shouldOpenEditFromUrl) {
      // Drop `?edit=1` (keep any `tab` param) so a refresh after closing
      // the wizard does not keep reopening it.
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.delete("edit");
      const qs = params.toString();
      router.replace(`/medications/${id}${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });
    }
  }, [shouldOpenEditFromUrl, id, router, searchParams]);

  const onTabChange = useCallback(
    (next: string) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.set("tab", next);
      // Shallow URL swap so the tab is deep-linkable + survives reload
      // without a full navigation. `scroll: false` keeps the viewport
      // pinned to the tab strip on switch.
      router.replace(`/medications/${id}?${params.toString()}`, {
        scroll: false,
      });
    },
    [id, router, searchParams],
  );

  const { data: compliance } = useQuery({
    queryKey: queryKeys.medicationCompliance(id),
    queryFn: async () => {
      try {
        return await apiGet<{
          compliance7?: { rate: number; streak: number };
          compliance30?: { rate: number };
          complianceDisplay?: ComplianceDisplay;
        }>(`/api/medications/${id}/compliance`);
      } catch {
        return null;
      }
    },
    // v1.16.11 — no compliance read for an as-needed medication (the
    // section is hidden; there is no rate to fetch).
    enabled: activeTab === "uebersicht" && !asNeeded,
    staleTime: 30_000,
  });

  const display = compliance?.complianceDisplay;
  const rate7 = display?.short.rate ?? compliance?.compliance7?.rate ?? 0;
  const rate30 = display?.long.rate ?? compliance?.compliance30?.rate ?? 0;
  const streak = display?.short.streak ?? compliance?.compliance7?.streak ?? 0;
  const shortDays = display?.shortDays ?? 7;
  const longDays = display?.longDays ?? 30;

  // v1.15.20 — supply readout for the Übersicht status surface. Same
  // query key the Bestand tab uses, so the two tabs share one cache slot
  // and the row only renders when the user has actually registered
  // supply items.
  const { data: inventory } = useQuery({
    queryKey: queryKeys.medicationInventory(id),
    queryFn: async () => {
      try {
        return await apiGet<{
          items: Array<{
            state: "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";
          }>;
          summary?: SupplySummary;
        } | null>(`/api/medications/${id}/inventory`);
      } catch {
        return null;
      }
    },
    enabled: activeTab === "uebersicht",
    staleTime: 30_000,
  });

  const inventoryItems = Array.isArray(inventory?.items) ? inventory.items : [];
  // v1.19.0 (iOS#25) — the supply headline is server-authoritative: the
  // GET response carries a `summary` computed server-side through the
  // shared `summariseSupply` helper (ACTIVE / IN_USE with units only —
  // the list / GLP-1 semantic; EXPIRED surfaced separately, never
  // available; dose-derived counts floored over the pooled units). The
  // Übersicht status row renders these ready figures, so web and iOS read
  // identical numbers from the same DTO. The runway estimate is a UI
  // projection over the canonical `dosesRemaining`.
  const {
    unitsRemaining,
    unitsTotal,
    dosesRemaining,
    dosesTotal,
    expiredUnits,
  } = inventory?.summary ?? {
    unitsRemaining: 0,
    unitsTotal: 0,
    dosesRemaining: 0,
    dosesTotal: 0,
    expiredUnits: 0,
  };
  // v1.16.12 — fractional unitsPerDose (½ tablet per dose) drives the
  // "show the raw unit tally" toggle below; the canonical figures above
  // already account for it server-side.
  const perDose =
    medication.unitsPerDose && medication.unitsPerDose > 0
      ? medication.unitsPerDose
      : 1;
  // v1.37.19 — prefer the server's slot-aware runway from the detail GET.
  const runwayDays =
    medication.runwayDays !== undefined
      ? medication.runwayDays
      : estimateRunwayDays(dosesRemaining, medication.schedules);

  return (
    <div className="space-y-6" data-slot="medication-detail-page">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit" asChild>
        <Link href="/medications">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("medications.back")}
        </Link>
      </Button>

      {/* HERO — always-visible read-only summary. The structural edit
          (wizard) moved out of the header: it lives as a row under
          Erweitert → Lebenszyklus (the header button read as "edit this
          page" and misled). `?edit=1` still opens the wizard directly. */}
      <MedicationDetailSummary
        name={medication.name}
        dose={formatDose(medication.dose, t)}
        active={medication.active}
        endsOn={medication.endsOn}
        payload={payload}
        oneShot={oneShot}
        asNeeded={asNeeded}
        startsOn={medication.startsOn}
      />

      <Tabs
        value={activeTab}
        onValueChange={onTabChange}
        data-slot="medication-detail-tabs"
      >
        <TabsList
          className="w-full justify-start"
          aria-label={t("medications.detail.shell.tablistLabel")}
        >
          {availableTabs.map((slug) => (
            <TabsTrigger
              key={slug}
              value={slug}
              data-slot={`medication-tab-${slug}`}
            >
              {t(`medications.detail.tabs.${slug}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ÜBERSICHT — the status landing surface: next due dose,
            reminder state and supply runway (each with a jump link into
            its owner tab), then the compliance readout. All values come
            from data the page already holds — no new endpoints. */}
        <TabsContent value="uebersicht" className="space-y-6 pt-2">
          <MedicationDetailSection
            titleId="medication-uebersicht-status-heading"
            title={t("medications.detail.uebersicht.statusTitle")}
            dataSlot="medication-uebersicht-status"
          >
            <ul className="divide-border/60 divide-y">
              <StatusRow
                label={t("medications.detail.uebersicht.nextDoseLabel")}
                value={
                  !medication.active
                    ? t("medications.detail.uebersicht.pausedHint")
                    : asNeeded
                      ? t("medications.detail.uebersicht.nextDoseAsNeeded")
                      : medication.nextDueAt
                        ? fmt.dateTime(medication.nextDueAt)
                        : t("medications.detail.uebersicht.nextDoseNone")
                }
                jumpLabel={
                  asNeeded
                    ? t("medications.detail.uebersicht.jumpToVerlauf")
                    : t("medications.detail.uebersicht.jumpToZeitplan")
                }
                onJump={() => onTabChange(asNeeded ? "verlauf" : "zeitplan")}
                dataSlot="uebersicht-next-dose"
              />
              {/* v1.16.11 — as-needed never reminds; the row would only
                  mislead (the cron skips schedule-less medications). */}
              {!asNeeded && (
                <StatusRow
                  label={t("medications.detail.uebersicht.reminderLabel")}
                  value={
                    medication.notificationsEnabled
                      ? t("medications.detail.uebersicht.reminderOn")
                      : t("medications.detail.uebersicht.reminderOff")
                  }
                  jumpLabel={t("medications.detail.uebersicht.jumpToZeitplan")}
                  onJump={() => onTabChange("zeitplan")}
                  dataSlot="uebersicht-reminder"
                />
              )}
              {inventoryItems.length > 0 && (
                <StatusRow
                  label={t("medications.detail.uebersicht.supplyLabel")}
                  value={
                    <>
                      {t("medications.detail.bestand.summary", {
                        remaining: dosesRemaining,
                        total: dosesTotal,
                      })}
                      {perDose !== 1 && (
                        <span className="text-muted-foreground">
                          {" ("}
                          {t("medications.detail.bestand.unitsDetail", {
                            remaining: formatUnitCount(unitsRemaining),
                            total: formatUnitCount(unitsTotal),
                          })}
                          {")"}
                        </span>
                      )}
                      {expiredUnits > 0 && (
                        <span className="text-muted-foreground">
                          {" · "}
                          {t("medications.detail.bestand.expiredSuffix", {
                            units: expiredUnits,
                          })}
                        </span>
                      )}
                      {runwayDays !== null && (
                        <span className="text-muted-foreground">
                          {" · "}
                          {t("medications.detail.uebersicht.supplyRunway", {
                            days: runwayDays,
                          })}
                        </span>
                      )}
                    </>
                  }
                  jumpLabel={t("medications.detail.uebersicht.jumpToBestand")}
                  onJump={() => onTabChange("bestand")}
                  dataSlot="uebersicht-supply"
                />
              )}
            </ul>
          </MedicationDetailSection>

          {!asNeeded && (
            <MedicationDetailSection
              titleId="medication-uebersicht-compliance-heading"
              title={t("medications.detail.uebersicht.complianceTitle")}
              dataSlot="medication-uebersicht-compliance"
            >
              {compliance ? (
                <MedicationComplianceBars
                  rate7={rate7}
                  rate30={rate30}
                  streak={streak}
                  shortDays={shortDays}
                  longDays={longDays}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("medications.detail.uebersicht.complianceEmpty")}
                </p>
              )}
            </MedicationDetailSection>
          )}
        </TabsContent>

        {/* WIRKUNG — the per-medication efficacy view: the outcome metric(s)/
            lab(s) the drug's class targets, over the span around its start,
            with a before/after comparison + adherence lane. Strictly
            descriptive; hidden for one-shot + no-target medications. */}
        {hasEfficacyTarget && (
          <TabsContent value="wirkung" className="space-y-6 pt-2">
            <EfficacyTab
              medicationId={id}
              active={activeTab === "wirkung"}
              isGlp1={isGlp1}
              medicationName={medication.name}
              medicationDose={medication.dose}
            />
          </TabsContent>
        )}

        {/* ZEITPLAN — inline edit of the everyday levers: dose times +
            each dose's on-time window, then the Erinnerung card (the
            notifications switch + the reminder grace, folded in from the
            dissolved Erinnerung tab). Cadence-kind stays structural (the
            hero's "Vollständig bearbeiten"). */}
        <TabsContent value="zeitplan" className="space-y-6 pt-2">
          {medication.schedules.length > 0 ? (
            <MedicationDetailSection
              titleId="medication-zeitplan-times-heading"
              title={t("medications.detail.zeitplan.title")}
              dataSlot="medication-zeitplan-section"
            >
              <ScheduleTimesEditor
                medicationId={id}
                schedules={medication.schedules.map((s) => ({
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
                }))}
              />
            </MedicationDetailSection>
          ) : null}

          <MedicationDetailSection
            titleId="medication-zeitplan-reminder-heading"
            title={t("medications.detail.zeitplan.reminderTitle")}
            dataSlot="medication-zeitplan-reminder"
          >
            <div className="space-y-4">
              <NotificationsBody
                medicationId={id}
                notificationsEnabled={medication.notificationsEnabled}
              />
              <GraceRow
                medicationId={id}
                schedules={medication.schedules.map((s) => ({
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
                }))}
              />
              {/* Quiet cross-link: WHICH channels deliver the reminder
                  (push / Telegram / ntfy, quiet hours) is configured
                  globally, not per medication. */}
              <p className="text-muted-foreground text-xs">
                <Link
                  href="/settings/notifications"
                  className="focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
                  data-slot="zeitplan-manage-channels-link"
                >
                  {t("medications.detail.zeitplan.manageChannels")}
                </Link>
              </p>
            </div>
          </MedicationDetailSection>

          {/* PLANHISTORIE — archived schedule eras (v1.16.3 effective
              dating) as a quiet collapsible timeline, plus the manual
              pre-tracking-era flow. Read-only for write-path archives. */}
          <MedicationDetailSection
            titleId="medication-zeitplan-history-heading"
            title={t("medications.detail.zeitplan.history.title")}
            dataSlot="medication-zeitplan-history"
          >
            <ScheduleHistoryTimeline
              medicationId={id}
              currentTimes={medication.schedules.flatMap((s) =>
                s.timesOfDay && s.timesOfDay.length > 0
                  ? s.timesOfDay
                  : [s.windowStart],
              )}
            />
          </MedicationDetailSection>
        </TabsContent>

        {/* BESTAND — inventory readout + register / correct flows. */}
        <TabsContent value="bestand" className="space-y-4 pt-2">
          <InventorySection
            medicationId={id}
            dosesPerUnit={medication.dosesPerUnit}
            unitsPerDose={medication.unitsPerDose}
            deliveryForm={medication.deliveryForm}
          />
        </TabsContent>

        {/* VERLAUF — the dose-history ledger: every expected slot with its
            status + ad-hoc takes tagged, inline Genommen with instant
            optimistic recompute, edit/add (incl. the late-take "diesem
            Slot zuordnen?" nudge). CSV import lives under Erweitert →
            Daten (the DataPortabilityRow), not in this header. */}
        <TabsContent value="verlauf" className="space-y-6 pt-2">
          <div className="flex justify-end">
            <SegmentedToggle
              value={historyView}
              options={[
                {
                  value: "recent",
                  label: t("medications.detail.intake.viewRecent90"),
                },
                {
                  value: "all",
                  label: t("medications.detail.intake.viewAll"),
                },
              ]}
              onChange={setHistoryView}
              ariaLabel={t("medications.detail.intake.viewToggleLabel")}
              dataSlot="medication-verlauf-view-toggle"
            />
          </div>
          {historyView === "recent" ? (
            <MedicationDetailSection
              titleId="medication-verlauf-heading"
              title={t("medications.detail.intake.title")}
              dataSlot="medication-verlauf-section"
            >
              <DoseHistoryLedger
                medicationId={id}
                medicationName={medication.name}
                schedules={medication.schedules.map((s) => ({
                  windowStart: s.windowStart,
                  label: s.label,
                  dose: s.dose,
                  timesOfDay: s.timesOfDay,
                }))}
              />
            </MedicationDetailSection>
          ) : (
            <IntakeHistoryListV2 medicationId={id} />
          )}
        </TabsContent>

        {/* INJEKTION — injectable routes only. Current GLP-1 charts +
            side-effect log; the body-map + adherence detail land next
            wave. */}
        {isInjectable && (
          <TabsContent value="injektion" className="space-y-6 pt-2">
            {/* Dose-escalation plan: completed + planned titration steps
                with a "you are here" marker. Renders for every injectable
                route (not GLP-1-only) since titration is a property of the
                injection ladder, not the treatment class. */}
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

        {/* API — the external-ingest surface in its own tab: per-medication
            tokens + the drug-coding identifiers external systems key on.
            Pulled out of Erweitert so the destructive zone and the token
            management stop sharing one surface. */}
        <TabsContent value="api" className="space-y-4 pt-2">
          <SettingsGroup
            label={t("medications.detail.erweitert.group.externalApi")}
            dataSlot="api-group-external-api"
          >
            <div className="py-3">
              <ApiTokensRow
                medicationId={id}
                medicationName={medication.name}
              />
            </div>
            <div className="py-3">
              <DrugCodingRow
                medicationId={id}
                atcCode={medication.atcCode}
                rxNormCode={medication.rxNormCode}
              />
            </div>
          </SettingsGroup>
        </TabsContent>

        {/* ERWEITERT — Lifecycle → Daten → Gefahrenzone. The external-API
            group moved to its own API tab. */}
        <TabsContent value="erweitert" className="space-y-4 pt-2">
          <SettingsGroup
            label={t("medications.detail.erweitert.group.lifecycle")}
            dataSlot="erweitert-group-lifecycle"
            collapsible
            defaultOpen={false}
          >
            <div className="py-3">
              <LifecycleManageBody
                medicationId={id}
                medicationName={medication.name}
                active={medication.active}
              />
            </div>
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
                onClick={() => setEditOpen(true)}
                className="min-h-11 shrink-0 sm:min-h-9"
                data-slot="medication-detail-full-edit"
              >
                <Pencil aria-hidden="true" className="h-4 w-4" />
                {t("medications.detail.erweitert.editor.button")}
              </Button>
            </div>
            {isGlp1 && (
              <div className="py-3">
                <PhasesRow
                  medicationId={id}
                  treatmentClass={medication.treatmentClass}
                  startsOn={medication.startsOn}
                  endsOn={medication.endsOn}
                  onRequestPhaseSheet={() => setPhaseSheetOpen(true)}
                />
              </div>
            )}
          </SettingsGroup>

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
        </TabsContent>
      </Tabs>

      {/* Structural edit — the wizard stays the name / class / cadence-kind
          / schedule tool. Hydrates from the medication payload in edit
          mode; closing it leaves the user on the same tab. */}
      {/* v1.36.x — `?edit=1` opens this wizard straight from the list kebab.
          Correcting an existing medication is refused at both grant levels
          (`PUT /api/medications/[id]` is not delegable), so the deep link is
          gated exactly like the hero button it stands in for. */}
      <MedicationWizardDialog
        open={editOpen && canManageMedications}
        onOpenChange={setEditOpen}
        mode="edit"
        initial={payload}
        onSuccess={() => setEditOpen(false)}
      />

      {/* GLP-1 phase/titration editor — sibling-swapped from the Lifecycle
          group so the modal stack never exceeds the tab + one sheet. */}
      {isGlp1 && (
        <PhaseConfigSheet
          medicationId={id}
          open={phaseSheetOpen}
          onOpenChange={setPhaseSheetOpen}
        />
      )}
    </div>
  );
}

/**
 * One Übersicht status row: label + value on the left, a quiet jump link
 * into the owning tab on the right. The link is a button (the tab switch
 * is shallow URL state, not a navigation) styled as an inline text link.
 */
function StatusRow({
  label,
  value,
  jumpLabel,
  onJump,
  dataSlot,
}: {
  label: string;
  value: ReactNode;
  jumpLabel: string;
  onJump: () => void;
  dataSlot: string;
}) {
  return (
    <li
      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
      data-slot={dataSlot}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <p className="text-foreground text-sm">{value}</p>
      </div>
      <button
        type="button"
        onClick={onJump}
        className="text-primary focus-visible:ring-ring shrink-0 rounded-sm text-xs underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        data-slot={`${dataSlot}-jump`}
      >
        {jumpLabel}
      </button>
    </li>
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
    // v1.16.1 — same neutral card chrome as every other group; only the
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
