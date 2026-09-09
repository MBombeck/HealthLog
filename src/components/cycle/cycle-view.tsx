"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Loader2, Plus, RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { CycleRing } from "./cycle-ring";
import { CycleCalendar } from "./cycle-calendar";
import { CycleHistoryChart } from "./cycle-history-chart";
import { LogDaySheet } from "./log-day-sheet";
import { PhaseEducationCard } from "./phase-education-card";
import { PredictionsPanel } from "./predictions-panel";
import { CyclePhaseHeadline, CyclePhaseCrosstab } from "./cycle-phase-crosstab";
import { CycleSymptomPatterns } from "./cycle-symptom-patterns";
import { CycleSettings } from "./cycle-settings";
import { PHASE_HUE } from "./phase-tokens";
import { monthOf, monthWindowOutside } from "./calendar-window";
import {
  localYmd,
  useCycleCalendar,
  useCycleHistory,
  useCycleInsights,
  useCycleProfile,
} from "./use-cycle";

/**
 * v1.15.0 — the cycle vertical's client orchestrator.
 *
 * Holds the four tabs (Calendar · Predictions · Insights · Settings), the
 * wheel above the tab strip, and the log-day sheet. The calendar read drives
 * the ring (day-of-cycle + phase), the grid, and the BBT chart; the
 * predictions read powers the panel; history powers the stats. The page-level
 * RSC has already gated on `cycleTrackingEnabled`.
 *
 * The wheel earns the once-per-session "signature reveal" (sweep + glow +
 * sheen + count-up): a `data-revealed` flag set on first visit drives the CSS
 * keyframes, gated by sessionStorage so a background calendar refetch never
 * re-triggers the moment.
 */

/** YYYY-MM-DD for `n` days from now in the local tz (shares `localYmd`). */
function shiftToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localYmd(d);
}

/** The four cycle tabs, in render order. The deep-link value is validated
 *  against this set so a junk `?tab=` falls back to the calendar tab. */
// The BBT chart is the only recharts consumer on /cycle — load it through
// the shared chart-runtime boundary so the route stops carrying its own
// copy of the recharts module graph. The loading shell mirrors the card
// the chart paints (header row + caption + 210 px chart band inside the
// standard card chrome) so the tab layout holds still while the shared
// chunk streams.
const BbtChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.BbtChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="bg-card border-border rounded-xl border py-6">
        <div className="px-6">
          <Skeleton className="h-5 w-44" />
        </div>
        <div className="mt-6 px-6">
          <Skeleton className="mb-2 h-4 w-64" />
          <Skeleton className="h-[210px] w-full rounded-md" />
        </div>
      </div>
    ),
  },
);

const CYCLE_TABS = ["calendar", "predictions", "insights", "settings"] as const;
type CycleTab = (typeof CYCLE_TABS)[number];

export function CycleView() {
  const { t } = useTranslations();
  // v1.36.x — no grant level admits a cycle write. Inside somebody else's
  // record the page stays readable and every path into the log-day sheet and
  // the profile settings is absent, rather than opening onto a refusal.
  const { canManageDomain } = useRecordCapabilities();
  const canManageCycle = canManageDomain("cycle");

  // Deep-link support: `/cycle?tab=insights` opens the insights tab. The value
  // is read ONCE for the initial `defaultValue` (uncontrolled tabs — so normal
  // clicking still works), validated against the known set, and falls back to
  // the calendar tab on anything else.
  const searchParams = useSearchParams();
  const initialTab: CycleTab = useMemo(() => {
    const raw = searchParams?.get("tab");
    return raw && (CYCLE_TABS as readonly string[]).includes(raw)
      ? (raw as CycleTab)
      : "calendar";
  }, [searchParams]);

  // Controlled tabs, initialised from the `?tab=` deep-link and matching the
  // prior uncontrolled `defaultValue` behaviour (the initial param is honoured;
  // a later param change does not force-switch a tab the user is reading).
  const [tab, setTab] = useState<CycleTab>(initialTab);

  const today = useMemo(() => shiftToday(0), []);
  const from = useMemo(() => shiftToday(-90), []);
  const to = useMemo(() => shiftToday(180), []);

  const calendar = useCycleCalendar(from, to);
  const history = useCycleHistory();
  const profileQuery = useCycleProfile();
  const insights = useCycleInsights();

  // The month grid navigates freely; the anchored read above does not follow
  // it, because every other surface on this page (the ring, the forecast panel,
  // the temperature chart) is about today and the route caps a span at 400
  // days. A month outside the anchor therefore gets its own bounded read, and
  // the two grids merge by date. Without it a back-dated entry landed on the
  // server and had nothing on screen to land in.
  const [visibleMonth, setVisibleMonth] = useState(() => monthOf(today));
  const monthWindow = useMemo(
    () => monthWindowOutside(visibleMonth, { from, to }),
    [visibleMonth, from, to],
  );
  const monthCalendar = useCycleCalendar(
    monthWindow?.from ?? from,
    monthWindow?.to ?? to,
    monthWindow !== null,
  );
  // Month days last: on the edge months the two reads overlap and the grid
  // keys by date, so the later entry wins and both carry the same answer.
  const calendarDays = useMemo(
    () => [...(calendar.data?.days ?? []), ...(monthCalendar.data?.days ?? [])],
    [calendar.data?.days, monthCalendar.data?.days],
  );

  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(today);

  // The signature reveal plays ONCE per browser session (mirrors the wellness
  // strip): a background calendar refetch after a quick-log would otherwise
  // replay the sweep/sheen and read as janky.
  const [play] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      if (sessionStorage.getItem("cycle-wheel-revealed")) return false;
      sessionStorage.setItem("cycle-wheel-revealed", "1");
      return true;
    } catch {
      return true;
    }
  });

  // The server's resolved verdict — cycle day, the ring's arcs, the overdue
  // judgement and its day count. Nothing on this page recomputes any of it.
  const verdict = calendar.data?.verdict;

  function openSheet(date: string) {
    setSelectedDate(date);
    setSheetOpen(true);
  }

  const loading = calendar.isLoading && !calendar.data;
  const calendarError = calendar.isError && !calendar.data;
  const tileHue = verdict?.phase ? PHASE_HUE[verdict.phase] : undefined;
  const goal = calendar.data?.profile.goal;
  // Honesty-gate inputs for the phase-education card (Clue precedent): the
  // predictive phase framing only shows when prediction is on, not in
  // raw-chart mode, and at least three cycles are observed.
  const calProfile = calendar.data?.profile;

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span data-tour-id="cycle-hero">{t("cycle.title")}</span>}
        description={t("cycle.subtitle")}
        actions={
          // One action. The settings glyph that used to sit beside it was a
          // second door to the tab directly below, and no other page in the
          // app carries a gear in that corner.
          canManageCycle ? (
            <Button
              onClick={() => openSheet(today)}
              className="min-h-11 sm:min-h-9"
            >
              <Plus className="h-4 w-4" />
              {t("cycle.logToday")}
            </Button>
          ) : null
        }
      />

      {/* Desktop: ring (left) + tabs (right). Single column below lg. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
        {/* Wheel + compact phase card — grouped so they stick together. The
            `lg:mt-15` (3.75rem) drops the column so the wheel tile's top edge
            lines up with the calendar / predictions content rather than the
            tab strip: TabsList `h-9` (2.25rem) + the Tabs root `gap-2` (0.5rem)
            + the content's `mt-4` (1rem). Below `lg` the column stacks first and
            the offset collapses to zero. */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:mt-15">
          {/* Wheel — the signature ring on the premium wellness-tile surface.
              `data-revealed` must sit on an ANCESTOR of `.wellness-tile-rise`
              — the keyframe selector is `[data-revealed="true"]
              .wellness-tile-rise` (descendant combinator). Both on the same
              node never matched, leaving the tile stuck at the rise rule's
              `opacity: 0` (invisible but still boxed). The `contents` wrapper
              carries the flag without adding a layout box. */}
          <div data-revealed={play ? "true" : undefined} className="contents">
            <div
              data-slot="cycle-wheel-tile"
              style={
                tileHue
                  ? ({ "--tile-hue": tileHue } as React.CSSProperties)
                  : undefined
              }
              className={cn(
                "wellness-tile flex flex-col items-center gap-3 rounded-xl p-4 md:p-6",
                play && "wellness-tile-rise",
              )}
            >
              {loading ? (
                <div className="flex h-[220px] items-center justify-center">
                  <Loader2 className="text-muted-foreground h-8 w-8 animate-spin motion-reduce:animate-none" />
                </div>
              ) : calendarError ? (
                <div className="flex h-[220px] flex-col items-center justify-center gap-3 text-center">
                  <p className="text-muted-foreground text-sm">
                    {t("cycle.loadError")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void calendar.refetch()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("common.retry")}
                  </Button>
                </div>
              ) : (
                <CycleRing
                  dayOfCycle={verdict?.dayOfCycle ?? null}
                  cycleLength={verdict?.cycleLength ?? null}
                  phase={verdict?.phase ?? null}
                  spans={verdict?.spans ?? []}
                  animate={play}
                />
              )}
              {!calendarError ? (
                <p className="text-muted-foreground max-w-56 text-center text-xs">
                  {/* Beyond the typical length plus the server's grace window
                      the count stops being an observed fact, so the server
                      resolves OVERDUE and says how late; this caption reports
                      that instead of the "of your cycle" tagline under an
                      empty ring. */}
                  {verdict?.state === "OVERDUE"
                    ? verdict.overdueDays != null
                      ? t("cycle.ring.periodOverdueDays", {
                          days: verdict.overdueDays,
                        })
                      : t("cycle.ring.periodOverdue")
                    : t("cycle.ring.caption")}
                </p>
              ) : null}
              {/* Log CTA — first period when no cycle exists yet, next period
                  when the count paused on an overdue cycle. */}
              {canManageCycle &&
              !loading &&
              !calendarError &&
              verdict?.dayOfCycle == null ? (
                <Button
                  variant="outline"
                  className="mt-1 w-full"
                  onClick={() => openSheet(today)}
                >
                  {verdict?.state === "OVERDUE"
                    ? t("cycle.ring.logPeriodCta")
                    : t("cycle.ring.firstPeriodCta")}
                </Button>
              ) : null}
            </div>
          </div>

          {/* Phase-education card beneath the wheel — the single instance,
              including the "you often notice this here" chip row sourced from
              the user's own symptom-by-phase history. */}
          {!loading && !calendarError ? (
            <PhaseEducationCard
              animate={play}
              phase={verdict?.phase ?? null}
              symptomPatterns={insights.data?.symptomPatterns ?? []}
              predictionEnabled={calProfile?.predictionEnabled ?? false}
              rawChartMode={calProfile?.rawChartMode ?? false}
              cyclesObserved={calProfile?.cyclesObserved ?? 0}
            />
          ) : null}
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as CycleTab)}>
          {/* v1.15.10 — the four German labels (Kalender/Prognosen/
              Erkenntnisse/Einstellungen) overflowed the `flex-1` equal-width
              cells at 375 px and forced a horizontal scroll. Below `sm` the
              triggers size to their content (`text-xs`, no `flex-1`) and the
              strip scrolls cleanly if needed; from `sm` up they reclaim the
              equal-width `flex-1` layout. */}
          <TabsList className="scroll-touch w-full max-w-full overflow-x-auto">
            <TabsTrigger
              value="calendar"
              className="text-xs sm:flex-1 sm:text-sm"
            >
              {t("cycle.tabs.calendar")}
            </TabsTrigger>
            <TabsTrigger
              value="predictions"
              className="text-xs sm:flex-1 sm:text-sm"
            >
              {t("cycle.tabs.predictions")}
            </TabsTrigger>
            <TabsTrigger
              value="insights"
              className="text-xs sm:flex-1 sm:text-sm"
            >
              {t("cycle.tabs.insights")}
            </TabsTrigger>
            {canManageCycle && (
              <TabsTrigger
                value="settings"
                className="text-xs sm:flex-1 sm:text-sm"
              >
                {t("cycle.tabs.settings")}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="calendar" className="mt-4 space-y-4">
            <Card>
              <CardContent className="py-4">
                {loading ? (
                  <p className="text-muted-foreground text-sm">
                    {t("cycle.calendar.loading")}
                  </p>
                ) : calendarError ? (
                  // Inside the calendar card already — a borderless row keeps
                  // it in line with the plain loading line above it (§3/§6).
                  <QueryErrorRow
                    message={t("cycle.loadError")}
                    onRetry={() => void calendar.refetch()}
                    className="border-0 bg-transparent p-0"
                  />
                ) : (
                  <>
                    {/* Cold start: the grid carries no fertile/ovulation/phase
                        overlays yet (the server suppresses them while learning),
                        so name the calm state rather than letting a bare grid
                        imply a confident forecast. */}
                    {calendar.data?.stillLearning ? (
                      <div
                        data-slot="cycle-calendar-learning"
                        className="text-muted-foreground bg-muted/40 mb-3 flex items-start gap-2 rounded-lg p-3 text-sm"
                      >
                        <Sparkles
                          className="text-foreground mt-0.5 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{t("cycle.calendar.learning")}</span>
                      </div>
                    ) : null}
                    <CycleCalendar
                      days={calendarDays}
                      today={today}
                      confirmedOvulation={
                        calendar.data?.prediction?.ovulationConfirmed
                          ? (calendar.data.prediction.predictedOvulation ??
                            null)
                          : null
                      }
                      onSelectDay={canManageCycle ? openSheet : undefined}
                      onVisibleMonthChange={setVisibleMonth}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="predictions" className="mt-4 space-y-4">
            {calendarError ? (
              <QueryErrorCard
                title={t("cycle.loadError")}
                onRetry={() => void calendar.refetch()}
              />
            ) : (
              <>
                <PredictionsPanel
                  prediction={calendar.data?.prediction ?? null}
                  rawChartMode={calendar.data?.profile.rawChartMode ?? false}
                  history={history.data}
                />
                <CycleHistoryChart history={history.data} animate={play} />
                <BbtChart
                  days={calendar.data?.days ?? []}
                  today={today}
                  cycleStartDate={verdict?.cycleStartDate ?? null}
                  predictedOvulation={
                    calendar.data?.prediction?.predictedOvulation ?? null
                  }
                  ovulationConfirmed={
                    calendar.data?.prediction?.ovulationConfirmed ?? false
                  }
                  rawChartMode={calendar.data?.profile.rawChartMode ?? false}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="insights" className="mt-4 space-y-4">
            {insights.isError ? (
              <QueryErrorCard
                title={t("cycle.loadError")}
                onRetry={() => void insights.refetch()}
              />
            ) : (
              <>
                <CyclePhaseHeadline
                  headline={insights.data?.headline ?? null}
                />
                <CyclePhaseCrosstab rows={insights.data?.rows ?? []} />
                <CycleSymptomPatterns
                  rows={insights.data?.symptomPatterns ?? []}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            {profileQuery.isError ? (
              <QueryErrorCard
                title={t("cycle.loadError")}
                onRetry={() => void profileQuery.refetch()}
              />
            ) : profileQuery.isLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="text-muted-foreground h-6 w-6 animate-spin motion-reduce:animate-none" />
              </div>
            ) : profileQuery.data && canManageCycle ? (
              <CycleSettings
                key={profileQuery.data.updatedAt}
                profile={profileQuery.data}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      </div>

      <LogDaySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        date={selectedDate}
        today={today}
        startsCycle={
          calendarDays.find((d) => d.date === selectedDate)?.isCycleStart ??
          false
        }
        activePeriod={verdict?.phase === "MENSTRUAL"}
        phase={verdict?.phase ?? null}
        dayOfCycle={verdict?.dayOfCycle ?? null}
        goal={goal}
        predictionEnabled={calProfile?.predictionEnabled ?? false}
        rawChartMode={calProfile?.rawChartMode ?? false}
        cyclesObserved={calProfile?.cyclesObserved ?? 0}
      />
    </div>
  );
}

/** A compact in-place error + Retry for a failed tab read. */
