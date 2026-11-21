"use client";

import {
  currentCourseNumber,
  type MedicationCourseFields,
} from "@/components/medications/course-fields";
import { useEffect, useReducer, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { showErrorToast } from "@/lib/errors/error-toast";

import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationCardBody } from "@/components/medications/card-parts/medication-card-body";
import { DoseStateLabel } from "@/components/medications/dose-state-label";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import { useCardDoseSnooze } from "@/components/medications/card-parts/use-dose-snooze";
import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import {
  useTranslations,
  useFormatters,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { formatDateTime, formatTime } from "@/lib/format";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import { formatDose } from "@/lib/medications/format-dose";
import { formatUnitsPerDose } from "@/lib/medications/units-per-dose";
import { getDayOfWeekInTz } from "@/lib/tz/local-day";
import { type InjectionSiteKey } from "@/lib/medications/injection-sites";
import { LogInjectionSiteDialog } from "@/components/medications/log-injection-site-dialog";
import { useGlobalExcludedInjectionSites } from "@/lib/medications/use-injection-site-prefs";
import {
  cardDisplayedSlot,
  cardDoseStatus,
  cardWindowPill,
} from "@/lib/medications/dose-state/pill";
import {
  estimateDailyDoseCount,
  estimateRunwayDays,
  lowStockTriggerDays,
} from "@/lib/medications/supply-runway";
import { useAuth } from "@/hooks/use-auth";
import { useMedicationComplianceSummary } from "@/lib/queries/use-medication-compliance-summary";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * v1.4.25 — GLP-1 medication card variant.
 *
 * Maintainer directive 2026-05-14: NO chart on the medication card. The card
 * stays text-rich (drug name + current dose, last/next injection,
 * injection-site rotation hint, side-effect quick-log). v1.4.28
 * retired the inline dose-history disclosure and the inventory
 * surface. Chart-only surfaces are the Dashboard tile + Insights
 * /medikamente sub-page.
 *
 * Renders inside the standard medications grid alongside generic
 * medication cards; visually mirrors `medication-card.tsx` so the page
 * stays harmonious — same Card shell, same header layout, same
 * compliance bars, same primary "Taken / Skipped" actions. The
 * GLP-1-specific rows sit between the dose line and the compliance
 * bars so the user reads top-down: drug → injection state → adherence.
 */

interface ScheduleLite {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  /** First-class dose times and explicit per-dose bands (schedule editor). */
  timesOfDay?: string[];
  doseWindows?: { timeOfDay: string; start: string; end: string }[] | null;
  /** Cadence fields the supply-runway estimate reads (v1.16.11). */
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  /** #219 — per-schedule units consumed per dose. NULL inherits the med level. */
  unitsPerDose?: number | null;
}

interface DoseChangeLite {
  id: string;
  effectiveFrom: string;
  doseValue: number;
  doseUnit: string;
  note: string | null;
}

interface IntakeLite {
  takenAt: string | null;
  injectionSite: InjectionSiteKey | null;
}

export interface Glp1Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  /** v1.40 — the label of a custom category; null for a built-in one. */
  categoryLabel?: string | null;
  treatmentClass?: string;
  dosesPerUnit?: number | null;
  /** v1.6.0 — route of administration (drives the injection-site prompt). */
  deliveryForm?: string;
  /** v1.8.5 — per-medication injection-site tracking opt-in. */
  trackInjectionSites?: boolean;
  /** v1.8.5 — per-medication allowed / preferred injection sites. */
  allowedInjectionSites?: string[];
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  todayEventCount?: number;
  /** #1371 — the person's own note, shown above the dose actions. */
  note?: string | null;
  /**
   * v1.8.4 — server-computed next due instant from `GET /api/medications`
   * (the canonical recurrence engine anchored on the last intake). The card
   * renders this directly so a rolling GLP-1 with an interval other than the
   * weekly default re-anchors correctly; the old client-side predictor only
   * walked a single hardcoded weekly day-of-week.
   */
  nextDueAt?: string | null;
  /**
   * v1.16.4 — true when `nextDueAt` is an OPEN overdue slot (anchor
   * passed, "now" still inside its catch-up band, unresolved). The card
   * renders it as "overdue — still takeable" instead of a future date.
   */
  nextDueOverdue?: boolean;
  /** v1.16.10 — dose-derived stock from the list payload; null = inventory tracking off. */
  stockDosesRemaining?: number | null;
  /** v1.37.19 — server-resolved slot-aware runway (days); null = off/no cadence. */
  runwayDays?: number | null;
  /** v1.17.0 — per-medication reorder lead override (days); null = inherit the user default. */
  reorderLeadDays?: number | null;
  /**
   * v1.39.1 (#1033) — false keeps the medication as a record: the list
   * serves `schedules: []` and nothing is due, so the card drops the
   * compliance bars and the take / skip actions and shows a badge instead.
   */
  trackIntake?: boolean;
  /** v1.42.2 — doses recorded automatically. */
  autoMarkTaken?: boolean;
  /**
   * v1.39.4 (#1040) — server-resolved: taken / skip are offered today only
   * when true (active, tracked, and the course includes today).
   */
  intakeActionable?: boolean;
  /** v1.39.4 (#1040) — where today sits in the course. */
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED";
  /** v1.40 (#1024) — the server-resolved course fields. */
  courses?: MedicationCourseFields["courses"];
  courseCount?: number;
  previousCourseEndedOn?: string | null;
  canStartCourse?: boolean;
  schedules: ScheduleLite[];
}

interface DetailsResponse {
  doseChanges: DoseChangeLite[];
  recentIntakes: IntakeLite[];
  inventory: {
    pensRemaining: number | null;
    dosesRemaining: number | null;
    weeksOfSupply: number | null;
    lowStock: boolean;
  } | null;
}

interface Glp1MedicationCardProps {
  medication: Glp1Medication;
  onEdit: (med: Glp1Medication) => void;
  /**
   * v1.15.18 — navigates to the medication detail page's Verlauf tab
   * (`/medications/{id}?tab=history`), mirroring the generic medication
   * card. The parent owns the navigation.
   */
  onOpenHistory: (med: Glp1Medication) => void;
  /**
   * v1.29.x — briefly ringed when this card is the Today digest's "Log
   * dose" deep-link target (`/medications?highlight=<id>`).
   */
  highlighted?: boolean;
}

function diffDays(target: Date, from: Date): number {
  const ms =
    Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) -
    Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/**
 * v1.8.4 — the next injection instant now comes from the server's
 * `nextDueAt` (the canonical recurrence engine, anchored on the last
 * intake). The legacy client-side predictor only handled a single
 * hardcoded weekly day-of-week and re-anchored at +7 days, so a rolling
 * GLP-1 with a non-weekly interval rendered the wrong date and never
 * advanced after an injection.
 */
function nextInjectionFromServer(
  nextDueAt: string | null | undefined,
  now: Date,
): { date: Date; daysAway: number } | null {
  if (!nextDueAt) return null;
  const date = new Date(nextDueAt);
  if (Number.isNaN(date.getTime())) return null;
  return { date, daysAway: Math.max(0, diffDays(date, now)) };
}

export function Glp1MedicationCard({
  medication,
  onEdit,
  onOpenHistory,
  highlighted = false,
}: Glp1MedicationCardProps) {
  const queryClient = useQueryClient();
  const { t, locale } = useTranslations();
  // v1.16.9 — the card reasons in the PROFILE timezone; Berlin stays the
  // last-resort fallback for logged-out mounts and legacy fixtures.
  const { user } = useAuth();
  const userTz = user?.timezone || DEFAULT_TIMEZONE;
  const fmt = useFormatters();
  // Issue #490 — the zone `fmt` renders dates in (mirror → Berlin). The
  // weekday name paired with `fmt.dateShort` must be derived in this SAME
  // zone: `Date.getDay()` reads the BROWSER zone and could name a weekday
  // that contradicts the date printed next to it.
  const displayTz = useDisplayTimezone();
  const weekdayLabel = useWeekdayLabel();
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  // v1.8.5 — post-dose injection-site prompt (see medication-card.tsx).
  const [siteIntakeId, setSiteIntakeId] = useState<string | null>(null);
  const globalExcluded = useGlobalExcludedInjectionSites();
  const tracksInjection =
    medication.deliveryForm === "INJECTION" &&
    medication.trackInjectionSites === true;

  // Take / skip / Undo and the snooze come from the hooks the generic card
  // uses; the card keeps its post-success injection-site prompt.
  const snooze = useCardDoseSnooze(medication);
  const { intakeLoading, recordIntake } = useMedicationIntake({
    medication,
    onRecorded: (eventId, skipped) => {
      if (!skipped && tracksInjection && eventId) {
        setSiteIntakeId(eventId);
      }
    },
  });

  // v1.16.8 — same batched compliance source as the generic card: one
  // `GET /api/medications/compliance` round trip shared by every card on
  // the page (the per-id endpoint stays for the detail page's heatmap).
  // `isError` swaps the compliance slot to the quiet retry fallback so a
  // failed batch read never leaves the card on a permanent skeleton.
  const {
    data: compliance,
    isError: complianceError,
    refetch: refetchCompliance,
  } = useMedicationComplianceSummary(medication.id);

  // The generic card's reminder thresholds, so the pill tiers identically.
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lowStockRunwayDays: number | null;
          reorderLeadDays?: number;
        }>("/api/settings/reminder-thresholds");
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  // Pull GLP-1-specific extras (dose history + recent injection sites +
  // pen inventory). Lives behind a dedicated endpoint so the standard
  // medications grid loads in parallel without paying for it.
  const { data: details } = useQuery({
    queryKey: queryKeys.medicationGlp1Details(medication.id),
    queryFn: async () => {
      try {
        return await apiGet<DetailsResponse>(
          `/api/medications/${medication.id}/glp1`,
        );
      } catch {
        return null;
      }
    },
    staleTime: 60 * 1000,
  });

  // Re-render once a minute so the in-window / overdue pill tracks
  // wall-clock progress without a route reload — mirrors the generic
  // medication card's tick cadence.
  useEffect(() => {
    const interval = setInterval(forceUpdate, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function confirmInjectionSite(site: InjectionSiteKey) {
    const intakeId = siteIntakeId;
    if (!intakeId) return;
    // v1.11.5 — keep the dialog open until the PATCH resolves. On failure
    // surface a toast and re-throw so the dialog stays mounted with the
    // chosen site instead of dismissing as though the site had been saved.
    try {
      await apiPost("/api/medications/intake", {
        intakeId,
        status: "taken",
        injectionSite: site,
      });
    } catch (err) {
      showErrorToast(t("medications.logInjectionSiteSaveFailed"), {
        cause: err,
      });
      throw err;
    }
    await invalidateKeys(queryClient, medicationDependentKeys);
    setSiteIntakeId(null);
  }

  const schedule = medication.schedules[0] ?? null;
  const now = new Date();
  const next = nextInjectionFromServer(medication.nextDueAt, now);
  // v1.8.6 — the two compliance windows scale with the dosing cadence. When
  // the server supplies `complianceDisplay` the card reads its cadence-scaled
  // rows; otherwise it falls back to the static 7-/30-day fields.
  const complianceNotApplicable = compliance?.applicable === false;
  const display = compliance?.complianceDisplay ?? undefined;
  const shortDays = display?.shortDays ?? 7;
  const longDays = display?.longDays ?? 30;
  const rate7 = display?.short.rate ?? compliance?.compliance7?.rate ?? 0;
  const rate30 = display?.long.rate ?? compliance?.compliance30?.rate ?? 0;
  const streak = display?.short.streak ?? compliance?.compliance7?.streak ?? 0;
  // v1.15.9 — the open dose's server-derived status drives the green
  // take-window highlight + the overdue / heavily-overdue top line, shared
  // verbatim with the generic card. Defaults to "upcoming" (calm).
  const currentDose = display?.currentDose;
  const doseStatus = cardDoseStatus(currentDose, now);
  const pill = cardWindowPill(currentDose, now, userTz);

  // The slot of the injection this card shows (the resolved open dose
  // while due, overdue or missed, else the server's next-due), threaded onto
  // the take / skip POST so the server records THIS dose.
  const displayedSlot = cardDisplayedSlot(
    currentDose,
    medication.nextDueAt,
    now,
  );

  // v1.16.11 / v1.17.0 — low-stock card context, identical to the generic
  // card: runway days from the list payload's dose-derived stock, surfaced
  // ONLY at runway ≤ the reorder-lead-aware trigger
  // (max(lowStockRunwayDays, lead + cadenceIntervalDays)), so the weekly
  // GLP-1 cadence is warned before its last dose. Stock 0 with a consuming
  // schedule is runway 0 (mirrors `evaluateMedicationRunway`).
  const lowStockFloor = thresholds == null ? 7 : thresholds.lowStockRunwayDays;
  const leadDays =
    medication.reorderLeadDays != null
      ? medication.reorderLeadDays
      : (thresholds?.reorderLeadDays ?? 10);
  // v1.37.19 — prefer the server's slot-aware `runwayDays`; client
  // estimate only as the stale-payload fallback.
  const stockRunwayDays =
    medication.stockDosesRemaining == null
      ? null
      : medication.runwayDays !== undefined
        ? medication.runwayDays
        : medication.stockDosesRemaining > 0
          ? estimateRunwayDays(
              medication.stockDosesRemaining,
              medication.schedules,
            )
          : estimateDailyDoseCount(medication.schedules) > 0
            ? 0
            : null;
  const lowStockTrigger =
    lowStockFloor === null
      ? null
      : lowStockTriggerDays({
          lowStockRunwayDays: lowStockFloor,
          leadDays,
          schedules: medication.schedules,
        });
  const lowStockRunwayDays =
    stockRunwayDays !== null &&
    lowStockTrigger !== null &&
    stockRunwayDays <= lowStockTrigger
      ? stockRunwayDays
      : null;

  // v1.15.9 — the recent-injection list now feeds ONLY the post-dose
  // injection-site dialog's rotation history; the card surface no longer
  // shows where the last shot landed. The operator: "where I injected
  // doesn't interest me." Site TRACKING / logging is unchanged everywhere
  // else (the picker, the detail history) — only the card line drops it.
  const recentInjections = details?.recentIntakes ?? [];

  function lastInjectionLabel(): string | null {
    if (!medication.lastTakenAt) return null;
    const d = new Date(medication.lastTakenAt);
    const days = diffDays(d, now);
    if (days === 0)
      return `${t("medications.today")}, ${formatTime(medication.lastTakenAt)}`;
    if (days === -1)
      return `${t("medications.yesterday")}, ${formatTime(medication.lastTakenAt)}`;
    return formatDateTime(medication.lastTakenAt);
  }

  function nextInjectionLabel(): string | null {
    if (!next) return null;
    if (next.daysAway === 0) return t("medications.glp1NextInjectionToday");
    if (next.daysAway === 1) return t("medications.glp1NextInjectionTomorrow");
    const dayName = weekdayLabel(getDayOfWeekInTz(next.date, displayTz));
    const dateShort = fmt.dateShortSmart(next.date);
    return t("medications.glp1NextInjectionDays", {
      label: `${dayName}, ${dateShort}`,
      days: next.daysAway,
    });
  }

  const stateBadges = (
    <MedicationStateBadges
      notificationsEnabled={medication.notificationsEnabled}
      active={medication.active}
      pausedAt={medication.pausedAt}
      recordOnly={medication.trackIntake === false}
      autoMarkTaken={medication.autoMarkTaken === true}
      courseEnded={medication.courseStatus === "ENDED"}
      lastCourseEndedOn={medication.previousCourseEndedOn ?? null}
      courseNumber={currentCourseNumber(medication)}
    />
  );

  // The four former header icon-buttons (open / edit / history /
  // advanced) collapse into a SINGLE overflow menu so the GLP-1 card
  // stays symmetric with the generic medication card. The card header
  // itself links to the detail page (the former chevron target).
  const headerActions = (
    <MedicationCardMenu
      onEdit={() => onEdit(medication)}
      onOpenHistory={() => onOpenHistory(medication)}
    />
  );

  const categoryLabel = getMedicationCategoryLabel(
    medication.category,
    t,
    medication.categoryLabel,
  );

  // The upcoming-injection line value. The card owns this VALUE content —
  // the liked relative-day phrasing ("Samstag 13.7. (in 7 Tagen)") — while
  // the structure / labels live in the shared body. The purple dose accent
  // is byte-equivalent with the generic card's.
  // An open overdue slot reads "Overdue" + its time until the catch-up band
  // closes; a same-day anchor shows the clock, an older one weekday + date.
  const overdueLabel =
    medication.nextDueOverdue && next
      ? diffDays(next.date, now) === 0
        ? formatTime(next.date.toISOString())
        : `${weekdayLabel(getDayOfWeekInTz(next.date, displayTz))}, ${fmt.dateShortSmart(next.date)}`
      : null;

  const nextLine =
    next && pill?.status !== "in_window" ? (
      overdueLabel ? (
        <span className="inline-flex flex-wrap items-center gap-x-1 text-sm">
          <DoseStateLabel state="overdue" />
          <span className="text-muted-foreground">— {overdueLabel}</span>
        </span>
      ) : (
        <>
          {nextInjectionLabel()}
          {schedule?.dose && (
            <span className="text-dose-accent hidden font-medium sm:inline">
              {" "}
              — {formatDose(schedule.dose, t)}
            </span>
          )}
          {typeof schedule?.unitsPerDose === "number" &&
            schedule.unitsPerDose > 0 && (
              <span className="text-muted-foreground hidden sm:inline">
                {" "}
                ·{" "}
                {t("medications.perSlotUnits", {
                  units: formatUnitsPerDose(schedule.unitsPerDose, locale),
                })}
              </span>
            )}
        </>
      )
    ) : null;

  // v1.15.9 — the last-injection line drops the injection-site display; it
  // now reads exactly like the generic card's last line (relative-day only).
  const lastLine = medication.lastTakenAt
    ? t("medications.glp1LastInjection", { label: lastInjectionLabel() ?? "—" })
    : null;

  return (
    <MedicationCardBody
      id={medication.id}
      highlighted={highlighted}
      name={medication.name}
      dose={formatDose(medication.dose, t)}
      note={medication.note ?? null}
      categoryLabel={categoryLabel}
      active={medication.active}
      href={`/medications/${medication.id}`}
      linkLabel={t("medications.openDetailPage")}
      stateBadges={stateBadges}
      headerActions={headerActions}
      windowStatus={pill}
      doseStatus={doseStatus}
      nextLine={nextLine}
      lastLine={lastLine}
      compliance={
        compliance && !complianceNotApplicable
          ? { rate7, rate30, streak, shortDays, longDays }
          : null
      }
      complianceError={complianceError}
      complianceNotApplicable={complianceNotApplicable}
      onRetryCompliance={refetchCompliance}
      currentCycle={
        complianceNotApplicable ? null : (display?.currentCycle ?? null)
      }
      recordOnly={medication.trackIntake === false}
      intakeActionable={medication.intakeActionable !== false}
      lowStockRunwayDays={lowStockRunwayDays}
      intakeLoading={intakeLoading}
      onRecordIntake={(skipped) => recordIntake(skipped, displayedSlot)}
      snooze={snooze}
    >
      {/* v1.8.5 — post-dose injection-site capture (optional, skippable). */}
      {tracksInjection && (
        <LogInjectionSiteDialog
          open={siteIntakeId !== null}
          medicationName={medication.name}
          allowedInjectionSites={
            (medication.allowedInjectionSites ?? []) as InjectionSiteKey[]
          }
          globalExcludedInjectionSites={globalExcluded}
          history={
            recentInjections
              .map((r) => r.injectionSite)
              .filter(Boolean) as InjectionSiteKey[]
          }
          onConfirm={confirmInjectionSite}
          onSkip={() => setSiteIntakeId(null)}
        />
      )}
    </MedicationCardBody>
  );
}
