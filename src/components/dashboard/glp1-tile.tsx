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
import { useMemo } from "react";
import { Syringe, ArrowDown, ArrowUp, Minus, Calendar } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false },
);

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
        // A faint green seam on the left edge so the tile reads as
        // "active therapy" at a glance without needing to read the
        // header. The same green is used for the injection-day markers
        // below — visual consistency across the tile.
        "border-l-dracula-green/60 border-l-2",
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

      <dl className="text-muted-foreground grid grid-cols-1 gap-y-1 pb-3 text-xs sm:grid-cols-2 sm:gap-x-4">
        {med.lastInjection && (
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3 w-3 shrink-0" aria-hidden="true" />
            <dt className="font-medium">
              {t("dashboard.glp1.lastInjection")}:
            </dt>
            <dd
              data-slot="glp1-tile-last"
              className="text-foreground tabular-nums"
            >
              {dateWithWeekday(med.lastInjection.date)}
            </dd>
          </div>
        )}
        {med.nextInjection && (
          <div className="flex items-center gap-1.5">
            <Syringe className="h-3 w-3 shrink-0" aria-hidden="true" />
            <dt className="font-medium">
              {t("dashboard.glp1.nextInjection")}:
            </dt>
            <dd
              data-slot="glp1-tile-next"
              className="text-foreground tabular-nums"
            >
              {dateWithWeekday(med.nextInjection.date)}
              <span className="text-muted-foreground ml-1">
                (
                {t("dashboard.glp1.inDays", {
                  count: med.nextInjection.daysAway,
                })}
                )
              </span>
            </dd>
          </div>
        )}
      </dl>

      {/* Compact weight chart with the vertical injection-day markers
          the v1.4.25 W6 chart-extension adds. Skipped when we have no
          weight readings since the GLP-1 was started — the empty
          chart would draw nothing useful. */}
      {med.weightSeries.length > 0 && (
        <div data-slot="glp1-tile-chart">
          <HealthChart
            mini
            types={["WEIGHT"]}
            title={t("dashboard.weight")}
            colors={["#bd93f9"]}
            unit="kg"
            verticalMarkers={med.injectionDates.map((date) => ({ date }))}
            userTimezone={user?.timezone}
          />
        </div>
      )}
    </div>
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
