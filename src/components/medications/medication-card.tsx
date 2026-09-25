"use client";

import { useState, useEffect, useReducer } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationCardBody } from "@/components/medications/card-parts/medication-card-body";
import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { formatDateTime, formatTime } from "@/lib/format";
import { getDateTimeFormat } from "@/lib/intl/formatter-cache";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import { formatDose } from "@/lib/medications/format-dose";
import { formatUnitsPerDose } from "@/lib/medications/units-per-dose";
import { reduceCurrentWindowStatus } from "@/lib/medications/window-status";
import { resolveNextDueDayLabel } from "@/lib/medications/next-due-day-label";
import { resolveDisplayedSlotInstant } from "@/components/medications/card-parts/displayed-slot-instant";
import {
  estimateDailyDoseCount,
  estimateRunwayDays,
  lowStockTriggerDays,
} from "@/components/medications/detail/supply-runway";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { useMedicationComplianceSummary } from "@/lib/queries/use-medication-compliance-summary";
import { LogInjectionSiteDialog } from "@/components/medications/log-injection-site-dialog";
import { useGlobalExcludedInjectionSites } from "@/lib/medications/use-injection-site-prefs";
import { useAuth } from "@/hooks/use-auth";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  /**
   * v1.16.1 — first-class dose times + explicit per-dose bands. The
   * window-status helper derives its bands from these (canonical) and
   * only falls back to `windowStart` / `windowEnd` when they are absent,
   * so a stale window can no longer drive the pill or the recorded slot.
   */
  timesOfDay?: string[];
  doseWindows?: { timeOfDay: string; start: string; end: string }[] | null;
  /** Cadence fields the supply-runway estimate reads (v1.16.11). */
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  /** #219 — per-schedule units consumed per dose. NULL inherits the med level. */
  unitsPerDose?: number | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  /**
   * v1.4.25 W4d — Prisma treatment-class discriminator. When set to
   * "GLP1" the parent should render the {@link Glp1MedicationCard}
   * variant instead of this generic card. The field is optional for
   * backwards compatibility with mocks.
   */
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
  /**
   * v1.8.4 — server-computed next due instant from `GET /api/medications`
   * (`computeNextDueAt` → the canonical recurrence engine, anchored on the
   * last intake). The card renders this directly instead of re-deriving the
   * timestamp client-side; the engine honours rolling / RRULE / one-shot
   * cadences that the legacy daysOfWeek-only walker ignored.
   */
  nextDueAt?: string | null;
  /**
   * v1.16.4 — true when `nextDueAt` is an OPEN overdue slot (its anchor
   * passed but "now" is still inside the slot's catch-up band and no
   * intake row resolves it). The card renders the slot as "overdue —
   * still takeable" instead of the regular upcoming-intake phrasing.
   */
  nextDueOverdue?: boolean;
  /**
   * v1.16.11 (#316) — as-needed (PRN) medication: no schedules, never
   * due, never reminded, no compliance. The card renders a calm
   * "Bei Bedarf" marker where next-due normally sits and replaces the
   * compliance bars with the last-taken oriented presentation.
   */
  asNeeded?: boolean;
  /** v1.16.10 — dose-derived stock from the list payload; null = inventory tracking off. */
  stockDosesRemaining?: number | null;
  /** v1.37.19 — server-resolved slot-aware runway (days); null = off/no cadence. */
  runwayDays?: number | null;
  /**
   * v1.17.0 — optional per-medication reorder lead override (days); null /
   * absent = inherit the user-level reorderLeadDays default. Widens the
   * low-stock trigger so the notice lands before the last dose.
   */
  reorderLeadDays?: number | null;
  /**
   * v1.39.1 (#1033) — false keeps the medication as a record: the list
   * serves `schedules: []` and nothing is due, so the card drops the
   * compliance bars and the take / skip actions and shows a badge instead.
   */
  trackIntake?: boolean;
  schedules: Schedule[];
}

interface MedicationCardProps {
  medication: Medication;
  onEdit: (med: Medication) => void;
  /**
   * v1.15.18 — navigates to the medication detail page's Verlauf tab
   * (`/medications/{id}?tab=verlauf`). The parent owns the navigation.
   */
  onOpenHistory: (med: Medication) => void;
  /**
   * v1.29.x — briefly ringed when this card is the Today digest's "Log
   * dose" deep-link target (`/medications?highlight=<id>`).
   */
  highlighted?: boolean;
}

export function MedicationCard({
  medication,
  onEdit,
  onOpenHistory,
  highlighted = false,
}: MedicationCardProps) {
  const queryClient = useQueryClient();
  const { t, locale } = useTranslations();
  // v1.16.9 — the card reasons in the PROFILE timezone (the snapshot the
  // session carries); Berlin stays the last-resort fallback so logged-out
  // mounts and legacy fixtures behave unchanged.
  const { user } = useAuth();
  const userTz = user?.timezone || "Europe/Berlin";
  const fmt = useFormatters();
  const weekdayLabel = useWeekdayLabel();
  // v1.8.5 — post-dose injection-site prompt state. Holds the intake
  // event id returned by the take POST so the confirm handler can PATCH
  // the chosen site onto it. Null = dialog closed.
  const [siteIntakeId, setSiteIntakeId] = useState<string | null>(null);
  const globalExcluded = useGlobalExcludedInjectionSites();
  const tracksInjection =
    medication.deliveryForm === "INJECTION" &&
    medication.trackInjectionSites === true;

  // v1.12.2 — intake take / skip + failure-toast (C1) + Undo (C2) live in
  // a shared hook so the generic and GLP-1 cards can never re-diverge. The
  // card keeps only its post-success follow-up: prompting (skippably) for
  // the injection site on a taken dose when tracking is enabled.
  const { intakeLoading, recordIntake } = useMedicationIntake({
    medication,
    onRecorded: (eventId, skipped) => {
      if (!skipped && tracksInjection && eventId) {
        setSiteIntakeId(eventId);
      }
    },
  });

  // v1.16.8 — the per-card compliance read rides the ONE batched
  // `GET /api/medications/compliance` round trip every card on the page
  // shares (the per-id endpoint stays for the detail page's heatmap).
  // `isError` swaps the compliance slot to the quiet retry fallback so a
  // failed batch read never leaves the card on a permanent skeleton.
  const {
    data: compliance,
    isError: complianceError,
    refetch: refetchCompliance,
  } = useMedicationComplianceSummary(medication.id);

  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lateMinutes: number;
          missedMinutes: number;
          lowStockRunwayDays: number | null;
          reorderLeadDays?: number;
        }>("/api/settings/reminder-thresholds");
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
  });

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
      toast.error(t("medications.logInjectionSiteSaveFailed"));
      throw err;
    }
    await invalidateKeys(queryClient, medicationDependentKeys);
    setSiteIntakeId(null);
  }

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
  // v1.15.9 — the open dose's server-derived status drives a discreet status
  // line/glyph (text + icon only) and the overdue / heavily-overdue top line.
  // Per the neutral med-card rule there is NO green take-window highlight and
  // no grade-tinted card chrome — status is conveyed by a calm line, never a
  // background/border tint. Defaults to "upcoming" (calm) when the display
  // block is absent (older mocks).
  const doseStatus = display?.currentDose.status ?? "upcoming";
  const categoryLabel = getMedicationCategoryLabel(medication.category, t);
  const sortedSchedules = [...medication.schedules].sort(
    (a, b) =>
      a.windowStart.localeCompare(b.windowStart) ||
      a.windowEnd.localeCompare(b.windowEnd),
  );
  const now = new Date();
  // v1.8.4 — the next-due instant comes from the server (`nextDueAt`,
  // computed by the canonical recurrence engine anchored on the last
  // intake). The day label below derives from it; the window-range /
  // dose / label still come from the earliest configured schedule. The
  // legacy client-side daysOfWeek walker only ever read daysOfWeek +
  // windowStart and silently mis-anchored rolling / RRULE / one-shot
  // cadences, so it is gone.
  const nextDueMs = medication.nextDueAt
    ? new Date(medication.nextDueAt).getTime()
    : NaN;
  const nextAt = Number.isFinite(nextDueMs) ? nextDueMs : undefined;
  const nextSchedule = sortedSchedules[0] ?? null;

  const lateMinutes = thresholds?.lateMinutes ?? 120;
  const missedMinutes = thresholds?.missedMinutes ?? 240;

  const currentWindowStatus = reduceCurrentWindowStatus({
    schedules: sortedSchedules,
    now,
    lateMinutes,
    missedMinutes,
    active: medication.active,
    lastTakenAt: medication.lastTakenAt,
    todayEventCount: medication.todayEventCount ?? 0,
    tz: userTz,
    // v1.16.6 — gate the pill on the server display-due so a rolling
    // cadence whose next dose is tomorrow can never paint an overdue pill
    // today. `undefined` (older payloads / fixtures) keeps legacy behaviour.
    nextDue:
      medication.nextDueAt === undefined
        ? undefined
        : nextAt !== undefined
          ? {
              at: new Date(nextAt),
              overdue: medication.nextDueOverdue === true,
            }
          : null,
  });

  // v1.12.3 — the slot instant of the dose this card is currently showing
  // (the open/overdue window, else the server's next-due). Threaded onto
  // the take / skip POST so the server records THIS dose rather than
  // snapping "now" to the nearest slot — a morning tap on a 07:00 / 19:00
  // medication used to mis-record the 07:00 dose.
  const displayedSlot = resolveDisplayedSlotInstant({
    currentWindowStatus,
    nextDueAt: medication.nextDueAt,
    now: new Date(),
    timeZone: userTz,
  });

  // v1.16.11 — low-stock card context. Runway days from the list
  // payload's dose-derived stock over the same estimate the table /
  // detail Übersicht / notification engine use; surfaced ONLY below the
  // user's runway threshold (`lowStockRunwayDays`, default 7, null =
  // alert off → no card line either). Stock 0 with a consuming schedule
  // is runway 0 (mirrors `evaluateMedicationRunway`); as-needed has no
  // runway, ever.
  // v1.17.0 — the trigger is reorder-lead-aware: max(floor, lead +
  // cadenceIntervalDays). The bare floor (`lowStockRunwayDays`) and the
  // user-level lead default come from the thresholds endpoint; a per-med
  // `reorderLeadDays` overrides the default. The notice lights at runway
  // ≤ trigger (matching the daily cron), so a weekly med is warned before
  // its last dose, not at it.
  const lowStockFloor = thresholds == null ? 7 : thresholds.lowStockRunwayDays;
  const leadDays =
    medication.reorderLeadDays != null
      ? medication.reorderLeadDays
      : (thresholds?.reorderLeadDays ?? 10);
  // v1.37.19 — prefer the server's slot-aware `runwayDays` (published on
  // the list wire); the client estimate stays only as the stale-payload
  // fallback.
  const stockRunwayDays =
    medication.asNeeded || medication.stockDosesRemaining == null
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

  function formatLastTakenAt(value: string): string {
    // Intentionally en-CA: gives YYYY-MM-DD which is locale-independent and
    // string-comparable for the today / yesterday / older bucketing below.
    // The actual user-facing display goes through formatTime / formatDateTime.
    const dayFormatter = getDateTimeFormat("en-CA", {
      timeZone: userTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const intakeDay = dayFormatter.format(new Date(value));
    const todayDay = dayFormatter.format(now);
    const yesterdayDay = dayFormatter.format(yesterday);
    const time = formatTime(value);

    if (intakeDay === todayDay) return `${t("medications.today")}, ${time}`;
    if (intakeDay === yesterdayDay)
      return `${t("medications.yesterday")}, ${time}`;
    return formatDateTime(value);
  }

  const stateBadges = (
    <MedicationStateBadges
      notificationsEnabled={medication.notificationsEnabled}
      active={medication.active}
      pausedAt={medication.pausedAt}
      recordOnly={medication.trackIntake === false}
    />
  );

  // v1.7.2 W3 — the four former header icon-buttons (open / edit /
  // history / advanced) collapse into a single overflow kebab. The card
  // header itself links to the detail page (the former chevron target).
  const headerActions = (
    <MedicationCardMenu
      onEdit={() => onEdit(medication)}
      onOpenHistory={() => onOpenHistory(medication)}
    />
  );

  // v1.16.11 — as-needed: a calm marker where next-due normally sits.
  // No due pill, no overdue escalation, ever (structurally there is no
  // schedule, so the window status is already null).
  const asNeededLine = medication.asNeeded ? (
    <span
      className="text-muted-foreground"
      data-slot="medication-as-needed-marker"
    >
      {t("medications.asNeededMarker")}
    </span>
  ) : null;

  // The upcoming-intake line value — a day label + window range + optional
  // dose accent. The card owns this VALUE content (a daily med reads as a
  // clock-time window); the structure / labels live in the shared body.
  const nextLine =
    nextSchedule && currentWindowStatus.status !== "in_window"
      ? (() => {
          const s = nextSchedule;

          // v1.16.4 — an open overdue slot stays on the card as a calm
          // amber "overdue · HH:mm — still takeable" line until its
          // catch-up band closes (auto-miss); only then does the line
          // advance to the next future slot.
          if (medication.nextDueOverdue && nextAt) {
            return (
              <span className="text-warning font-medium">
                {t("medications.nextIntakeOverdue", {
                  time: formatTime(new Date(nextAt).toISOString()),
                })}
              </span>
            );
          }

          // Format day label relative to today
          let dayLabel = "";
          if (nextAt) {
            const label = resolveNextDueDayLabel(new Date(nextAt), now, userTz);
            dayLabel =
              label.kind === "today"
                ? t("medications.today")
                : label.kind === "tomorrow"
                  ? t("medications.tomorrow")
                  : label.kind === "weekday"
                    ? weekdayLabel(label.weekday)
                    : fmt.dateWithWeekdaySmart(label.instant);
          }

          // v1.16.1 — the TIME is the canonical next-due instant (the
          // recurrence engine's timesOfDay-anchored slot), not the legacy
          // schedule window. A stale `windowStart` / `windowEnd` pair
          // (e.g. 07:00 / 07:00 while the times moved to 09:00 / 21:00)
          // used to print "today, 07:00" here. The window range stays as
          // the fallback for rows the server has no next-due for.
          return (
            <>
              {dayLabel && `${dayLabel}, `}
              {nextAt
                ? formatTime(new Date(nextAt).toISOString())
                : formatTimeWindowRange(s.windowStart, s.windowEnd, locale)}
              {s.label && (
                <span className="hidden sm:inline"> ({s.label})</span>
              )}
              {s.dose && (
                <span className="text-dose-accent hidden font-medium sm:inline">
                  {" "}
                  — {formatDose(s.dose, t)}
                </span>
              )}
              {typeof s.unitsPerDose === "number" && s.unitsPerDose > 0 && (
                <span className="text-muted-foreground hidden sm:inline">
                  {" "}
                  ·{" "}
                  {t("medications.perSlotUnits", {
                    units: formatUnitsPerDose(s.unitsPerDose, locale),
                  })}
                </span>
              )}
            </>
          );
        })()
      : null;

  return (
    <MedicationCardBody
      id={medication.id}
      highlighted={highlighted}
      name={medication.name}
      dose={formatDose(medication.dose, t)}
      categoryLabel={categoryLabel}
      active={medication.active}
      href={`/medications/${medication.id}`}
      linkLabel={t("medications.openDetailPage")}
      stateBadges={stateBadges}
      headerActions={headerActions}
      windowStatus={
        currentWindowStatus.status
          ? {
              status: currentWindowStatus.status,
              // v1.16.1 — the pill shows the MATCHED dose band, not the
              // legacy schedule window (which may be stale / degenerate).
              windowStart: currentWindowStatus.window!.start,
              windowEnd: currentWindowStatus.window!.end,
              takenEarlyDaysAgo: currentWindowStatus.takenEarlyDaysAgo,
            }
          : null
      }
      doseStatus={medication.asNeeded ? "upcoming" : doseStatus}
      nextLine={asNeededLine ?? nextLine}
      lastLine={
        medication.lastTakenAt
          ? formatLastTakenAt(medication.lastTakenAt)
          : null
      }
      asNeeded={medication.asNeeded === true}
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
      lowStockRunwayDays={lowStockRunwayDays}
      intakeLoading={intakeLoading}
      onRecordIntake={(skipped) => recordIntake(skipped, displayedSlot)}
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
          history={[]}
          onConfirm={confirmInjectionSite}
          onSkip={() => setSiteIntakeId(null)}
        />
      )}
    </MedicationCardBody>
  );
}
