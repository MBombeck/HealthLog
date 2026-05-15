"use client";

/**
 * v1.4.25 W19c-Frontend — Estimated drug-level chart for GLP-1
 * medications. Opt-in behind Research Mode (the acknowledgment dialog
 * in this directory gates entry); even when enabled the chart paints
 * "Estimated level (relative)" on the y-axis without tick labels —
 * research §2.3 + W19c-Backend phase report carry the rationale.
 *
 * Inputs (read-only):
 *   - Drug id resolved from the medication name (catalog lookup via
 *     `findDrugByBrand`); falls back to a gated message when the
 *     medication isn't in the GLP-1 catalog.
 *   - Intake events from `GET /api/medications/[id]/intake` — only
 *     non-skipped events with a `takenAt` contribute.
 *   - Dose history from `GET /api/medications/[id]/glp1` (the
 *     `doseChanges` slice). Each intake event is matched to its
 *     applicable dose by walking the dose-change timeline; intakes
 *     that pre-date every dose-change row fall back to the
 *     medication's headline dose string.
 *   - Research-mode state from `GET /api/auth/me/research-mode`. The
 *     chart gates on `enabled === true && acknowledgedVersion ===
 *     currentDisclaimerVersion` — defence-in-depth alongside the
 *     server-side 400 the POST returns for stale versions.
 *
 * Pure math: `computeOneCompartment(drug, doses, asOf)` from
 * `glp1-pk.ts`. The chart renders a 21-day window so three weekly
 * cycles are visible, anchored at "now". Mobile-first ResponsiveContainer,
 * Dracula tokens that match the rest of the chart suite.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Loader2,
  Syringe,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  computeOneCompartment,
  type DoseEvent,
} from "@/lib/medications/glp1-pk";
import {
  findDrugIdByBrand,
  type Glp1DrugId,
} from "@/lib/medications/glp1-knowledge";
import { parseDoseMg } from "@/lib/medications/dose-string";
import type { ResearchModeStatus } from "@/lib/medications/research-mode-types";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";

const CHART_COLOR = "var(--dracula-purple)";
const CHART_FILL_OPACITY = 0.18;
const HOURS_PER_DAY = 24;
/** 21 days back, 0 days forward — three weekly cycles of history with
 *  "now" at the right edge. Matches research §2.4's recommendation
 *  for a research-view chart that emphasises the sawtooth shape. */
const WINDOW_HOURS_BEFORE = 21 * HOURS_PER_DAY;
const WINDOW_HOURS_AFTER = 0;

interface IntakeEvent {
  id: string;
  takenAt: string | null;
  skipped: boolean;
  scheduledFor: string;
}

interface DoseChange {
  id: string;
  effectiveFrom: string;
  doseValue: number;
  doseUnit: string;
}

interface Glp1DetailsResponse {
  doseChanges: DoseChange[];
}

export interface DrugLevelChartProps {
  /**
   * Medication row (already known to be GLP-1 by the parent — typically
   * because `treatmentClass === "GLP1"`). The component resolves the
   * Glp1DrugId via the brand catalog; if the brand isn't recognised
   * the chart renders an empty-state hint instead of throwing.
   */
  medication: {
    id: string;
    /** Human-readable brand or generic name (e.g. "Mounjaro"). */
    name: string;
    /** Headline dose string ("7.5 mg") used as a fallback when no
     *  per-event dose-change row covers the intake's takenAt. */
    dose: string;
  };
  /**
   * Override "now" for deterministic snapshot tests. Defaults to a
   * fresh `Date()` at render time. The chart re-anchors on every
   * render, but the underlying React Query data keeps the network
   * cost low.
   */
  asOf?: Date;
  /**
   * v1.4.27 B1 — compact rendering for tile-internal mounts (the GLP-1
   * dashboard tile carves out a mini pane for this chart). When set:
   *   - the outer `<section class="bg-card …">` wrapper drops so the
   *     parent tile owns the card surface (no card-inside-a-card).
   *   - the chart body shrinks (160 px instead of 240 px) to match
   *     mini-mode density of the other tile-internal charts.
   *   - the header + disclaimer collapse to a single inline caption.
   */
  compact?: boolean;
  /**
   * v1.4.27 B1 — window length override (in hours of history before
   * `asOf`). Defaults to 21 × 24 = 504 h (three weekly cycles), the
   * shape the standalone surface ships. The dashboard mini-chart
   * exposes 7d / 30d / 90d / All via a range strip and threads the
   * mapped window length through this prop. The sample step scales
   * with the window so an "All"-mode chart doesn't paint thousands of
   * points: 6 h / 12 h / 24 h / 48 h for ≤ 21 d / ≤ 60 d / ≤ 180 d / >.
   */
  windowHoursBefore?: number;
}

export function DrugLevelChart({
  medication,
  asOf,
  compact = false,
  windowHoursBefore,
}: DrugLevelChartProps) {
  const { t } = useTranslations();

  // Resolve the catalog key via the shared helper. v1.4.25 W21 Fix-N
  // hoisted `findDrugIdByBrand` so this chart and the titration route
  // share one implementation.
  const drugId: Glp1DrugId | null = useMemo(
    () => findDrugIdByBrand(medication.name),
    [medication.name],
  );

  const { data: researchMode, isLoading: rmLoading } =
    useQuery<ResearchModeStatus | null>({
      queryKey: ["research-mode"],
      queryFn: async () => {
        const res = await fetch("/api/auth/me/research-mode");
        if (!res.ok) return null;
        const json = await res.json();
        return json.data as ResearchModeStatus;
      },
      staleTime: 60 * 1000,
    });

  const versionsAligned =
    !!researchMode &&
    researchMode.acknowledgedVersion === researchMode.currentDisclaimerVersion;
  const gateOpen = !!researchMode?.enabled && versionsAligned;

  const { data: details, isLoading: detailsLoading } =
    useQuery<Glp1DetailsResponse | null>({
      queryKey: ["medications", medication.id, "glp1-details"],
      queryFn: async () => {
        const res = await fetch(`/api/medications/${medication.id}/glp1`);
        if (!res.ok) return null;
        const json = await res.json();
        return json.data as Glp1DetailsResponse;
      },
      // Only fetch when the user has opted in; saves a round-trip for
      // anyone who hasn't enabled Research Mode.
      enabled: gateOpen && !!drugId,
      staleTime: 60 * 1000,
    });

  const { data: intakeEnvelope, isLoading: intakeLoading } = useQuery({
    queryKey: ["medications", medication.id, "intake", "drug-level-chart"],
    queryFn: async () => {
      const res = await fetch(
        `/api/medications/${medication.id}/intake?limit=20&sortBy=takenAt&sortDir=desc`,
      );
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as { events: IntakeEvent[] };
    },
    enabled: gateOpen && !!drugId,
    staleTime: 60 * 1000,
  });

  // Resolve "now" once per render — the asOf override is the only
  // safe way to pin the curve for snapshot tests.
  const now = useMemo(() => asOf ?? new Date(), [asOf]);

  const doses = useMemo<DoseEvent[]>(() => {
    if (!drugId || !intakeEnvelope?.events) return [];
    const dchg = details?.doseChanges ?? [];
    const fallbackMg = parseDoseMg(medication.dose);
    return intakeEnvelope.events
      .filter((ev) => !ev.skipped && ev.takenAt)
      .map((ev) => ({
        takenAt: new Date(ev.takenAt as string),
        doseMg: resolveDoseMg(ev.takenAt as string, dchg, fallbackMg),
      }))
      .filter((d) => Number.isFinite(d.doseMg) && d.doseMg > 0);
  }, [drugId, intakeEnvelope, details, medication.dose]);

  // ── Section header always renders so the parent's "Estimated drug
  //    level" anchor stays stable; the body switches between gated /
  //    loading / empty / chart states.
  const isLoading = rmLoading || (gateOpen && (detailsLoading || intakeLoading));
  const hasDoses = doses.length > 0;
  const animationsEnabled = !prefersReducedMotion();
  // Resolve the window length once, then derive a sample step that
  // keeps the AreaChart inside a sensible point count even on the
  // "All" branch of the dashboard's range strip.
  const resolvedWindowHours = windowHoursBefore ?? WINDOW_HOURS_BEFORE;
  const resolvedStepHours = pickSampleStepHours(resolvedWindowHours);
  const chartBodyHeightPx = compact ? 160 : 240;

  // Compact mode mounts the chart inside a host card (the GLP-1 tile)
  // and skips the outer `<section>` wrapper so the user doesn't see a
  // card painted inside a card. The disclaimer also collapses to a
  // single muted line to keep the tile's vertical footprint tight.
  // v1.4.27 MB7 / CF-66 — drop the `md:p-6` lift so the wrapper
  // stays at the `p-4` density across viewports. The 6 unit padding
  // on `md+` made the GLP-1 tile feel oversized relative to the
  // neighbouring trend cards, which all use `p-4`. Compact mode
  // retains the `space-y-2` layout without an outer card wrapper.
  const wrapperClass = compact
    ? "space-y-2"
    : "bg-card border-border rounded-xl border p-4";
  const wrapperProps = {
    "aria-labelledby": "drug-level-chart-title",
    className: wrapperClass,
    "data-slot": "drug-level-chart",
    "data-compact": compact ? "true" : undefined,
  } as const;
  const body = (
    <>
      {!compact && (
        <header className="mb-3 flex flex-wrap items-center gap-2">
          <Activity className="text-dracula-purple h-4 w-4 shrink-0" />
          <h3 id="drug-level-chart-title" className="text-sm font-semibold">
            {t("medications.researchMode.chart.title")}
          </h3>
          {drugId && (
            <span className="text-muted-foreground text-xs">
              · {t(`medications.glp1.drug.${drugId}.name`)}
            </span>
          )}
        </header>
      )}
      {compact && (
        <h3 id="drug-level-chart-title" className="sr-only">
          {t("medications.researchMode.chart.title")}
        </h3>
      )}

      {/* Decision tree:
            1. drug not in catalog       → gated-unknown-drug placeholder
            2. !researchMode.enabled OR  → gated placeholder + Settings CTA
               versions !== aligned         (the defence-in-depth rule)
            3. loading                   → skeleton
            4. no intake events          → empty-state with log CTA
            5. otherwise                 → AreaChart */}
      {!drugId ? (
        <GatedUnknownDrug medicationName={medication.name} />
      ) : !gateOpen ? (
        <GatedPlaceholder
          versionsAligned={versionsAligned}
          knownState={researchMode}
        />
      ) : isLoading ? (
        <div
          className={
            compact
              ? "flex h-[160px] items-center justify-center"
              : "flex h-[220px] items-center justify-center"
          }
          data-slot="drug-level-chart-loading"
        >
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !hasDoses ? (
        <EmptyState />
      ) : (
        <ChartBody
          drug={drugId}
          doses={doses}
          asOf={now}
          animationsEnabled={animationsEnabled}
          axisLabel={t("medications.researchMode.chart.axisLabel")}
          windowHoursBefore={resolvedWindowHours}
          stepHours={resolvedStepHours}
          heightPx={chartBodyHeightPx}
        />
      )}

      {gateOpen && hasDoses && (
        <p
          className={
            compact
              ? "text-muted-foreground text-[10px] leading-snug italic"
              : "text-muted-foreground mt-2 text-xs italic"
          }
          data-slot="drug-level-chart-disclaimer"
        >
          {t("medications.researchMode.chart.estimateNote")}
        </p>
      )}
    </>
  );

  return compact ? <div {...wrapperProps}>{body}</div> : <section {...wrapperProps}>{body}</section>;
}

/**
 * v1.4.27 B1 — pick a sample step in hours appropriate for the chosen
 * window length. The default 6 h is fine at ≤ 21 days (≤ 84 samples);
 * "All"-mode windows need a coarser grid so the AreaChart stays under
 * a few hundred points. The chart is qualitative (research §2.3) so a
 * coarse step does not change the rising/peak/fading shape.
 */
function pickSampleStepHours(windowHoursBefore: number): number {
  const days = windowHoursBefore / 24;
  if (days <= 21) return 6;
  if (days <= 60) return 12;
  if (days <= 180) return 24;
  return 48;
}

/* ────────────────────────────────────────────────────────────────
 * Body sub-components — pulled out so the tests can pin the gated
 * branches without rendering the Recharts tree (Recharts in SSR is
 * already exercised by the dashboard chart tests).
 * ──────────────────────────────────────────────────────────────── */

function GatedUnknownDrug({ medicationName }: { medicationName: string }) {
  const { t } = useTranslations();
  return (
    <div
      className="text-muted-foreground bg-muted/40 rounded-md p-4 text-sm"
      data-slot="drug-level-chart-unknown-drug"
    >
      <p>
        {t("medications.researchMode.chart.unknownDrug", {
          name: medicationName,
        })}
      </p>
    </div>
  );
}

function GatedPlaceholder({
  versionsAligned,
  knownState,
}: {
  versionsAligned: boolean;
  knownState: ResearchModeStatus | null | undefined;
}) {
  const { t } = useTranslations();
  // Three distinguishable states:
  //   - Research Mode is off entirely.
  //   - Research Mode is on but the acknowledged version is stale.
  //   - We don't know yet (server returned null) — still render the
  //     opt-in CTA so the user has a path forward.
  const stale = !!knownState?.enabled && !versionsAligned;
  return (
    <div
      className="bg-muted/40 border-border space-y-3 rounded-md border p-4 text-sm"
      data-slot="drug-level-chart-gated"
      data-stale={stale ? "true" : "false"}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="text-warning mt-0.5 h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <p className="text-foreground font-medium">
            {stale
              ? t("medications.researchMode.chart.gatedStaleTitle")
              : t("medications.researchMode.chart.gatedTitle")}
          </p>
          <p className="text-muted-foreground">
            {stale
              ? t("medications.researchMode.chart.gatedStaleBody")
              : t("medications.researchMode.chart.gatedBody")}
          </p>
        </div>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/settings/advanced">
          {t("medications.researchMode.chart.gatedCta")}
        </Link>
      </Button>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslations();
  return (
    <div
      className="text-muted-foreground bg-muted/40 flex flex-col items-start gap-2 rounded-md p-4 text-sm"
      data-slot="drug-level-chart-empty"
    >
      <div className="flex items-center gap-2">
        <Syringe className="h-4 w-4 shrink-0" aria-hidden="true" />
        <p>{t("medications.researchMode.chart.emptyState")}</p>
      </div>
      <p className="text-xs italic">
        {t("medications.researchMode.chart.emptyStateCta")}
      </p>
    </div>
  );
}

function ChartBody({
  drug,
  doses,
  asOf,
  animationsEnabled,
  axisLabel,
  windowHoursBefore,
  stepHours,
  heightPx,
}: {
  drug: Glp1DrugId;
  doses: readonly DoseEvent[];
  asOf: Date;
  animationsEnabled: boolean;
  /**
   * Y-axis caption — research §2.3 requires "Estimated level (relative)"
   * with NO unit. Rendered both as the Recharts axis label (in the SVG)
   * and as a small visible caption above the chart so screen-reader
   * users and SSR snapshots both surface the framing.
   */
  axisLabel: string;
  /** Window length in hours; the chart's x-axis domain is `[-days, 0]`. */
  windowHoursBefore: number;
  /** Sample step in hours; scales with the window length. */
  stepHours: number;
  /** Chart-area height in CSS pixels; compact mode passes 160. */
  heightPx: number;
}) {
  const windowDays = windowHoursBefore / HOURS_PER_DAY;
  const samples = useMemo(
    () =>
      computeOneCompartment(drug, doses, asOf, {
        windowHoursBefore,
        windowHoursAfter: WINDOW_HOURS_AFTER,
        stepHours,
      }),
    [drug, doses, asOf, windowHoursBefore, stepHours],
  );

  // Map samples to chart points. x-axis is "days since now" — negative
  // values for the past window, with 0 = now. Recharts uses the raw
  // domain so categorical day labels don't crowd the visible range.
  const chartData = useMemo(
    () =>
      samples.map((s) => ({
        dayOffset: Math.round((s.tHours / HOURS_PER_DAY) * 10) / 10,
        level: s.concentration,
      })),
    [samples],
  );

  // Pick four x-axis ticks evenly across the window so the strip
  // reads as quarter / midpoint / three-quarter / now regardless of
  // whether the user picked 7d, 30d, 90d, or All.
  const ticks = useMemo(() => {
    const quarter = -Math.round(windowDays * 0.75);
    const midpoint = -Math.round(windowDays * 0.5);
    const lastQuarter = -Math.round(windowDays * 0.25);
    return [-Math.round(windowDays), quarter, midpoint, lastQuarter, 0];
  }, [windowDays]);

  return (
    <>
      <p
        className="text-muted-foreground mb-1 text-xs"
        data-slot="drug-level-chart-axis-caption"
      >
        {axisLabel}
      </p>
      <div
        className="touch-pan-y"
        style={{ height: `${heightPx}px` }}
        data-slot="drug-level-chart-area"
      >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 12, bottom: 16, left: 8 }}
        >
          <defs>
            <linearGradient
              id="drug-level-gradient"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor={CHART_COLOR}
                stopOpacity={CHART_FILL_OPACITY * 1.4}
              />
              <stop
                offset="100%"
                stopColor={CHART_COLOR}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.5}
          />
          {/* v1.4.27 MB6 CF-16 — dropped a stray empty `<text>` child
              that previously declared no content and rendered an
              invisible SVG node beneath the x-axis. */}
          <XAxis
            dataKey="dayOffset"
            type="number"
            domain={[-windowDays, 0]}
            ticks={ticks}
            tickFormatter={(v) => (v === 0 ? "0" : `${v}d`)}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          {/* Research §2.3 — y-axis is unit-less. We hide tick labels
              and the axis line entirely; the human-readable label sits
              outside the chart frame, above. The `tick={false}` flag
              suppresses the textual ticks per Recharts. v1.4.27 MB6
              CF-16 — the duplicate Recharts `label={…}` prop dropped
              here painted the same caption inside the SVG behind the
              `width={1}` axis, where it could never be read. The
              external `<p>` above the chart is the single source of
              truth for the caption. */}
          <YAxis
            domain={[0, "auto"]}
            tick={false}
            tickLine={false}
            axisLine={false}
            width={1}
          />
          <Tooltip
            content={() => null}
            cursor={{
              stroke: "var(--muted-foreground)",
              strokeOpacity: 0.3,
              strokeDasharray: "3 3",
            }}
          />
          <Area
            type="monotone"
            dataKey="level"
            stroke={CHART_COLOR}
            strokeWidth={2}
            fill="url(#drug-level-gradient)"
            isAnimationActive={animationsEnabled}
            animationDuration={animationsEnabled ? 600 : 0}
            animationEasing="ease-out"
          />
        </AreaChart>
      </ResponsiveContainer>
      </div>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Pure helpers — dose-mg resolution from the medication's dose
 * string and the dose-change timeline.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Re-export the shared parser so the component-test file
 * (which historically imported `parseDoseMg` from this surface)
 * keeps working without coupling to the helper module path. v1.4.25
 * W21 Fix-N — single implementation now lives in
 * `src/lib/medications/dose-string.ts`.
 */
export { parseDoseMg };

/**
 * Resolve the dose in mg that applied at `takenAt` by walking the
 * dose-change history. The catalog row with the latest
 * `effectiveFrom ≤ takenAt` wins; intakes before any row fall back
 * to the medication's headline `dose` string.
 *
 * Exported for the unit test.
 */
export function resolveDoseMg(
  takenAtIso: string,
  doseChanges: readonly DoseChange[],
  fallbackMg: number,
): number {
  const takenAtMs = Date.parse(takenAtIso);
  if (!Number.isFinite(takenAtMs)) return fallbackMg;
  let bestValue = fallbackMg;
  let bestStart = -Infinity;
  for (const change of doseChanges) {
    const startMs = Date.parse(change.effectiveFrom);
    if (!Number.isFinite(startMs)) continue;
    if (startMs <= takenAtMs && startMs > bestStart) {
      bestStart = startMs;
      bestValue = change.doseValue;
    }
  }
  return bestValue;
}
