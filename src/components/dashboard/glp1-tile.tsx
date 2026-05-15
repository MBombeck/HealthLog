"use client";

/**
 * v1.4.25 W6 — GLP-1 status tile.
 *
 * Renders only when the user has at least one active GLP-1 medication
 * (`Medication.treatmentClass = "GLP1"`). The tile shows:
 *   - drug name + current dose ("Mounjaro 7.5mg")
 *   - last injection date + weekday
 *   - next injection date + weekday + countdown
 *   - weight delta since starting the medication ("−4.2 kg seit Beginn")
 *   - a compact weight chart with vertical injection-day markers so the
 *     user sees the dose-response visually
 *
 * Self-hides when:
 *   - no GLP-1 medication is active (route returns `data: null`)
 *   - the fetch is still pending (renders a skinny skeleton so the
 *     dashboard layout doesn't jump)
 *   - the fetch errored (silently — the tile is enrichment, not a
 *     hard requirement, and the rest of the dashboard works without
 *     it)
 *
 * The chart lives INSIDE the tile per Marc's directive 2026-05-14:
 * "NO chart on the Medications page itself. The chart goes on the
 *  Dashboard tile and into the Insights /medikamente sub-page".
 */
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { Syringe, ArrowDown, ArrowUp, Minus, Calendar } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { CHART_RANGE_PRESETS } from "@/lib/charts/constants";

const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false },
);

const DrugLevelChart = dynamic(
  () =>
    import("@/components/medications/DrugLevelChart").then((mod) => ({
      default: mod.DrugLevelChart,
    })),
  { ssr: false },
);

/**
 * Map a `CHART_RANGE_PRESETS` `points` value to the drug-level chart's
 * window length in hours. `points: 0` (the "All" preset) maps to 365
 * days — past that point the unit-less curve flattens to invisibility,
 * so a year of history is the practical ceiling.
 */
const HOURS_PER_DAY = 24;
function rangePointsToHours(points: number): number {
  if (points === 0) return 365 * HOURS_PER_DAY;
  return points * HOURS_PER_DAY;
}

type Glp1ChartTab = "level" | "weight";

interface DoseHistoryEntry {
  value: number;
  unit: string;
  effectiveFrom: string;
  note: string | null;
}

interface CurrentDose {
  value: number;
  unit: string;
  since: string;
  weeksOnDose: number;
}

interface LastInjection {
  date: string;
  site: string | null;
  weeksAgo: number;
}

interface NextInjection {
  date: string;
  daysAway: number;
}

interface Glp1MedicationPayload {
  name: string;
  genericName: string;
  medicationId: string | null;
  currentDose: CurrentDose | null;
  doseHistory: DoseHistoryEntry[];
  lastInjection: LastInjection | null;
  nextInjection: NextInjection | null;
  startWeight: number | null;
  currentWeight: number | null;
  weightDeltaKg: number | null;
  weightSeries: Array<{ date: string; weight: number }>;
  injectionDates: string[];
}

interface Glp1Payload {
  active: boolean;
  medications: Glp1MedicationPayload[];
}

interface Glp1ApiResponse {
  data: Glp1Payload | null;
}

/**
 * Compose a single-line drug+dose caption ("Mounjaro 7.5mg"). The
 * route exposes the parsed dose value + unit on `currentDose` (from
 * `MedicationDoseChange` — the source of record). When the user
 * hasn't logged a titration history we fall back to the medication
 * name alone — better blank than wrong.
 */
function formatDrugAndDose(med: Glp1MedicationPayload): string {
  if (!med.currentDose) return med.name;
  const dose = `${med.currentDose.value}${med.currentDose.unit}`;
  return `${med.name} ${dose}`;
}

/**
 * Format a `YYYY-MM-DD` date string as "Mon 12 May" / "Mo, 12 Mai"
 * via the user's active locale formatters. The weekday is part of
 * the caption Marc asked for ("Last injection: <date> (<weekday>)").
 */
function useDateWithWeekday(): (iso: string) => string {
  const fmt = useFormatters();
  return useMemo(() => {
    return (iso: string) => {
      const d = new Date(`${iso}T12:00:00Z`);
      return fmt.dateWithWeekday(d);
    };
  }, [fmt]);
}

interface DeltaDisplay {
  text: string;
  icon: typeof ArrowDown;
  tone: "loss" | "gain" | "flat";
}

/**
 * The weight-delta caption ("−4.2 kg seit Beginn") is the headline
 * outcome of GLP-1 therapy. We carve it out as a small helper so the
 * sign formatting + icon choice stays in one place:
 *   - delta < 0  → loss (green arrow-down). The clinically desired
 *     direction for weight-management indications.
 *   - delta > 0  → gain (orange arrow-up). Not necessarily a bad
 *     outcome (e.g. recovering from underweight), so we use the
 *     muted warning palette instead of red.
 *   - delta ≈ 0 → flat (muted minus). Within ±0.1 kg counts as flat
 *     so the caption doesn't flicker on rounding noise.
 */
function useDeltaDisplay(): (deltaKg: number, suffix: string) => DeltaDisplay {
  const fmt = useFormatters();
  return useMemo(() => {
    return (deltaKg: number, suffix: string) => {
      const rounded = Math.round(deltaKg * 10) / 10;
      if (Math.abs(rounded) < 0.1) {
        return {
          text: `${fmt.number(0, 1)} kg ${suffix}`,
          icon: Minus,
          tone: "flat" as const,
        };
      }
      const sign = rounded > 0 ? "+" : "−";
      const display = `${sign}${fmt.number(Math.abs(rounded), 1)} kg ${suffix}`;
      return {
        text: display,
        icon: rounded < 0 ? ArrowDown : ArrowUp,
        tone: rounded < 0 ? ("loss" as const) : ("gain" as const),
      };
    };
  }, [fmt]);
}

export function Glp1Tile() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const dateWithWeekday = useDateWithWeekday();
  const deltaDisplay = useDeltaDisplay();

  // v1.4.27 B1 — the chart pane carries two views (drug-level / weight)
  // and a 7d / 30d / 90d / All range strip above. Drug-level is the
  // default because it's the more informative pane the maintainer
  // asked for; the weight pane stays one tap away. Both states live
  // on the tile so a parent re-render doesn't reset the user's pick.
  const [activeTab, setActiveTab] = useState<Glp1ChartTab>("level");
  const [rangePoints, setRangePoints] = useState<number>(30);

  const { data, isPending } = useQuery({
    queryKey: queryKeys.dashboardGlp1(),
    enabled: isAuthenticated,
    queryFn: async (): Promise<Glp1Payload | null> => {
      const res = await fetch("/api/dashboard/glp1");
      if (!res.ok) throw new Error("glp1 fetch failed");
      const body = (await res.json()) as Glp1ApiResponse;
      return body.data;
    },
    // Conservative — the tile reads cheap server-side aggregates so
    // an aggressive stale-time would mask a fresh injection logged
    // a few minutes earlier. 60 s mirrors the rest of the dashboard
    // query lifecycle.
    staleTime: 60_000,
  });

  // Self-hide everywhere except when we have an active payload.
  if (isPending && isAuthenticated) {
    return (
      <div
        data-slot="glp1-tile-skeleton"
        className="bg-card/65 rounded-xl border px-4 py-4 shadow-sm backdrop-blur-sm"
      >
        <div className="bg-muted/40 mb-3 h-4 w-24 animate-pulse rounded" />
        <div className="bg-muted/40 h-32 w-full animate-pulse rounded" />
      </div>
    );
  }

  if (!data || data.medications.length === 0) {
    return null;
  }

  // The brief mentions "renders ONLY when the user has at least one
  // active medication with category=GLP1". The route already gates on
  // `treatmentClass === "GLP1"` and `active === true`, so `data` here
  // is guaranteed to have at least one med. We render the FIRST med —
  // multiple concurrent GLP-1 prescriptions are clinically unusual; if
  // a future user has two, the Insights /medikamente sub-page will be
  // the place to see both side-by-side.
  const med = data.medications[0];
  const drugLine = formatDrugAndDose(med);

  return (
    <div
      data-slot="glp1-tile"
      data-medication-id={med.medicationId ?? ""}
      className={cn(
        "bg-card/65 relative overflow-hidden rounded-xl border px-4 py-4 shadow-sm backdrop-blur-sm",
        // v1.4.27 B1 — the green left-seam drops. The Syringe-icon in
        // the title row already carries the "active therapy" signal;
        // the seam was decoration without a semantic tie to the
        // schedule dates next to it. The schedule pill row below now
        // groups the two dates visually so the user reads them as one
        // cohesive unit.
      )}
    >
      <div className="flex items-center gap-2 pb-3">
        <Syringe className="text-dracula-green h-4 w-4" aria-hidden="true" />
        <h2
          data-slot="glp1-tile-title"
          className="text-foreground text-sm font-semibold tracking-tight"
        >
          {t("dashboard.glp1.title")}
        </h2>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-3">
        <span
          data-slot="glp1-tile-drug"
          className="text-foreground text-lg font-semibold tabular-nums"
        >
          {drugLine}
        </span>
        {med.weightDeltaKg !== null && (
          <DeltaCaption
            display={deltaDisplay(
              med.weightDeltaKg,
              t("dashboard.glp1.weightDelta"),
            )}
          />
        )}
      </div>

      {/* v1.4.27 B1 — schedule pill row promotes the two injection
          dates to a header band. Pills carry a soft dracula-green tint
          so the two dates read as one cohesive "therapy schedule"
          unit; the old <dl> grid + arbitrary green seam are gone. */}
      {(med.lastInjection || med.nextInjection) && (
        <div
          data-slot="glp1-tile-schedule"
          className="flex flex-wrap items-center gap-1.5 pb-3 text-xs"
        >
          {med.lastInjection && (
            <span
              data-slot="glp1-tile-last"
              className="border-dracula-green/30 bg-dracula-green/10 text-foreground inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 tabular-nums"
            >
              <Calendar
                className="text-dracula-green/80 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              <span className="text-muted-foreground font-medium">
                {t("dashboard.glp1.lastInjection")}:
              </span>
              <span>{dateWithWeekday(med.lastInjection.date)}</span>
            </span>
          )}
          {med.nextInjection && (
            <span
              data-slot="glp1-tile-next"
              className="border-dracula-green/30 bg-dracula-green/10 text-foreground inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 tabular-nums"
            >
              <Syringe
                className="text-dracula-green/80 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              <span className="text-muted-foreground font-medium">
                {t("dashboard.glp1.nextInjection")}:
              </span>
              <span>{dateWithWeekday(med.nextInjection.date)}</span>
              <span className="text-muted-foreground">
                ·{" "}
                {t("dashboard.glp1.inDays", {
                  count: med.nextInjection.daysAway,
                })}
              </span>
            </span>
          )}
        </div>
      )}

      {/* v1.4.27 B1 — chart pane carrying a two-tab segmented control
          (Drug-Level default / Weight) plus a 7d / 30d / 90d / All
          range strip above. Drug-Level reads the unit-less curve from
          `<DrugLevelChart compact …>` (Research Mode gating is owned
          by the chart itself); Weight retains the v1.4.25 W6 mini
          chart with vertical injection markers. */}
      <div data-slot="glp1-tile-chart" className="space-y-2 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            data-slot="glp1-tile-tabs"
            role="tablist"
            aria-label={t("dashboard.glp1.tabsAria")}
            className="bg-muted/40 inline-flex rounded-md p-0.5"
          >
            <TabButton
              active={activeTab === "level"}
              onClick={() => setActiveTab("level")}
              label={t("dashboard.glp1.tabLevel")}
              slot="glp1-tile-tab-level"
            />
            <TabButton
              active={activeTab === "weight"}
              onClick={() => setActiveTab("weight")}
              label={t("dashboard.glp1.tabWeight")}
              slot="glp1-tile-tab-weight"
            />
          </div>
          <div
            data-slot="glp1-tile-range-strip"
            role="radiogroup"
            aria-label={t("dashboard.glp1.rangeStripLabel")}
            className="inline-flex items-center gap-1 text-[11px]"
          >
            {CHART_RANGE_PRESETS.map((preset) => (
              <button
                key={preset.points}
                type="button"
                role="radio"
                aria-checked={rangePoints === preset.points}
                data-slot="glp1-tile-range-button"
                data-points={preset.points}
                data-active={rangePoints === preset.points ? "true" : "false"}
                title={t(preset.titleKey)}
                onClick={() => setRangePoints(preset.points)}
                className={cn(
                  "inline-flex min-h-11 items-center justify-center rounded px-3 font-medium tabular-nums",
                  "hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
                  rangePoints === preset.points
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground",
                )}
              >
                {t(preset.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {activeTab === "level" && med.medicationId ? (
          <DrugLevelChart
            compact
            medication={{
              id: med.medicationId,
              name: med.name,
              dose: med.currentDose
                ? `${med.currentDose.value}${med.currentDose.unit}`
                : "",
            }}
            windowHoursBefore={rangePointsToHours(rangePoints)}
          />
        ) : activeTab === "level" ? (
          <p
            data-slot="glp1-tile-level-unavailable"
            className="text-muted-foreground bg-muted/40 rounded-md p-3 text-xs"
          >
            {t("dashboard.glp1.levelUnavailable")}
          </p>
        ) : med.weightSeries.length > 0 ? (
          <HealthChart
            mini
            types={["WEIGHT"]}
            title={t("dashboard.weight")}
            colors={["#bd93f9"]}
            unit="kg"
            verticalMarkers={med.injectionDates.map((date) => ({ date }))}
            userTimezone={user?.timezone}
          />
        ) : (
          <p
            data-slot="glp1-tile-weight-unavailable"
            className="text-muted-foreground bg-muted/40 rounded-md p-3 text-xs"
          >
            {t("dashboard.glp1.weightUnavailable")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * v1.4.27 B1 — small segmented-control button used by the tile's
 * tab strip. Carved into its own component so the active/inactive
 * styling lives in one place and the test can pin the data-slot
 * markers per tab.
 */
function TabButton({
  active,
  onClick,
  label,
  slot,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  slot: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-slot={slot}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded px-3 text-xs font-medium",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Carve the delta caption pill into its own component so the
 * loss/gain/flat tone selection is colocated with the rendering. The
 * pill itself is the small green/orange/muted chip that sits next to
 * the drug name on the second tile row.
 */
function DeltaCaption({ display }: { display: DeltaDisplay }) {
  const Icon = display.icon;
  const toneClass =
    display.tone === "loss"
      ? "bg-dracula-green/15 text-dracula-green"
      : display.tone === "gain"
        ? "bg-dracula-orange/15 text-dracula-orange"
        : "bg-muted/50 text-muted-foreground";
  return (
    <span
      data-slot="glp1-tile-delta"
      data-tone={display.tone}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        toneClass,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {display.text}
    </span>
  );
}
