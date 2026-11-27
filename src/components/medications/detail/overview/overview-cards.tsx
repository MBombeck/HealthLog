"use client";

/**
 * The medication overview: three cards built the same way (Today, Intake,
 * Effect), then the plan.
 *
 * Every card has one anatomy: a header with an icon, a title and a chip; one
 * sentence; one figure or a short list; and a pair of equal-width buttons at
 * the foot, the secondary left, the primary right. The cards sit in one row
 * on a wide screen and stretch to the same height, so the button pairs line
 * up.
 *
 * Everything shown is the server's: today's doses and the 14-day grid are the
 * dose-history ledger's rows, the adherence is the compliance read, the next
 * dose is the detail read's `nextDueAt`, the effect sentence is worded by the
 * efficacy route. The client words sentences around those values and counts
 * the ledger's rows for the legend; it decides nothing.
 */

import type { ComponentType, ReactNode } from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BellRing,
  CalendarCheck,
  Clock,
  Minus,
  Pill,
  TrendingUp,
} from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TagChip } from "@/components/ui/tag-chip";
import { DoseStateLabel } from "@/components/medications/dose-state-label";
import type { DoseState } from "@/lib/medications/dose-state/resolve";
import { useCardDoseSnooze } from "@/components/medications/card-parts/use-dose-snooze";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import {
  groupLedgerByDay,
  type LedgerPayload,
  type LedgerRow,
} from "@/components/medications/dose-history-ledger-compute";
import { useNextDoseText } from "@/components/medications/detail/overview-status-section";
import { useCadenceLine } from "@/components/medications/medication-detail-summary";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";
import type { MedicationDetailSnapshot } from "@/components/medications/detail/medication-detail-tabs";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDate as formatCalendarDate } from "@/lib/date-format";
import {
  useDateFormatPreference,
  useDisplayTimezone,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";
import type { SupplySummary } from "@/lib/medications/inventory/summary";
import type { MedicationEfficacyDTO } from "@/lib/medications/efficacy/build-efficacy";
import { cardTakeSlot, liveDoseState } from "@/lib/medications/dose-state/pill";
import { DOSE_ACTION_TERM } from "@/lib/medications/dose-state/terms";
import { scoredRate } from "@/lib/medications/shown-adherence";
import { queryKeys } from "@/lib/query-keys";
import { userDayKey } from "@/lib/tz/format";
import { dateOnlyAtNoonUtc, dateOnlyKey } from "@/lib/tz/date-only";
import { cn } from "@/lib/utils";

import { MedicationLeafletRow } from "@/components/medications/detail/medication-leaflet-section";

import { EfficacySparkline } from "./efficacy-sparkline";

/** Days the intake grid spans: today and the thirteen before it. */
export const GRID_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OverviewCompliance {
  applicable: boolean;
  notApplicableReason: "NO_LOCAL_SCHEDULE" | "INTAKE_NOT_TRACKED" | null;
  compliance7: { rate: number; streak: number };
  compliance30: { rate: number };
  complianceDisplay: ComplianceDisplay | null;
}

/* -------------------------------------------------------------------------- */
/* Anatomy                                                                    */
/* -------------------------------------------------------------------------- */

/** One overview card: header with chip, a sentence, a body, a button pair. */
export function OverviewCard({
  icon,
  title,
  chip,
  sentence,
  children,
  actions,
  slot,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  chip?: ReactNode;
  sentence: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  slot: string;
}) {
  return (
    <Card className="h-full" data-slot={slot}>
      <CardHeader>
        <TileHeader
          icon={icon}
          title={title}
          titleAs="h2"
          right={chip ? <TagChip className="shrink-0">{chip}</TagChip> : null}
        />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="text-foreground text-sm" data-slot={`${slot}-sentence`}>
          {sentence}
        </p>
        {children}
        {actions && <div className="mt-auto">{actions}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * Two equal-width framed buttons: the secondary left, the filled primary
 * right. A missing secondary leaves its half empty, so the primary stays in
 * the same place on every card.
 */
export function ActionPair({
  secondary,
  primary,
}: {
  secondary?: ReactNode;
  primary: ReactNode;
}) {
  return (
    <div className="grid grid-cols-2 gap-2" data-slot="overview-action-pair">
      {secondary ?? <span aria-hidden="true" />}
      {primary}
    </div>
  );
}

const PAIR_BUTTON = "min-h-11 w-full sm:min-h-9";

/* -------------------------------------------------------------------------- */
/* Shared reads                                                               */
/* -------------------------------------------------------------------------- */

/** The ledger over the grid's window; the dose-history tab's own read. */
export function useOverviewLedger(medicationId: string) {
  const { user } = useAuth();
  const timeZone = user?.timezone || "UTC";
  const query = useQuery<LedgerPayload>({
    queryKey: queryKeys.medicationDoseHistory(medicationId, GRID_DAYS),
    queryFn: () => {
      const from = new Date(Date.now() - GRID_DAYS * DAY_MS).toISOString();
      return apiGet<LedgerPayload>(
        `/api/medications/${medicationId}/dose-history?${new URLSearchParams({ from }).toString()}`,
      );
    },
    staleTime: 15_000,
  });
  const byDay = useMemo(() => {
    const map = new Map<string, LedgerRow[]>();
    for (const group of groupLedgerByDay(query.data?.rows ?? [], timeZone)) {
      map.set(group.dayKey, group.rows);
    }
    return map;
  }, [query.data, timeZone]);
  return { ...query, byDay };
}

/** The last `GRID_DAYS` day keys, oldest first, ending today. */
function gridDayKeys(todayKey: string): string[] {
  // Calendar arithmetic on day keys: noon anchors never cross a day edge.
  const today = dateOnlyAtNoonUtc(todayKey).getTime();
  return Array.from({ length: GRID_DAYS }, (_, i) =>
    dateOnlyKey(new Date(today - (GRID_DAYS - 1 - i) * DAY_MS)),
  );
}

/* -------------------------------------------------------------------------- */
/* Today                                                                      */
/* -------------------------------------------------------------------------- */

/** One of today's doses, from the server's today list. */
export interface TodayDose {
  key: string;
  /** The slot's time; null for a take on no slot. */
  slotAt: string | null;
  takenAt: string | null;
  state: DoseState | null;
}

interface TodayWireRow {
  id: string;
  medicationId: string;
  takenAt: string | null;
  slotInstant: string | null;
  state: "upcoming" | "due" | "overdue" | "taken" | "skipped" | "missed" | null;
  takenLate: boolean;
}

/**
 * Today's doses of one medication, later slots included: the today list the
 * cards and the app read (`GET /api/medications/intake?scope=today`), in its
 * shared cache cell. The dose history stops at now, so it cannot say what is
 * still to come today.
 */
export function useTodayDoses(medicationId: string, enabled: boolean) {
  const { data } = useQuery({
    queryKey: queryKeys.medicationIntakeToday(),
    queryFn: () =>
      apiGet<TodayWireRow[]>("/api/medications/intake?scope=today"),
    enabled,
    staleTime: 60_000,
  });
  return useMemo<TodayDose[]>(
    () =>
      (Array.isArray(data) ? data : [])
        .filter((row) => row.medicationId === medicationId)
        .map((row) => ({
          key: row.id,
          slotAt: row.slotInstant,
          takenAt: row.takenAt,
          state:
            row.state === "upcoming"
              ? "pending"
              : row.state === "taken" && row.takenLate
                ? "taken_late"
                : row.state,
        }))
        .sort((a, b) =>
          (a.slotAt ?? a.takenAt ?? "").localeCompare(
            b.slotAt ?? b.takenAt ?? "",
          ),
        ),
    [data, medicationId],
  );
}

export function TodayCard({
  medication,
  recordOnly,
  asNeeded,
  courseStatus,
  compliance,
  todayDoses,
  onBackfill,
  onHistory,
}: {
  medication: MedicationDetailSnapshot;
  recordOnly: boolean;
  asNeeded: boolean;
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED";
  compliance: OverviewCompliance | null | undefined;
  todayDoses: TodayDose[];
  onBackfill: () => void;
  onHistory?: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const tz = useDisplayTimezone();
  const nextDoseText = useNextDoseText();
  const { canWriteDomain } = useRecordCapabilities();
  const canRecord = canWriteDomain("medications");

  const canAct =
    medication.active &&
    !recordOnly &&
    courseStatus !== "ENDED" &&
    courseStatus !== "UPCOMING";
  const now = new Date();
  const currentDose = compliance?.complianceDisplay?.currentDose ?? null;
  const takeSlot = cardTakeSlot(currentDose, medication.nextDueAt, now);
  const { intakeLoading, recordIntake } = useMedicationIntake({ medication });
  const snooze = useCardDoseSnooze({
    ...medication,
    trackIntake: !recordOnly,
    intakeActionable: canAct,
  });

  const slots = todayDoses.filter((dose) => dose.slotAt !== null);
  const extras = todayDoses.filter(
    (dose) => dose.slotAt === null && dose.takenAt,
  );
  const taken = slots.filter(
    (dose) => dose.state === "taken" || dose.state === "taken_late",
  ).length;

  // The first dose of today that still waits for an answer.
  const open = slots.find(
    (dose) =>
      dose.state === "pending" ||
      dose.state === "due" ||
      dose.state === "overdue",
  );
  const openState = open?.state ?? null;
  const openTime = open?.slotAt ? fmt.time(open.slotAt) : "";
  const live = currentDose ? liveDoseState(currentDose, now) : null;

  const sentence = !medication.active
    ? t("medications.detail.uebersicht.pausedHint")
    : recordOnly
      ? t("medications.detail.uebersicht.nextDoseNotTracked")
      : asNeeded
        ? extras.length > 0
          ? t("medications.detail.overview.today.asNeededTaken", {
              count: extras.length,
            })
          : t("medications.detail.uebersicht.nextDoseAsNeeded")
        : open
          ? openState === "overdue" || live === "overdue"
            ? t("medications.detail.overview.today.overdueAt", {
                time: openTime,
              })
            : openState === "due"
              ? t("medications.detail.overview.today.dueAt", { time: openTime })
              : t("medications.detail.overview.today.nextAt", {
                  time: openTime,
                })
          : slots.length > 0
            ? t("medications.detail.overview.today.nothingOpen")
            : t("medications.detail.overview.today.noneToday");

  const nextIsToday =
    medication.nextDueAt !== null &&
    medication.nextDueAt !== undefined &&
    userDayKey(new Date(medication.nextDueAt), tz) === userDayKey(now, tz);
  const showNext =
    canAct && !asNeeded && !!medication.nextDueAt && !nextIsToday;

  const extra = takeSlot?.binding === "extra";
  const hint =
    canAct && takeSlot ? (
      extra ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="medication-intake-extra"
        >
          {t("medications.dose.extraHint", { time: fmt.time(takeSlot.at) })}
        </p>
      ) : takeSlot.earlyFrom ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="medication-intake-early"
        >
          {t("medications.dose.earlyHint", {
            time: fmt.time(takeSlot.earlyFrom),
          })}
        </p>
      ) : null
    ) : null;

  const takeButton = (
    <Button
      className={PAIR_BUTTON}
      onClick={() => void recordIntake(false, takeSlot)}
      disabled={!!intakeLoading}
      aria-busy={intakeLoading === "take" || undefined}
      data-slot="medication-intake-take"
    >
      {extra
        ? t("medications.dose.action.takeExtra")
        : t(DOSE_ACTION_TERM.take)}
    </Button>
  );

  const actions = !canRecord ? null : canAct ? (
    <ActionPair
      secondary={
        asNeeded ? (
          <Button
            variant="outline"
            className={PAIR_BUTTON}
            onClick={onBackfill}
            data-slot="medication-overview-backfill"
          >
            {t("medications.detail.verlauf.backfill")}
          </Button>
        ) : (
          <Button
            variant="outline"
            className={PAIR_BUTTON}
            onClick={() => void recordIntake(true, takeSlot)}
            disabled={!!intakeLoading}
            aria-busy={intakeLoading === "skip" || undefined}
            data-slot="medication-intake-skip"
          >
            {t(DOSE_ACTION_TERM.skip)}
          </Button>
        )
      }
      primary={takeButton}
    />
  ) : (
    <ActionPair
      secondary={
        <Button
          variant="outline"
          className={PAIR_BUTTON}
          onClick={onBackfill}
          data-slot="medication-overview-backfill"
        >
          {t("medications.detail.verlauf.backfill")}
        </Button>
      }
      primary={
        onHistory ? (
          <Button
            className={PAIR_BUTTON}
            onClick={onHistory}
            data-slot="medication-overview-history"
          >
            {t("medications.detail.tabs.verlauf")}
          </Button>
        ) : (
          <span aria-hidden="true" />
        )
      }
    />
  );

  return (
    <OverviewCard
      icon={Pill}
      title={t("medications.today")}
      chip={
        !asNeeded && slots.length > 0
          ? t("medications.detail.overview.today.progress", {
              taken,
              total: slots.length,
            })
          : undefined
      }
      sentence={sentence}
      slot="medication-overview-today"
      actions={
        actions && (
          <div className="space-y-2">
            {hint}
            {canAct && snooze?.snoozedUntil ? (
              <p
                className="text-muted-foreground flex items-center gap-1.5 text-xs"
                data-slot="medication-snoozed"
              >
                <BellRing className="size-3.5 shrink-0" aria-hidden="true" />
                {t("medications.dose.state.snoozedUntil", {
                  time: fmt.time(snooze.snoozedUntil),
                })}
              </p>
            ) : canAct && snooze?.canSnooze ? (
              <InlineAction
                tone="muted"
                size="xs"
                onClick={snooze.snooze}
                disabled={snooze.busy || !!intakeLoading}
                data-slot="medication-intake-snooze"
              >
                <BellRing className="size-3.5" aria-hidden="true" />
                {t(DOSE_ACTION_TERM.snooze, { minutes: snooze.minutes })}
              </InlineAction>
            ) : null}
            {actions}
          </div>
        )
      }
    >
      {(slots.length > 0 || extras.length > 0 || showNext) && (
        <ul
          className="divide-border/60 divide-y text-sm"
          data-slot="medication-overview-today-rows"
        >
          {slots.map((dose) => (
            <li
              key={dose.key}
              className="flex min-h-10 items-center justify-between gap-3 py-2"
              data-slot="medication-overview-today-row"
              data-state={dose.state ?? undefined}
            >
              <span className="text-muted-foreground tabular-nums">
                {fmt.time(dose.slotAt!)}
              </span>
              <span className="flex items-center gap-1.5">
                {dose.state && (
                  <DoseStateLabel state={dose.state} className="text-sm" />
                )}
                {(dose.state === "taken" || dose.state === "taken_late") &&
                  dose.takenAt && (
                    <span className="text-foreground tabular-nums">
                      {fmt.time(dose.takenAt)}
                    </span>
                  )}
              </span>
            </li>
          ))}
          {extras.map((dose) => (
            <li
              key={dose.key}
              className="flex min-h-10 items-center justify-between gap-3 py-2"
              data-slot="medication-overview-today-row"
              data-state="extra"
            >
              <span className="text-muted-foreground">
                {t("medications.detail.verlauf.extraColumn")}
              </span>
              <span className="text-foreground tabular-nums">
                {fmt.time(dose.takenAt!)}
              </span>
            </li>
          ))}
          {showNext && (
            <li
              className="flex min-h-10 items-center justify-between gap-3 py-2"
              data-slot="medication-overview-next-dose"
            >
              <span className="text-muted-foreground">
                {t("medications.detail.uebersicht.nextDoseLabel")}
              </span>
              <span className="text-foreground">
                {nextDoseText(medication.nextDueAt!)}
              </span>
            </li>
          )}
        </ul>
      )}
    </OverviewCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Intake                                                                     */
/* -------------------------------------------------------------------------- */

type CellTone = "taken" | "late" | "missed" | "skipped" | "open" | "none";

function cellTone(rows: LedgerRow[] | undefined): CellTone {
  if (!rows || rows.length === 0) return "none";
  const row = rows[0];
  switch (row.status) {
    case "taken_on_time":
      return "taken";
    case "taken_late":
      return "late";
    case "missed":
      return "missed";
    case "skipped":
      return "skipped";
    case "upcoming":
      return "open";
    default:
      return "taken";
  }
}

const CELL_CLASS: Record<CellTone, string> = {
  taken: "bg-success/70",
  late: "bg-warning/70",
  missed: "border-destructive border-2",
  skipped: "bg-muted-foreground/40",
  open: "border-border border",
  none: "",
};

export function IntakeCard({
  asNeeded,
  recordOnly,
  compliance,
  byDay,
  todayKey,
  loading,
  onBackfill,
  onHistory,
}: {
  asNeeded: boolean;
  recordOnly: boolean;
  compliance: OverviewCompliance | null | undefined;
  byDay: Map<string, LedgerRow[]>;
  todayKey: string;
  loading: boolean;
  onBackfill?: () => void;
  onHistory?: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const days = gridDayKeys(todayKey);

  // The grid's rows: every dose time the window holds (one row for an
  // as-needed medication, whose takes have no time of their own).
  const times = useMemo(() => {
    const set = new Set<string>();
    for (const day of days) {
      for (const row of byDay.get(day) ?? []) {
        if (row.kind === "slot" && row.timeOfDay) set.add(row.timeOfDay);
      }
    }
    return [...set].sort();
  }, [byDay, days]);

  const counts = { taken: 0, late: 0, missed: 0, skipped: 0, extra: 0 };
  for (const day of days) {
    for (const row of byDay.get(day) ?? []) {
      if (row.status === "taken_on_time") counts.taken += 1;
      else if (row.status === "taken_late") counts.late += 1;
      else if (row.status === "missed") counts.missed += 1;
      else if (row.status === "skipped") counts.skipped += 1;
      else if (row.kind === "ad_hoc" && row.intake?.takenAt) counts.extra += 1;
    }
  }

  const display = compliance?.complianceDisplay ?? null;
  const rate = display
    ? scoredRate(display.long.rate, display.long.expected)
    : null;
  const windowDays = display?.longDays ?? 30;
  const notApplicable = compliance?.applicable === false;

  const sentence = asNeeded
    ? t("medications.detail.overview.intake.asNeededCount", {
        days: GRID_DAYS,
        count: counts.extra,
      })
    : recordOnly
      ? t("medications.detail.uebersicht.nextDoseNotTracked")
      : notApplicable
        ? t("medications.complianceNotApplicable")
        : rate === null || !display
          ? t("medications.detail.verlauf.summaryEmpty")
          : display.long.missed === 0
            ? t("medications.detail.overview.intake.missedNone", {
                days: windowDays,
              })
            : t("medications.detail.overview.intake.missedSome", {
                days: windowDays,
                count: display.long.missed,
              });

  const legend: { tone: CellTone; text: string }[] = asNeeded
    ? [
        {
          tone: "taken",
          text: t("medications.detail.overview.legend.taken", {
            count: counts.extra,
          }),
        },
      ]
    : [
        {
          tone: "taken" as const,
          text: t("medications.detail.overview.legend.taken", {
            count: counts.taken,
          }),
        },
        ...(counts.late > 0
          ? [
              {
                tone: "late" as const,
                text: t("medications.detail.overview.legend.late", {
                  count: counts.late,
                }),
              },
            ]
          : []),
        ...(counts.missed > 0
          ? [
              {
                tone: "missed" as const,
                text: t("medications.detail.overview.legend.missed", {
                  count: counts.missed,
                }),
              },
            ]
          : []),
        ...(counts.skipped > 0
          ? [
              {
                tone: "skipped" as const,
                text: t("medications.detail.overview.legend.skipped", {
                  count: counts.skipped,
                }),
              },
            ]
          : []),
      ];

  const gridRows: { label: string; tone: (day: string) => CellTone }[] =
    asNeeded || times.length === 0
      ? [
          {
            label: "",
            tone: (day) =>
              (byDay.get(day) ?? []).some(
                (row) => row.kind === "ad_hoc" && row.intake?.takenAt,
              )
                ? "taken"
                : "open",
          },
        ]
      : times.map((time) => ({
          label: fmt.wallTime(time),
          tone: (day: string) =>
            cellTone(
              byDay
                .get(day)
                ?.filter(
                  (row) => row.kind === "slot" && row.timeOfDay === time,
                ),
            ),
        }));
  const labelled = gridRows.some((row) => row.label !== "");

  return (
    <OverviewCard
      icon={CalendarCheck}
      title={t("medications.detail.overview.intake.title")}
      chip={
        !asNeeded && rate !== null
          ? t("medications.detail.overview.daysChip", { days: windowDays })
          : t("medications.detail.overview.daysChip", { days: GRID_DAYS })
      }
      sentence={sentence}
      slot="medication-overview-intake"
      actions={
        onBackfill || onHistory ? (
          <ActionPair
            secondary={
              onBackfill ? (
                <Button
                  variant="outline"
                  className={PAIR_BUTTON}
                  onClick={onBackfill}
                  data-slot="medication-overview-intake-backfill"
                >
                  {t("medications.detail.verlauf.backfill")}
                </Button>
              ) : undefined
            }
            primary={
              onHistory ? (
                <Button
                  className={PAIR_BUTTON}
                  onClick={onHistory}
                  data-slot="medication-overview-intake-history"
                >
                  {t("medications.detail.tabs.verlauf")}
                </Button>
              ) : (
                <span aria-hidden="true" />
              )
            }
          />
        ) : undefined
      }
    >
      {!asNeeded && rate !== null && (
        <p className="flex items-baseline gap-2">
          <span
            className="text-foreground text-3xl font-semibold tabular-nums"
            data-slot="medication-overview-adherence"
          >
            {fmt.percent(rate / 100)}
          </span>
          <span className="text-muted-foreground text-sm">
            {t("medications.detail.uebersicht.complianceTitle")}
          </span>
        </p>
      )}
      {loading ? (
        <Skeleton className="h-12 w-full" />
      ) : (
        <div className="space-y-2">
          <div
            role="img"
            aria-label={legend.map((item) => item.text).join(", ")}
            className="grid items-center gap-1"
            style={{
              gridTemplateColumns: labelled
                ? `auto repeat(${GRID_DAYS}, minmax(0, 1fr))`
                : `repeat(${GRID_DAYS}, minmax(0, 1fr))`,
            }}
            data-slot="medication-overview-grid"
          >
            {gridRows.map((row) => (
              <GridRow
                key={row.label || "takes"}
                label={row.label}
                labelled={labelled}
                days={days}
                tone={row.tone}
              />
            ))}
            {labelled && <span aria-hidden="true" />}
            {days.map((day, i) => (
              <span
                key={day}
                aria-hidden="true"
                className={cn(
                  "text-muted-foreground text-2xs whitespace-nowrap tabular-nums",
                  i === GRID_DAYS - 1 && "justify-self-end",
                )}
              >
                {i === 0 || i === 6
                  ? fmt.dateShortSmartCalendar(day)
                  : i === GRID_DAYS - 1
                    ? t("medications.today")
                    : ""}
              </span>
            ))}
          </div>
          <ul
            className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs"
            aria-hidden="true"
            data-slot="medication-overview-legend"
          >
            {legend.map((item) => (
              <li key={item.tone} className="flex items-center gap-1.5">
                <span
                  className={cn("size-2.5 rounded-xs", CELL_CLASS[item.tone])}
                />
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </OverviewCard>
  );
}

function GridRow({
  label,
  labelled,
  days,
  tone,
}: {
  label: string;
  labelled: boolean;
  days: string[];
  tone: (day: string) => CellTone;
}) {
  return (
    <>
      {labelled && (
        <span
          aria-hidden="true"
          className="text-muted-foreground pr-1 text-xs tabular-nums"
        >
          {label}
        </span>
      )}
      {days.map((day) => {
        const value = tone(day);
        return (
          <span
            key={day}
            aria-hidden="true"
            data-tone={value}
            className={cn(
              "aspect-square max-h-5 w-full rounded-xs",
              CELL_CLASS[value],
            )}
          />
        );
      })}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Effect                                                                     */
/* -------------------------------------------------------------------------- */

export function EffectCard({
  query,
  mayRetarget,
  onRetarget,
  onDetails,
}: {
  query: {
    data: MedicationEfficacyDTO | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  mayRetarget: boolean;
  onRetarget: () => void;
  onDetails?: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const dto = query.data;
  const target =
    dto?.targets.find((candidate) => candidate.primary) ?? dto?.targets[0];
  const ba = target?.beforeAfter;
  const direction = target?.result?.direction ?? null;
  const DeltaIcon =
    direction === "lower"
      ? ArrowDown
      : direction === "higher"
        ? ArrowUp
        : Minus;
  const series = target?.series ?? [];

  return (
    <OverviewCard
      icon={TrendingUp}
      title={t("medications.efficacy.title")}
      chip={target?.label}
      sentence={
        query.isLoading
          ? null
          : (target?.result?.text ?? t("medications.efficacy.noSeries"))
      }
      slot="medication-overview-effect"
      actions={
        <ActionPair
          secondary={
            mayRetarget ? (
              <Button
                variant="outline"
                className={PAIR_BUTTON}
                onClick={onRetarget}
                data-slot="medication-overview-effect-retarget"
              >
                {t("medications.detail.overview.changeMetric")}
              </Button>
            ) : undefined
          }
          primary={
            onDetails ? (
              <Button
                className={PAIR_BUTTON}
                onClick={onDetails}
                data-slot="medication-overview-effect-details"
              >
                {t("medications.detail.overview.details")}
              </Button>
            ) : (
              <span aria-hidden="true" />
            )
          }
        />
      }
    >
      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : query.isError ? (
        <QueryErrorRow
          inset
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {ba?.present && ba.before && ba.after && ba.delta && (
            <p
              className="flex items-baseline gap-2"
              data-slot="medication-overview-effect-values"
            >
              <span className="text-foreground text-3xl font-semibold tabular-nums">
                {fmt.number(ba.before.mean)}
              </span>
              <ArrowRight
                aria-label={t("medications.detail.overview.since")}
                className="text-muted-foreground size-4 self-center"
              />
              <span className="text-foreground text-3xl font-semibold tabular-nums">
                {fmt.number(ba.after.mean)}
              </span>
              {target?.unit && (
                <span className="text-muted-foreground text-sm">
                  {target.unit}
                </span>
              )}
              <span className="text-foreground ml-auto inline-flex items-center gap-0.5 text-sm tabular-nums">
                <DeltaIcon aria-hidden="true" className="size-4" />
                {fmt.number(Math.abs(ba.delta.mean))}
              </span>
            </p>
          )}
          {series.length > 1 && target && (
            <div className="space-y-1">
              <EfficacySparkline
                series={series}
                startAt={dto?.markers.start ?? null}
                beforeMean={ba?.before?.mean ?? null}
                afterMean={ba?.after?.mean ?? null}
                label={target.label}
              />
              <div
                aria-hidden="true"
                className="text-muted-foreground flex justify-between gap-2 text-xs tabular-nums"
              >
                <span>{fmt.dateShortSmart(series[0].t)}</span>
                {dto?.markers.start &&
                  Date.parse(dto.markers.start) >= Date.parse(series[0].t) && (
                    <span>
                      {t("medications.efficacy.startMarker")}{" "}
                      {fmt.dateShortSmartCalendar(dto.markers.start)}
                    </span>
                  )}
                <span>{fmt.dateShortSmart(series[series.length - 1].t)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </OverviewCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

/** One plan row: the name left, the value right, a rule between rows. */
const PLAN_ROW =
  "border-border/60 flex min-h-11 items-start justify-between gap-4 border-b py-2.5 text-sm last:border-b-0 md:[&:nth-last-child(2):nth-child(odd)]:border-b-0";

export function PlanCard({
  medication,
  payload,
  recordOnly,
  asNeeded,
  oneShot,
  onEdit,
}: {
  medication: MedicationDetailSnapshot;
  payload: MedicationPayload;
  recordOnly: boolean;
  asNeeded: boolean;
  oneShot: boolean;
  onEdit?: () => void;
}) {
  const { t, locale } = useTranslations();
  const dateFormatPref = useDateFormatPreference();
  const { canManageDomain } = useRecordCapabilities();
  const cadence = useCadenceLine({
    payload,
    oneShot,
    asNeeded,
    startsOn: medication.startsOn,
  });
  const id = medication.id;

  // The supply tab's read and cache cell; the row shows once items exist.
  const { data: inventory } = useQuery({
    queryKey: queryKeys.medicationInventory(id),
    queryFn: () =>
      apiGet<{
        items: Array<{ state: string }>;
        summary?: SupplySummary;
      } | null>(`/api/medications/${id}/inventory`),
    enabled: canManageDomain("medications"),
    staleTime: 30_000,
  });
  const hasSupply =
    Array.isArray(inventory?.items) && inventory.items.length > 0;
  const summary = inventory?.summary;
  const runway = medication.runwayDays ?? null;

  const calendar = (iso: string) =>
    formatCalendarDate(new Date(iso), dateFormatPref, locale);
  const period = medication.startsOn
    ? medication.endsOn
      ? t("medications.detail.overview.plan.range", {
          start: calendar(medication.startsOn),
          end: calendar(medication.endsOn),
        })
      : t("medications.detail.overview.plan.since", {
          date: calendar(medication.startsOn),
        })
    : null;
  const grace = medication.schedules[0]?.reminderGraceMinutes ?? 30;
  const reminder =
    asNeeded || recordOnly
      ? null
      : medication.autoMarkTaken
        ? t("medications.detail.overview.plan.autoRecorded")
        : medication.notificationsEnabled
          ? t("medications.detail.overview.plan.reminderOn", {
              minutes: grace,
            })
          : t("medications.detail.uebersicht.reminderOff");

  const rows: { key: string; label: string; value: ReactNode }[] = [
    {
      key: "intake",
      label: t("medications.detail.overview.intake.title"),
      value: cadence,
    },
    ...(period
      ? [
          {
            key: "period",
            label: t("medications.detail.settingsTab.groups.period"),
            value: period,
          },
        ]
      : []),
    ...(reminder
      ? [
          {
            key: "reminder",
            label: t("medications.detail.uebersicht.reminderLabel"),
            value: reminder,
          },
        ]
      : []),
    ...(hasSupply && summary
      ? [
          {
            key: "supply",
            label: t("medications.detail.uebersicht.supplyLabel"),
            value:
              runway !== null
                ? `${t("medications.detail.bestand.summary", {
                    remaining: summary.dosesRemaining,
                    total: summary.dosesTotal,
                  })}, ${t("medications.detail.uebersicht.supplyRunway", {
                    days: runway,
                  })}`
                : t("medications.detail.bestand.summary", {
                    remaining: summary.dosesRemaining,
                    total: summary.dosesTotal,
                  }),
          },
        ]
      : []),
    ...(medication.note
      ? [
          {
            key: "note",
            label: t("common.note"),
            value: (
              <span
                className="whitespace-pre-line"
                data-slot="medication-detail-note"
              >
                {medication.note}
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card data-slot="medication-overview-plan">
      <CardHeader>
        <TileHeader
          icon={Clock}
          title={t("medications.detail.overview.plan.title")}
          titleAs="h2"
          right={
            onEdit ? (
              <InlineAction
                onClick={onEdit}
                data-slot="medication-overview-plan-edit"
              >
                {t("common.edit")}
              </InlineAction>
            ) : null
          }
        />
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 md:grid-cols-2">
          {rows.map((row) => (
            <div
              key={row.key}
              className={PLAN_ROW}
              data-slot={`medication-overview-plan-${row.key}`}
            >
              <dt className="text-muted-foreground shrink-0">{row.label}</dt>
              <dd className="text-foreground min-w-0 text-right">
                {row.value}
              </dd>
            </div>
          ))}
          <MedicationLeafletRow medication={medication} className={PLAN_ROW} />
        </dl>
      </CardContent>
    </Card>
  );
}
