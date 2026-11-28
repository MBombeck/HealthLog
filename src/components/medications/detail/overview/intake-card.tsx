"use client";

/**
 * The overview's "Intake" card: the server's adherence over its long
 * window, one sentence about the misses, a dose grid of the last 14 days (a
 * row per dose time, a column per day) with its legend, and Log past dose /
 * History. The grid and the legend are the dose-history ledger's rows as the
 * server resolved them; the rate is the compliance read's, through
 * `shownAdherence`, so a window with nothing to score shows no figure.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck } from "lucide-react";

import { ActionPair } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  groupLedgerByDay,
  type LedgerPayload,
  type LedgerRow,
} from "@/components/medications/dose-history-ledger-compute";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { shownAdherence } from "@/lib/medications/shown-adherence";
import { queryKeys } from "@/lib/query-keys";
import { dateOnlyAtNoonUtc, dateOnlyKey } from "@/lib/tz/date-only";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { cn } from "@/lib/utils";

import { OverviewCard, type OverviewCompliance } from "./anatomy";

/** Days the intake grid spans: today and the thirteen before it. */
export const GRID_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The ledger over the grid's window, grouped by the person's day. */
export function useOverviewLedger(medicationId: string) {
  const { user } = useAuth();
  const timeZone = user?.timezone || DEFAULT_TIMEZONE;
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

type CellTone = "taken" | "late" | "missed" | "skipped" | "open" | "none";

const TONE_OF_STATUS: Record<LedgerRow["status"], CellTone> = {
  taken_on_time: "taken",
  taken_late: "late",
  missed: "missed",
  skipped: "skipped",
  upcoming: "open",
  ad_hoc: "taken",
};

const CELL_CLASS: Record<CellTone, string> = {
  taken: "bg-success/70",
  late: "bg-warning/70",
  missed: "border-destructive border-2",
  skipped: "bg-muted-foreground/40",
  open: "border-border border",
  none: "",
};

interface GridRowData {
  label: string;
  tone: (day: string) => CellTone;
}

/** The grid's rows, one per dose time; one row of takes when there are none. */
function gridRowsOf(
  byDay: Map<string, LedgerRow[]>,
  days: string[],
  asNeeded: boolean,
  wallTime: (hhmm: string) => string,
): GridRowData[] {
  const times = new Set<string>();
  for (const day of days) {
    for (const row of byDay.get(day) ?? []) {
      if (row.kind === "slot" && row.timeOfDay) times.add(row.timeOfDay);
    }
  }
  if (asNeeded || times.size === 0) {
    return [
      {
        label: "",
        tone: (day) =>
          (byDay.get(day) ?? []).some(
            (row) => row.kind === "ad_hoc" && row.intake?.takenAt,
          )
            ? "taken"
            : "open",
      },
    ];
  }
  return [...times].sort().map((time) => ({
    label: wallTime(time),
    tone: (day) => {
      const row = (byDay.get(day) ?? []).find(
        (r) => r.kind === "slot" && r.timeOfDay === time,
      );
      return row ? TONE_OF_STATUS[row.status] : "none";
    },
  }));
}

/** The grid's counts per tone: what the legend says. */
function countTones(byDay: Map<string, LedgerRow[]>, days: string[]) {
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
  return counts;
}

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
  const days = useMemo(() => gridDayKeys(todayKey), [todayKey]);
  const counts = countTones(byDay, days);
  const { rate30: rate, longDays: windowDays } = shownAdherence(compliance);
  const missed = compliance?.complianceDisplay?.long.missed ?? 0;
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
        : rate === null
          ? t("medications.detail.verlauf.summaryEmpty")
          : missed === 0
            ? t("medications.detail.overview.intake.missedNone", {
                days: windowDays,
              })
            : t("medications.detail.overview.intake.missedSome", {
                days: windowDays,
                count: missed,
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
          count: counts.taken,
          text: t("medications.detail.overview.legend.taken", {
            count: counts.taken,
          }),
        },
        {
          tone: "late" as const,
          count: counts.late,
          text: t("medications.detail.overview.legend.late", {
            count: counts.late,
          }),
        },
        {
          tone: "missed" as const,
          count: counts.missed,
          text: t("medications.detail.overview.legend.missed", {
            count: counts.missed,
          }),
        },
        {
          tone: "skipped" as const,
          count: counts.skipped,
          text: t("medications.detail.overview.legend.skipped", {
            count: counts.skipped,
          }),
        },
      ].filter((item) => item.tone === "taken" || item.count > 0);

  const showRate = !asNeeded && !notApplicable && !recordOnly && rate !== null;

  return (
    <OverviewCard
      icon={CalendarCheck}
      title={t("medications.detail.overview.intake.title")}
      // The sentence names its window when it has a rate or a count; the
      // chip names the grid's otherwise, never both.
      chip={
        showRate || asNeeded
          ? undefined
          : t("medications.detail.overview.daysChip", { days: GRID_DAYS })
      }
      sentence={sentence}
      slot="medication-overview-intake"
      actions={
        onBackfill || onHistory ? (
          <ActionPair pairClassName="w-full">
            {onBackfill ? (
              <Button
                variant="outline"
                onClick={onBackfill}
                data-slot="medication-overview-intake-backfill"
              >
                {t("medications.detail.verlauf.backfill")}
              </Button>
            ) : undefined}
            {onHistory ? (
              <Button
                variant="outline"
                onClick={onHistory}
                data-slot="medication-overview-intake-history"
              >
                {t("medications.detail.tabs.verlauf")}
              </Button>
            ) : null}
          </ActionPair>
        ) : undefined
      }
    >
      {showRate && (
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
        <DoseGrid
          rows={gridRowsOf(byDay, days, asNeeded, fmt.wallTime)}
          days={days}
          legend={legend}
        />
      )}
    </OverviewCard>
  );
}

/** The dose grid, its day axis and its legend. */
function DoseGrid({
  rows,
  days,
  legend,
}: {
  rows: GridRowData[];
  days: string[];
  legend: { tone: CellTone; text: string }[];
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const labelled = rows.some((row) => row.label !== "");
  return (
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
        {rows.map((row) => (
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
