"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  Activity,
  Droplet,
  Footprints,
  Heart,
  Moon,
  Percent,
  Pill,
  Plus,
  Smile,
  Target,
  TrendingUp,
  Waves,
} from "lucide-react";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import {
  resolveDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import type { DataSummary as DataSummaryType } from "@/lib/analytics/trends";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MoodForm } from "@/components/mood/mood-form";
import { TrendCard } from "@/components/charts/trend-card";
import { TrendHint } from "@/components/charts/trend-hint";
import { GettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";

const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false },
);
const MoodChart = dynamic(
  () =>
    import("@/components/charts/mood-chart").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false },
);
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { DataSummary } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildWeightBandsFromHeight,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
  type TrafficRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";

interface AnalyticsData {
  summaries: Record<string, DataSummary>;
  bpInTargetPct: number | null;
  glucoseByContext?: Record<string, DataSummaryType>;
}

interface RangeDisplayConfig {
  range: TrafficRange | null;
}

function getHourForTimeZone(timeZone?: string): number {
  const now = new Date();
  if (!timeZone) return now.getHours();

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone,
    }).formatToParts(now);
    const hourPart = parts.find((part) => part.type === "hour")?.value;
    const parsed = hourPart ? Number(hourPart) : Number.NaN;
    return Number.isNaN(parsed) ? now.getHours() : parsed;
  } catch {
    return now.getHours();
  }
}

function getRangeColorClass(
  value: number | null | undefined,
  config: RangeDisplayConfig,
): string | undefined {
  const range = config.range;
  if (value == null || !range) return undefined;
  const inGreen = value >= range.greenMin && value <= range.greenMax;
  const inOrange =
    !inGreen && value >= range.orangeMin && value <= range.orangeMax;

  if (inGreen) return "text-green-400";
  if (inOrange) return "text-orange-400";
  return "text-red-400";
}

function getRangeHint(
  unit: string,
  config: RangeDisplayConfig,
  t: (key: string) => string,
  formatNumber: (value: number, fractionDigits?: number) => string,
): React.ReactNode | undefined {
  const range = config.range;
  if (!range) return undefined;

  const format = (value: number) => formatNumber(value, 1);

  return (
    <>
      <p>
        <span className="font-bold text-green-400">
          {t("charts.colorGreen")}
        </span>{" "}
        {format(range.greenMin)}-{format(range.greenMax)} {unit}
      </p>
      <p>
        <span className="font-bold text-orange-400">
          {t("charts.colorOrange")}
        </span>{" "}
        {format(range.orangeMin)}-{format(range.greenMin)} {t("common.or")}{" "}
        {format(range.greenMax)}-{format(range.orangeMax)} {unit}
      </p>
      <p>
        <span className="font-bold text-red-400">{t("charts.colorRed")}</span>{" "}
        {"< "}
        {format(range.orangeMin)} {t("common.or")} {"> "}
        {format(range.orangeMax)} {unit}
      </p>
    </>
  );
}

export default function DashboardPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [quickEntryDialog, setQuickEntryDialog] = useState<
    "measurement" | "mood" | null
  >(null);

  const { data } = useQuery({
    queryKey: queryKeys.analytics(),
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as AnalyticsData;
    },
    enabled: isAuthenticated,
  });

  const { data: layoutData } = useQuery({
    queryKey: ["user", "dashboardWidgets"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
    enabled: isAuthenticated,
  });

  const { data: moodData } = useQuery({
    queryKey: queryKeys.moodAnalytics(),
    queryFn: async () => {
      const res = await fetch("/api/mood/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        entries: Array<{ date: string; score: number; samples: number }>;
        summary: DataSummary;
      };
    },
    enabled: isAuthenticated,
  });

  const w = data?.summaries.WEIGHT;
  const sys = data?.summaries.BLOOD_PRESSURE_SYS;
  const dia = data?.summaries.BLOOD_PRESSURE_DIA;
  const p = data?.summaries.PULSE;
  const bf = data?.summaries.BODY_FAT;
  const sleepSummary = data?.summaries.SLEEP_DURATION;
  const stepsSummary = data?.summaries.ACTIVITY_STEPS;
  const moodSummary = moodData?.summary;

  // Resolve full dashboard layout — controls visibility + order of every widget
  const layout = resolveDashboardLayout(layoutData);
  const isWidgetVisible = (id: string) =>
    layout.widgets.find((widget) => widget.id === id)?.visible ?? false;
  const widgetOrder = (id: string) =>
    layout.widgets.find((widget) => widget.id === id)?.order ?? 999;

  // Data-floor gates (widget shows iff visible AND has data)
  const hasWeight = (w?.count ?? 0) > 0;
  const hasBp = (sys?.count ?? 0) > 0 || (dia?.count ?? 0) > 0;
  const hasPulse = (p?.count ?? 0) > 0;
  const hasBodyFat = (bf?.count ?? 0) > 0;
  const hasMood = (moodSummary?.count ?? 0) > 0;
  const hasSleep = (sleepSummary?.count ?? 0) > 0;
  const hasSteps = (stepsSummary?.count ?? 0) > 0;
  const hasBpInTarget = data?.bpInTargetPct != null;

  const showWeightCard = isWidgetVisible("weight") && hasWeight;
  const showBpCards = isWidgetVisible("bp") && hasBp;
  const showPulseCard = isWidgetVisible("pulse") && hasPulse;
  const showBodyFatCard = isWidgetVisible("bodyFat") && hasBodyFat;
  const showMoodCard = isWidgetVisible("mood") && hasMood;
  const showSleepCard = isWidgetVisible("sleep") && hasSleep;
  const showStepsCard = isWidgetVisible("steps") && hasSteps;
  const showBpInTargetCard = isWidgetVisible("bpInTarget") && hasBpInTarget;
  const showMedicationsCard = isWidgetVisible("medications");

  // Glucose widget — visible iff layout enables it AND at least one reading exists.
  const glucoseWidgetVisible = isWidgetVisible("glucose");
  const displayGlucoseUnit = resolveGlucoseUnit(user?.glucoseUnit ?? null);
  const glucoseByContext = data?.glucoseByContext ?? {};
  const glucoseContexts = [
    "FASTING",
    "POSTPRANDIAL",
    "RANDOM",
    "BEDTIME",
  ] as const;
  const glucoseSummariesPresent = glucoseContexts.filter(
    (ctx) => (glucoseByContext[ctx]?.count ?? 0) > 0,
  );
  const showGlucoseCards =
    glucoseWidgetVisible && glucoseSummariesPresent.length > 0;
  const glucoseLabelKey: Record<string, string> = {
    FASTING: "targets.glucoseFasting",
    POSTPRANDIAL: "targets.glucosePostprandial",
    RANDOM: "targets.glucoseRandom",
    BEDTIME: "targets.glucoseBedtime",
  };
  const bpTargets =
    user?.dateOfBirth != null ? getBpTargets(new Date(user.dateOfBirth)) : null;
  const pulseAge = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const pulseTarget = getPersonalizedPulseTarget(
    pulseAge,
    (user?.gender as "MALE" | "FEMALE" | null | undefined) ?? null,
  );
  const bodyFatRange = getBodyFatTargetRange(user?.gender);
  const weightRange = user?.heightCm
    ? buildWeightRangeFromHeight(user.heightCm)
    : null;
  const weightBands = user?.heightCm
    ? buildWeightBandsFromHeight(user.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : undefined;
  const bpTargetZones = bpTargets
    ? [
        {
          min: bpTargets.sysLow,
          max: bpTargets.sysHigh,
          color: "#ff79c6",
          opacity: 0.21,
          label: t("charts.systolic"),
          textColor: "#ff79c6",
          lineOpacity: 0.24,
        },
        {
          min: bpTargets.diaLow,
          max: bpTargets.diaHigh,
          color: "#8be9fd",
          opacity: 0.21,
          label: t("charts.diastolic"),
          textColor: "#8be9fd",
          lineOpacity: 0.24,
        },
      ]
    : undefined;
  const bpSysRange = bpTargets
    ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
    : null;
  const bpDiaRange = bpTargets
    ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
    : null;
  const pulseDisplayRange = {
    greenMin: pulseTarget.greenMin,
    greenMax: pulseTarget.greenMax,
    orangeMin: pulseTarget.orangeMin,
    orangeMax: pulseTarget.orangeMax,
  };
  const pulseBands = [
    { min: 30, max: pulseTarget.orangeMin, color: "#ff5555", opacity: 0.16 },
    {
      min: pulseTarget.orangeMin,
      max: pulseTarget.greenMin,
      color: "#ffb86c",
      opacity: 0.18,
    },
    {
      min: pulseTarget.greenMin,
      max: pulseTarget.greenMax,
      color: "#50fa7b",
      opacity: 0.2,
    },
    {
      min: pulseTarget.greenMax,
      max: pulseTarget.orangeMax,
      color: "#ffb86c",
      opacity: 0.18,
    },
    { min: pulseTarget.orangeMax, max: 220, color: "#ff5555", opacity: 0.16 },
  ].filter((band) => band.max > band.min);
  const bodyFatBands = buildTrafficLightBands(
    bodyFatRange.min,
    bodyFatRange.max,
    {
      lowerBound: 2,
      upperBound: 55,
    },
  );
  const hour = user?.timezone ? getHourForTimeZone(user.timezone) : null;
  const timeGreeting =
    hour == null
      ? t("dashboard.greeting.day")
      : hour >= 5 && hour < 12
        ? t("dashboard.greeting.morning")
        : hour >= 12 && hour < 18
          ? t("dashboard.greeting.day")
          : t("dashboard.greeting.evening");
  const welcomeText =
    user?.username && user.username.trim().length > 0
      ? t("dashboard.welcomeBackWithName", {
          greeting: timeGreeting,
          name: user.username,
        })
      : t("dashboard.welcomeBack", { greeting: timeGreeting });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("dashboard.title")}
          </h1>
          <p className="mt-1 hidden text-sm sm:block">{welcomeText}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              <Plus className="mr-1 h-4 w-4" />
              {t("common.add")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => setQuickEntryDialog("measurement")}
            >
              <Activity className="mr-2 h-4 w-4" />
              {t("measurements.addMeasurement")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setQuickEntryDialog("mood")}>
              <Waves className="mr-2 h-4 w-4" />
              {t("mood.addEntry")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* v1.4: Getting-started checklist for brand-new users.
       * Self-gates visibility on (onboardingCompletedAt == null
       * || measurementCount < 5) and disappears once dismissed
       * or fully complete. See B2 in the v1.4 discovery summary. */}
      <GettingStartedChecklist />

      {/* Quick Entry Dialogs */}
      <Dialog
        open={quickEntryDialog === "measurement"}
        onOpenChange={(open) => !open && setQuickEntryDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("measurements.addMeasurement")}</DialogTitle>
          </DialogHeader>
          <MeasurementForm
            onSuccess={() => setQuickEntryDialog(null)}
            onCancel={() => setQuickEntryDialog(null)}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={quickEntryDialog === "mood"}
        onOpenChange={(open) => !open && setQuickEntryDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mood.addEntry")}</DialogTitle>
          </DialogHeader>
          <MoodForm
            onSuccess={() => setQuickEntryDialog(null)}
            onCancel={() => setQuickEntryDialog(null)}
          />
        </DialogContent>
      </Dialog>

      {(() => {
        type TrendEntry = { id: string; order: number; node: React.ReactNode };
        const trendCards: TrendEntry[] = [];

        if (showWeightCard) {
          trendCards.push({
            id: "weight",
            order: widgetOrder("weight"),
            node: (
              <TrendCard
                key="weight"
                label={t("dashboard.weight")}
                latest={w?.latest ?? null}
                unit="kg"
                avg7={w?.avg7 ?? null}
                avg30={w?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(w?.avg7, {
                  range: weightRange,
                })}
                avg30ColorClass={getRangeColorClass(w?.avg30, {
                  range: weightRange,
                })}
                avg7Hint={getRangeHint(
                  "kg",
                  { range: weightRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "kg",
                  { range: weightRange },
                  t,
                  fmt.number,
                )}
                slope30={w?.slope30 ?? null}
                icon={Activity}
              />
            ),
          });
        }
        if (showBpCards) {
          trendCards.push({
            id: "bp",
            order: widgetOrder("bp"),
            node: (
              <React.Fragment key="bp">
                <TrendCard
                  label={t("dashboard.bloodPressureSys")}
                  latest={sys?.latest ?? null}
                  unit="mmHg"
                  avg7={sys?.avg7 ?? null}
                  avg30={sys?.avg30 ?? null}
                  avg7ColorClass={getRangeColorClass(sys?.avg7, {
                    range: bpSysRange,
                  })}
                  avg30ColorClass={getRangeColorClass(sys?.avg30, {
                    range: bpSysRange,
                  })}
                  avg7Hint={getRangeHint(
                    "mmHg",
                    { range: bpSysRange },
                    t,
                    fmt.number,
                  )}
                  avg30Hint={getRangeHint(
                    "mmHg",
                    { range: bpSysRange },
                    t,
                    fmt.number,
                  )}
                  slope30={sys?.slope30 ?? null}
                  icon={Heart}
                />
                <TrendCard
                  label={t("dashboard.bloodPressureDia")}
                  latest={dia?.latest ?? null}
                  unit="mmHg"
                  avg7={dia?.avg7 ?? null}
                  avg30={dia?.avg30 ?? null}
                  avg7ColorClass={getRangeColorClass(dia?.avg7, {
                    range: bpDiaRange,
                  })}
                  avg30ColorClass={getRangeColorClass(dia?.avg30, {
                    range: bpDiaRange,
                  })}
                  avg7Hint={getRangeHint(
                    "mmHg",
                    { range: bpDiaRange },
                    t,
                    fmt.number,
                  )}
                  avg30Hint={getRangeHint(
                    "mmHg",
                    { range: bpDiaRange },
                    t,
                    fmt.number,
                  )}
                  slope30={dia?.slope30 ?? null}
                  icon={Heart}
                />
              </React.Fragment>
            ),
          });
        }
        if (showPulseCard) {
          trendCards.push({
            id: "pulse",
            order: widgetOrder("pulse"),
            node: (
              <TrendCard
                key="pulse"
                label={t("dashboard.pulse")}
                latest={p?.latest ?? null}
                unit="bpm"
                avg7={p?.avg7 ?? null}
                avg30={p?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(p?.avg7, {
                  range: pulseDisplayRange,
                })}
                avg30ColorClass={getRangeColorClass(p?.avg30, {
                  range: pulseDisplayRange,
                })}
                avg7Hint={getRangeHint(
                  "bpm",
                  { range: pulseDisplayRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "bpm",
                  { range: pulseDisplayRange },
                  t,
                  fmt.number,
                )}
                slope30={p?.slope30 ?? null}
                icon={TrendingUp}
              />
            ),
          });
        }
        if (showBodyFatCard) {
          trendCards.push({
            id: "bodyFat",
            order: widgetOrder("bodyFat"),
            node: (
              <TrendCard
                key="bodyFat"
                label={t("dashboard.bodyFat")}
                latest={bf?.latest ?? null}
                unit="%"
                avg7={bf?.avg7 ?? null}
                avg30={bf?.avg30 ?? null}
                slope30={bf?.slope30 ?? null}
                icon={Percent}
              />
            ),
          });
        }
        if (showMoodCard) {
          trendCards.push({
            id: "mood",
            order: widgetOrder("mood"),
            node: (
              <TrendCard
                key="mood"
                label={t("dashboard.mood")}
                latest={moodSummary?.latest ?? null}
                unit="/ 5"
                avg7={moodSummary?.avg7 ?? null}
                avg30={moodSummary?.avg30 ?? null}
                slope30={moodSummary?.slope30 ?? null}
                icon={Smile}
              />
            ),
          });
        }
        if (showSleepCard) {
          trendCards.push({
            id: "sleep",
            order: widgetOrder("sleep"),
            node: (
              <TrendCard
                key="sleep"
                label={t("dashboard.sleep") ?? "Sleep"}
                latest={sleepSummary?.latest ?? null}
                unit="h"
                avg7={sleepSummary?.avg7 ?? null}
                avg30={sleepSummary?.avg30 ?? null}
                slope30={sleepSummary?.slope30 ?? null}
                icon={Moon}
              />
            ),
          });
        }
        if (showStepsCard) {
          trendCards.push({
            id: "steps",
            order: widgetOrder("steps"),
            node: (
              <TrendCard
                key="steps"
                label={t("dashboard.steps") ?? "Steps"}
                latest={stepsSummary?.latest ?? null}
                unit=""
                avg7={stepsSummary?.avg7 ?? null}
                avg30={stepsSummary?.avg30 ?? null}
                slope30={stepsSummary?.slope30 ?? null}
                icon={Footprints}
              />
            ),
          });
        }
        if (showBpInTargetCard) {
          trendCards.push({
            id: "bpInTarget",
            order: widgetOrder("bpInTarget"),
            node: (
              <TrendCard
                key="bpInTarget"
                label={t("dashboard.bpInTarget")}
                latest={data?.bpInTargetPct ?? null}
                unit="%"
                avg7={null}
                avg30={null}
                slope30={null}
                icon={Target}
              />
            ),
          });
        }
        if (showGlucoseCards) {
          const glucoseOrder = widgetOrder("glucose");
          glucoseSummariesPresent.forEach((ctx, idx) => {
            const s = glucoseByContext[ctx];
            trendCards.push({
              id: `glucose-${ctx}`,
              // sub-order so all glucose cards stay in a block and order stable
              order: glucoseOrder + idx / 1000,
              node: (
                <TrendCard
                  key={`glucose-${ctx}`}
                  label={t(glucoseLabelKey[ctx])}
                  latest={
                    s.latest != null
                      ? convertGlucose(s.latest, displayGlucoseUnit)
                      : null
                  }
                  unit={displayGlucoseUnit}
                  avg7={
                    s.avg7 != null
                      ? convertGlucose(s.avg7, displayGlucoseUnit)
                      : null
                  }
                  avg30={
                    s.avg30 != null
                      ? convertGlucose(s.avg30, displayGlucoseUnit)
                      : null
                  }
                  slope30={s.slope30 ?? null}
                  icon={Droplet}
                />
              ),
            });
          });
        }

        trendCards.sort((a, b) => a.order - b.order);

        type ChartEntry = {
          id: string;
          order: number;
          node: React.ReactNode;
          /**
           * Total raw readings for this metric. <5 surfaces a contextual
           * "First trend after 5 readings" hint underneath the chart;
           * undefined disables the hint (e.g. medications card).
           */
          count?: number;
        };
        const charts: ChartEntry[] = [];
        if (showWeightCard) {
          charts.push({
            id: "weight-chart",
            order: widgetOrder("weight"),
            count: w?.count ?? 0,
            node: (
              <HealthChart
                key="weight-chart"
                types={["WEIGHT"]}
                title={t("dashboard.weight")}
                colors={["#bd93f9"]}
                unit="kg"
                valueBands={weightBands}
              />
            ),
          });
          if (user?.heightCm) {
            charts.push({
              id: "bmi-chart",
              order: widgetOrder("weight") + 0.5,
              node: (
                <HealthChart
                  key="bmi-chart"
                  types={["WEIGHT"]}
                  title={t("targets.bmi")}
                  colors={["#f1fa8c"]}
                  unit="kg/m²"
                  valueMode="bmi"
                  valueBands={[
                    { min: 0, max: 17, color: "#ff5555", opacity: 0.16 },
                    { min: 17, max: 18.5, color: "#ffb86c", opacity: 0.18 },
                    { min: 18.5, max: 24.9, color: "#50fa7b", opacity: 0.2 },
                    { min: 24.9, max: 29.9, color: "#ffb86c", opacity: 0.18 },
                    { min: 29.9, max: 120, color: "#ff5555", opacity: 0.16 },
                  ]}
                />
              ),
            });
          }
        }
        if (showBpCards) {
          charts.push({
            id: "bp-chart",
            order: widgetOrder("bp"),
            count: Math.max(sys?.count ?? 0, dia?.count ?? 0),
            node: (
              <HealthChart
                key="bp-chart"
                types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
                title={t("dashboard.bloodPressure")}
                colors={["#ff79c6", "#8be9fd"]}
                unit="mmHg"
                yAxisUnit="Hg"
                targetZones={bpTargetZones}
              />
            ),
          });
        }
        if (showPulseCard) {
          charts.push({
            id: "pulse-chart",
            order: widgetOrder("pulse"),
            count: p?.count ?? 0,
            node: (
              <HealthChart
                key="pulse-chart"
                types={["PULSE"]}
                title={t("dashboard.pulse")}
                colors={["#50fa7b"]}
                unit="bpm"
                valueBands={pulseBands}
              />
            ),
          });
        }
        if (showBodyFatCard) {
          charts.push({
            id: "bodyFat-chart",
            order: widgetOrder("bodyFat"),
            count: bf?.count ?? 0,
            node: (
              <HealthChart
                key="bodyFat-chart"
                types={["BODY_FAT"]}
                title={t("dashboard.bodyFat")}
                colors={["#ffb86c"]}
                unit="%"
                valueBands={bodyFatBands}
              />
            ),
          });
        }
        if (showMoodCard) {
          charts.push({
            id: "mood-chart",
            order: widgetOrder("mood"),
            count: moodSummary?.count ?? 0,
            node: <MoodChart key="mood-chart" />,
          });
        }
        if (showSleepCard) {
          charts.push({
            id: "sleep-chart",
            order: widgetOrder("sleep"),
            count: sleepSummary?.count ?? 0,
            node: (
              <HealthChart
                key="sleep-chart"
                types={["SLEEP_DURATION"]}
                title={t("dashboard.sleep") ?? "Sleep"}
                colors={["#8be9fd"]}
                unit="h"
              />
            ),
          });
        }
        if (showStepsCard) {
          charts.push({
            id: "steps-chart",
            order: widgetOrder("steps"),
            count: stepsSummary?.count ?? 0,
            node: (
              <HealthChart
                key="steps-chart"
                types={["ACTIVITY_STEPS"]}
                title={t("dashboard.steps") ?? "Steps"}
                colors={["#50fa7b"]}
              />
            ),
          });
        }
        if (showMedicationsCard) {
          charts.push({
            id: "medications",
            order: widgetOrder("medications"),
            node: (
              <div key="medications" className="bg-card rounded-lg border p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Pill className="h-4 w-4" />
                  <h3 className="text-sm font-medium">
                    {t("dashboard.medications")}
                  </h3>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t("medications.title") ?? ""}
                </p>
              </div>
            ),
          });
        }

        charts.sort((a, b) => a.order - b.order);

        return (
          <>
            {/* v1.4: dashboard tiles are *always* a single row.
             * Marc-explicit (memory feedback_dashboard_one_row.md): a 2-row
             * tile strip breaks the visual hierarchy and reads like an
             * Excel grid. Total width caps at the parent container —
             * exactly the chart-width below. When the active tile count
             * exceeds what fits the viewport, the strip horizontal-scrolls
             * instead of wrapping; the user trims the set in
             * Settings → Dashboard Layout (`/settings#dashboard-layout`).
             * Each tile keeps a `min-w-[10rem]` so a single tile still
             * looks substantial on a wide screen, and `snap-x snap-mandatory`
             * makes the scroll feel deliberate rather than arbitrary on
             * touch.
             */}
            <div
              className="-mx-2 flex snap-x snap-mandatory gap-3 overflow-x-auto px-2 pb-2"
              data-slot="dashboard-tile-strip"
              data-tile-count={trendCards.length}
            >
              {trendCards.map((entry) => (
                <div
                  key={entry.id}
                  className="shrink-0 grow basis-[10rem] snap-start"
                >
                  {entry.node}
                </div>
              ))}
            </div>
            {charts.map((entry) => (
              <div key={entry.id} className="space-y-2">
                {entry.node}
                {entry.count != null ? <TrendHint count={entry.count} /> : null}
              </div>
            ))}
          </>
        );
      })()}
    </div>
  );
}
