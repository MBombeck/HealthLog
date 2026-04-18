"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import dynamic from "next/dynamic";

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
import { TrendCard } from "@/components/charts/trend-card";
import { ComplianceHeatmap } from "@/components/charts/compliance-heatmap";
import {
  Activity,
  Heart,
  HeartPulse,
  Loader2,
  Percent,
  Pill,
  Ruler,
  Scale,
  Smile,
  TrendingUp,
} from "lucide-react";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  buildTrafficRange,
  buildWeightBandsFromHeight,
  buildWeightRangeFromHeight,
  type TrafficRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import type { DataSummary, TrendSlope } from "@/lib/analytics/trends";

interface ComprehensiveData {
  summaries: Record<
    string,
    {
      latest: number | null;
      avg30: number | null;
      slope30: { slope: number; direction: string } | null;
      anomalyCount: number;
    }
  >;
  bmi: number | null;
  bmiClassification: {
    category: string;
    color: string;
    severity: string;
  } | null;
  bpClassification: {
    category: string;
    color: string;
    severity: string;
  } | null;
  bpPctInTarget: number | null;
  bpTargets: {
    sysLow: number;
    sysHigh: number;
    diaLow: number;
    diaHigh: number;
  } | null;
  weightBpCorrelation: { r: number; strength: string; n: number } | null;
  scatterData: Array<{ weight: number; sysBP: number }>;
  bpMedicationCorrelation: {
    r: number;
    strength: string;
    n: number;
    medicationCount: number;
  } | null;
  bpMedicationScatterData: Array<{ continuityPct: number; sysBP: number }>;
  medications: Array<{
    id: string;
    name: string;
    dose: string;
    category: "BLOOD_PRESSURE" | "VITAMIN" | "OTHER";
    compliance7: number;
    compliance30: number;
    streak: number;
    taken7: number;
    skipped7: number;
    missed7: number;
  }>;
  alerts: Array<{ level: string; title: string; message: string }>;
  hasOpenAiKey: boolean;
  dataSpanDays: number;
  totalMeasurements: number;
  moodSummary: {
    latest: number | null;
    avg7: number | null;
    avg30: number | null;
    count: number;
    slope30: { slope: number; direction: string } | null;
  } | null;
  moodBpCorrelation: { r: number; strength: string; n: number } | null;
  moodBpScatterData: Array<{ mood: number; sysBP: number }>;
  moodWeightCorrelation: { r: number; strength: string; n: number } | null;
  moodWeightScatterData: Array<{ mood: number; weight: number }>;
  moodPulseCorrelation: { r: number; strength: string; n: number } | null;
  moodPulseScatterData: Array<{ mood: number; pulse: number }>;
}

interface AnalyticsData {
  summaries: Record<string, DataSummary>;
}

interface GeneralStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}

interface BloodPressureStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}

interface WeightStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}

interface PulseStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}

interface BmiStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}

interface MoodStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}

interface MedicationComplianceStatusData {
  hasProvider: boolean;
  summary: string | null;
  medications: Array<{
    medicationId: string;
    text: string;
  }>;
  cached: boolean;
  updatedAt: string | null;
}

interface MedicationDailyData {
  expected: number;
  taken: number;
  skipped: number;
  onTime?: number;
  late?: number;
  veryLate?: number;
}

interface MedicationComplianceDailyResponse {
  dailyCompliance: Record<string, MedicationDailyData>;
}

interface RangeDisplayConfig {
  range: TrafficRange | null;
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

type HealthBandState = "green" | "orange" | "red";

function classifyRangeValue(
  value: number | null | undefined,
  range: TrafficRange | null,
): HealthBandState | null {
  if (value == null || !range) return null;
  if (value >= range.greenMin && value <= range.greenMax) return "green";
  if (value >= range.orangeMin && value <= range.orangeMax) return "orange";
  return "red";
}

function getOverallHealthStatus(states: Array<HealthBandState | null>): {
  level: "good" | "watch" | "critical";
  className: string;
} {
  const valid = states.filter(
    (state): state is HealthBandState => state !== null,
  );

  if (valid.length === 0) {
    return {
      level: "watch",
      className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
    };
  }

  const greenCount = valid.filter((state) => state === "green").length;
  const redCount = valid.filter((state) => state === "red").length;

  if (redCount >= 2 || redCount / valid.length >= 0.5) {
    return {
      level: "critical",
      className: "border-red-500/30 bg-red-500/15 text-red-300",
    };
  }

  if (redCount === 0 && greenCount / valid.length >= 0.6) {
    return {
      level: "good",
      className: "border-green-500/30 bg-green-500/15 text-green-300",
    };
  }

  return {
    level: "watch",
    className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
  };
}

function getBloodPressureSectionStatus(input: {
  sysAvg30: number | null | undefined;
  diaAvg30: number | null | undefined;
  sysRange: TrafficRange | null;
  diaRange: TrafficRange | null;
  inTargetPct: number | null | undefined;
  medicationCompliance30: number | null;
}): { level: "good" | "watch" | "critical"; className: string } {
  const sysState = classifyRangeValue(input.sysAvg30, input.sysRange);
  const diaState = classifyRangeValue(input.diaAvg30, input.diaRange);
  const inTargetPct = input.inTargetPct ?? null;

  if (
    sysState === "red" ||
    diaState === "red" ||
    (inTargetPct != null && inTargetPct < 50) ||
    (input.medicationCompliance30 != null && input.medicationCompliance30 < 60)
  ) {
    return {
      level: "critical",
      className: "border-red-500/30 bg-red-500/15 text-red-300",
    };
  }

  if (
    sysState === "green" &&
    diaState === "green" &&
    (inTargetPct == null || inTargetPct >= 70) &&
    (input.medicationCompliance30 == null || input.medicationCompliance30 >= 80)
  ) {
    return {
      level: "good",
      className: "border-green-500/30 bg-green-500/15 text-green-300",
    };
  }

  return {
    level: "watch",
    className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
  };
}

function getWeightSectionStatus(input: {
  avg30: number | null | undefined;
  range: TrafficRange | null;
  slope30Direction: string | null | undefined;
}): { level: "good" | "watch" | "critical"; className: string } {
  const state = classifyRangeValue(input.avg30, input.range);

  if (state === "red") {
    return {
      level: "critical",
      className: "border-red-500/30 bg-red-500/15 text-red-300",
    };
  }

  if (state === "green" && input.slope30Direction !== "up") {
    return {
      level: "good",
      className: "border-green-500/30 bg-green-500/15 text-green-300",
    };
  }

  return {
    level: "watch",
    className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
  };
}

function getPulseSectionStatus(input: {
  avg30: number | null | undefined;
  range: TrafficRange | null;
  slope30Direction: string | null | undefined;
}): { level: "good" | "watch" | "critical"; className: string } {
  const state = classifyRangeValue(input.avg30, input.range);

  if (state === "red") {
    return {
      level: "critical",
      className: "border-red-500/30 bg-red-500/15 text-red-300",
    };
  }

  if (state === "green" && input.slope30Direction !== "up") {
    return {
      level: "good",
      className: "border-green-500/30 bg-green-500/15 text-green-300",
    };
  }

  return {
    level: "watch",
    className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
  };
}

function getBmiSectionStatus(input: {
  avg30: number | null | undefined;
  range: TrafficRange | null;
  slope30Direction: string | null | undefined;
}): { level: "good" | "watch" | "critical"; className: string } {
  const state = classifyRangeValue(input.avg30, input.range);

  if (state === "red") {
    return {
      level: "critical",
      className: "border-red-500/30 bg-red-500/15 text-red-300",
    };
  }

  if (state === "green" && input.slope30Direction !== "up") {
    return {
      level: "good",
      className: "border-green-500/30 bg-green-500/15 text-green-300",
    };
  }

  return {
    level: "watch",
    className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
  };
}

function getMoodSectionStatus(input: {
  avg30: number | null | undefined;
}): { level: "good" | "watch" | "critical"; className: string } {
  if (input.avg30 == null) {
    return {
      level: "watch",
      className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
    };
  }

  if (input.avg30 < 2) {
    return {
      level: "critical",
      className: "border-red-500/30 bg-red-500/15 text-red-300",
    };
  }

  if (input.avg30 >= 3.5) {
    return {
      level: "good",
      className: "border-green-500/30 bg-green-500/15 text-green-300",
    };
  }

  return {
    level: "watch",
    className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
  };
}

function getMedicationComplianceSectionStatus(input: {
  average30: number | null;
  totalEvents: number;
}): { level: "good" | "watch" | "critical"; className: string } {
  const MIN_EVENTS_FOR_ASSESSMENT = 14;

  if (input.average30 == null || input.totalEvents < MIN_EVENTS_FOR_ASSESSMENT) {
    return {
      level: "watch",
      className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
    };
  }

  if (input.average30 < 60) {
    return {
      level: "critical",
      className: "border-red-500/30 bg-red-500/15 text-red-300",
    };
  }

  if (input.average30 >= 80) {
    return {
      level: "good",
      className: "border-green-500/30 bg-green-500/15 text-green-300",
    };
  }

  return {
    level: "watch",
    className: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
  };
}

export default function InsightsPage() {
  const { isAuthenticated, user } = useAuth();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();

  const STRENGTH_LABELS: Record<string, string> = {
    stark: t("insights.strengthStrong"),
    moderat: t("insights.strengthModerate"),
    schwach: t("insights.strengthWeak"),
    keine: t("insights.strengthNone"),
  };

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "comprehensive"],
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error(t("insights.loadError"));
      const json = await res.json();
      return json.data as ComprehensiveData;
    },
    enabled: isAuthenticated,
  });

  const { data: analytics } = useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as AnalyticsData;
    },
    enabled: isAuthenticated,
  });

  const {
    data: generalStatus,
    isLoading: isGeneralStatusLoading,
  } = useQuery({
    queryKey: ["insights", "general-status", locale],
    queryFn: async () => {
      const res = await fetch(`/api/insights/general-status?locale=${locale}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as GeneralStatusData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const {
    data: bloodPressureStatus,
    isLoading: isBloodPressureStatusLoading,
  } = useQuery({
    queryKey: ["insights", "blood-pressure-status", locale],
    queryFn: async () => {
      const res = await fetch(
        `/api/insights/blood-pressure-status?locale=${locale}`,
      );
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as BloodPressureStatusData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const {
    data: weightStatus,
    isLoading: isWeightStatusLoading,
  } = useQuery({
    queryKey: ["insights", "weight-status", locale],
    queryFn: async () => {
      const res = await fetch(`/api/insights/weight-status?locale=${locale}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as WeightStatusData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const {
    data: pulseStatus,
    isLoading: isPulseStatusLoading,
  } = useQuery({
    queryKey: ["insights", "pulse-status", locale],
    queryFn: async () => {
      const res = await fetch(`/api/insights/pulse-status?locale=${locale}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as PulseStatusData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const {
    data: bmiStatus,
    isLoading: isBmiStatusLoading,
  } = useQuery({
    queryKey: ["insights", "bmi-status", locale],
    queryFn: async () => {
      const res = await fetch(`/api/insights/bmi-status?locale=${locale}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as BmiStatusData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const {
    data: moodStatus,
    isLoading: isMoodStatusLoading,
  } = useQuery({
    queryKey: ["insights", "mood-status", locale],
    queryFn: async () => {
      const res = await fetch(`/api/insights/mood-status?locale=${locale}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as MoodStatusData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const {
    data: medicationComplianceStatus,
    isLoading: isMedicationComplianceStatusLoading,
  } = useQuery({
    queryKey: ["insights", "medication-compliance-status", locale],
    queryFn: async () => {
      const res = await fetch(
        `/api/insights/medication-compliance-status?locale=${locale}`,
      );
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as MedicationComplianceStatusData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });
  const w = analytics?.summaries.WEIGHT;
  const sys = analytics?.summaries.BLOOD_PRESSURE_SYS;
  const dia = analytics?.summaries.BLOOD_PRESSURE_DIA;
  const p = analytics?.summaries.PULSE;
  const bf = analytics?.summaries.BODY_FAT;
  const showBodyFatCard = (bf?.count ?? 0) > 0;
  const moodSummary = data?.moodSummary;
  const showMoodCard = (moodSummary?.count ?? 0) > 0;
  const bmiDivisor = user?.heightCm ? (user.heightCm / 100) ** 2 : null;
  // bmiAvg30 and bmiSlope30 still used for overallStatus + bmiSectionStatus
  const bmiAvg30 = bmiDivisor && w?.avg30 != null ? w.avg30 / bmiDivisor : null;
  const bmiSlope30 =
    bmiDivisor && w?.slope30
      ? {
          ...w.slope30,
          slope: w.slope30.slope / bmiDivisor,
        }
      : null;

  const bpTargets =
    user?.dateOfBirth != null ? getBpTargets(new Date(user.dateOfBirth)) : null;
  const pulseAge = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const pulseTarget = getPersonalizedPulseTarget(
    pulseAge,
    (user?.gender as "MALE" | "FEMALE" | null | undefined) ?? null,
  );
  const weightRange = user?.heightCm
    ? buildWeightRangeFromHeight(user.heightCm)
    : null;
  const bmiRange = buildTrafficRange(18.5, 24.9);
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
  const overallStatus = getOverallHealthStatus([
    classifyRangeValue(w?.avg30, weightRange),
    classifyRangeValue(sys?.avg30, bpSysRange),
    classifyRangeValue(dia?.avg30, bpDiaRange),
    classifyRangeValue(p?.avg30, pulseDisplayRange),
    classifyRangeValue(bmiAvg30, bmiRange),
  ]);
  const bpMedications =
    data?.medications.filter(
      (medication) => medication.category === "BLOOD_PRESSURE",
    ) ?? [];
  const bpMedicationCompliance30 =
    bpMedications.length > 0
      ? bpMedications.reduce(
          (sum, medication) => sum + medication.compliance30,
          0,
        ) / bpMedications.length
      : null;
  const bloodPressureSectionStatus = getBloodPressureSectionStatus({
    sysAvg30: sys?.avg30,
    diaAvg30: dia?.avg30,
    sysRange: bpSysRange,
    diaRange: bpDiaRange,
    inTargetPct: data?.bpPctInTarget,
    medicationCompliance30: bpMedicationCompliance30,
  });
  const weightSectionStatus = getWeightSectionStatus({
    avg30: w?.avg30,
    range: weightRange,
    slope30Direction: w?.slope30?.direction,
  });
  const pulseSectionStatus = getPulseSectionStatus({
    avg30: p?.avg30,
    range: pulseDisplayRange,
    slope30Direction: p?.slope30?.direction,
  });
  const bmiSectionStatus = getBmiSectionStatus({
    avg30: bmiAvg30,
    range: bmiRange,
    slope30Direction: bmiSlope30?.direction,
  });
  const moodSectionStatus = getMoodSectionStatus({
    avg30: data?.moodSummary?.avg30,
  });
  const showMoodSection = (data?.moodSummary?.count ?? 0) > 0;
  const medicationList = data?.medications ?? [];
  const medicationComplianceAverage30 =
    medicationList.length > 0
      ? medicationList.reduce(
          (sum, medication) => sum + medication.compliance30,
          0,
        ) / medicationList.length
      : null;
  const medicationTotalEvents = medicationList.reduce(
    (sum, med) => sum + med.taken7 + med.skipped7 + med.missed7,
    0,
  );
  const medicationComplianceSectionStatus =
    getMedicationComplianceSectionStatus({
      average30: medicationComplianceAverage30,
      totalEvents: medicationTotalEvents,
    });
  const medicationSummaryById = new Map(
    (medicationComplianceStatus?.medications ?? []).map((entry) => [
      entry.medicationId,
      entry.text,
    ]),
  );
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
  const bmiBands = [
    { min: 0, max: 17, color: "#ff5555", opacity: 0.16 },
    { min: 17, max: 18.5, color: "#ffb86c", opacity: 0.18 },
    { min: 18.5, max: 24.9, color: "#50fa7b", opacity: 0.2 },
    { min: 24.9, max: 29.9, color: "#ffb86c", opacity: 0.18 },
    { min: 29.9, max: 120, color: "#ff5555", opacity: 0.16 },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-muted-foreground py-20 text-center">
        {t("common.noData")}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("insights.title")}</h1>
        <p className="text-muted-foreground hidden text-sm sm:block">
          {t("insights.overviewSubtitle")}
        </p>
      </div>

      <InsightsSectionNav />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <TrendCard
          label={t("dashboard.weight")}
          latest={w?.latest ?? null}
          unit="kg"
          avg7={w?.avg7 ?? null}
          avg30={w?.avg30 ?? null}
          avg7ColorClass={getRangeColorClass(w?.avg7, { range: weightRange })}
          avg30ColorClass={getRangeColorClass(w?.avg30, { range: weightRange })}
          avg7Hint={getRangeHint("kg", { range: weightRange }, t, fmt.number)}
          avg30Hint={getRangeHint("kg", { range: weightRange }, t, fmt.number)}
          slope30={w?.slope30 ?? null}
          icon={Activity}
        />
        <TrendCard
          label={t("dashboard.bloodPressureSys")}
          latest={sys?.latest ?? null}
          unit="mmHg"
          avg7={sys?.avg7 ?? null}
          avg30={sys?.avg30 ?? null}
          avg7ColorClass={getRangeColorClass(sys?.avg7, { range: bpSysRange })}
          avg30ColorClass={getRangeColorClass(sys?.avg30, {
            range: bpSysRange,
          })}
          avg7Hint={getRangeHint("mmHg", { range: bpSysRange }, t, fmt.number)}
          avg30Hint={getRangeHint("mmHg", { range: bpSysRange }, t, fmt.number)}
          slope30={sys?.slope30 ?? null}
          icon={Heart}
        />
        <TrendCard
          label={t("dashboard.bloodPressureDia")}
          latest={dia?.latest ?? null}
          unit="mmHg"
          avg7={dia?.avg7 ?? null}
          avg30={dia?.avg30 ?? null}
          avg7ColorClass={getRangeColorClass(dia?.avg7, { range: bpDiaRange })}
          avg30ColorClass={getRangeColorClass(dia?.avg30, {
            range: bpDiaRange,
          })}
          avg7Hint={getRangeHint("mmHg", { range: bpDiaRange }, t, fmt.number)}
          avg30Hint={getRangeHint("mmHg", { range: bpDiaRange }, t, fmt.number)}
          slope30={dia?.slope30 ?? null}
          icon={Heart}
        />
        <TrendCard
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
          avg7Hint={getRangeHint("bpm", { range: pulseDisplayRange }, t, fmt.number)}
          avg30Hint={getRangeHint("bpm", { range: pulseDisplayRange }, t, fmt.number)}
          slope30={p?.slope30 ?? null}
          icon={TrendingUp}
        />
        {showBodyFatCard ? (
          <TrendCard
            label={t("dashboard.bodyFat")}
            latest={bf?.latest ?? null}
            unit="%"
            avg7={bf?.avg7 ?? null}
            avg30={bf?.avg30 ?? null}
            slope30={bf?.slope30 ?? null}
            icon={Percent}
          />
        ) : null}
        {showMoodCard ? (
          <TrendCard
            label={t("dashboard.mood")}
            latest={moodSummary?.latest ?? null}
            unit="/ 5"
            avg7={moodSummary?.avg7 ?? null}
            avg30={moodSummary?.avg30 ?? null}
            slope30={(moodSummary?.slope30 as TrendSlope | undefined) ?? null}
            icon={Smile}
          />
        ) : null}
      </div>

      <section id="section-general" className="scroll-mt-28 space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {t("insights.generalStatusTitle")}
          </h2>
          <Badge
            className={`border text-xs ${overallStatus.className}`}
            variant="outline"
          >
            {t(`insights.generalStatusBadge.${overallStatus.level}`)}
          </Badge>
        </div>
        <InsightStatusCard
          title={t("insights.generalStatusTitle")}
          icon={<Activity className="h-5 w-5" />}
          text={generalStatus?.text ?? null}
          hasProvider={generalStatus?.hasProvider ?? false}
          cached={generalStatus?.cached ?? false}
          updatedAt={generalStatus?.updatedAt ?? null}
          loading={isGeneralStatusLoading}
        />
      </section>

      {/* Section 3: Blood pressure */}
      <section id="section-bp" className="scroll-mt-28 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {t("insights.bloodPressureSectionTitle")}
          </h2>
          <Badge
            className={`border text-xs ${bloodPressureSectionStatus.className}`}
            variant="outline"
          >
            {t(
              `insights.generalStatusBadge.${bloodPressureSectionStatus.level}`,
            )}
          </Badge>
        </div>

        <HealthChart
          types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
          title={t("charts.bloodPressure")}
          colors={["#ff79c6", "#8be9fd"]}
          unit="mmHg"
          yAxisUnit="Hg"
          targetZones={bpTargetZones}
        />

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Pill className="text-dracula-orange h-4 w-4" />
                  <CardTitle className="text-sm font-medium">
                    {t("insights.bpMedContinuity")}
                  </CardTitle>
                </div>
                {data.bpMedicationCorrelation && (
                  <Badge variant="outline">
                    r = {data.bpMedicationCorrelation.r} ·{" "}
                    {STRENGTH_LABELS[data.bpMedicationCorrelation.strength] ??
                      data.bpMedicationCorrelation.strength}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {data.bpMedicationScatterData.length >= 5 ? (
                <div className="space-y-2">
                  <ResponsiveContainer width="100%" height={250}>
                    <ScatterChart
                      margin={{ top: 10, right: 20, bottom: 36, left: 12 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="hsl(var(--border))"
                      />
                      <XAxis
                        dataKey="continuityPct"
                        type="number"
                        name={t("insights.continuityLabel")}
                        unit="%"
                        tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                        tickMargin={8}
                        height={52}
                        interval="preserveStartEnd"
                        padding={{ left: 8, right: 8 }}
                        stroke="var(--dracula-comment)"
                        label={{
                          value: t("insights.continuityBpLabel"),
                          position: "bottom",
                          fontSize: 12,
                          fill: "var(--dracula-comment)",
                        }}
                      />
                      <YAxis
                        dataKey="sysBP"
                        type="number"
                        name="Sys. BP"
                        unit=" mmHg"
                        tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                        stroke="var(--dracula-comment)"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "0.5rem",
                          fontSize: "0.75rem",
                        }}
                        itemStyle={{ color: "var(--dracula-fg)" }}
                        labelStyle={{ color: "var(--dracula-fg)" }}
                        formatter={(value, name) => [
                          `${value}${name === t("insights.continuityLabel") ? "%" : " mmHg"}`,
                          name,
                        ]}
                      />
                      <Scatter
                        data={data.bpMedicationScatterData}
                        fill="var(--dracula-orange)"
                        opacity={0.8}
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                  {data.bpMedicationCorrelation && (
                    <p className="text-muted-foreground text-center text-xs">
                      {data.bpMedicationCorrelation.r < 0
                        ? t("insights.bpMedNegative")
                        : data.bpMedicationCorrelation.r > 0
                          ? t("insights.bpMedPositive")
                          : t("insights.bpMedNone")}{" "}
                      (n = {data.bpMedicationCorrelation.n},{" "}
                      {t("insights.bpMedCount", {
                        count: data.bpMedicationCorrelation.medicationCount,
                      })}
                      )
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-muted-foreground flex flex-col items-center justify-center py-8 text-sm">
                  <Activity className="mb-2 h-8 w-8 opacity-50" />
                  <p>{t("insights.notEnoughMedData")}</p>
                  <p className="text-xs">
                    {t("insights.notEnoughMedDataHint")}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {showMoodSection && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Smile className="text-dracula-lavender h-4 w-4" />
                    <CardTitle className="text-sm font-medium">
                      {t("insights.moodVsBp")}
                    </CardTitle>
                  </div>
                  {data?.moodBpCorrelation && (
                    <Badge variant="outline">
                      r = {data.moodBpCorrelation.r} ·{" "}
                      {STRENGTH_LABELS[data.moodBpCorrelation.strength] ??
                        data.moodBpCorrelation.strength}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {(data?.moodBpScatterData?.length ?? 0) >= 5 ? (
                  <div className="space-y-2">
                    <ResponsiveContainer width="100%" height={250}>
                      <ScatterChart
                        margin={{ top: 10, right: 20, bottom: 36, left: 12 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="hsl(var(--border))"
                        />
                        <XAxis
                          dataKey="mood"
                          type="number"
                          name={t("insights.moodScoreLabel")}
                          tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                          tickMargin={8}
                          height={52}
                          domain={[1, 5]}
                          ticks={[1, 2, 3, 4, 5]}
                          stroke="var(--dracula-comment)"
                          label={{
                            value: t("insights.moodScoreLabel"),
                            position: "bottom",
                            fontSize: 12,
                            fill: "var(--dracula-comment)",
                          }}
                        />
                        <YAxis
                          dataKey="sysBP"
                          type="number"
                          name="Sys. BP"
                          unit=" mmHg"
                          tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                          stroke="var(--dracula-comment)"
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "0.5rem",
                            fontSize: "0.75rem",
                          }}
                          itemStyle={{ color: "var(--dracula-fg)" }}
                          labelStyle={{ color: "var(--dracula-fg)" }}
                        />
                        <Scatter
                          data={data?.moodBpScatterData}
                          fill="var(--dracula-lavender)"
                          opacity={0.8}
                        />
                      </ScatterChart>
                    </ResponsiveContainer>
                    {data?.moodBpCorrelation && (
                      <p className="text-muted-foreground text-center text-xs">
                        {data.moodBpCorrelation.strength === "stark"
                          ? t("insights.moodBpStrong")
                          : data.moodBpCorrelation.strength === "moderat"
                            ? t("insights.moodBpModerate")
                            : data.moodBpCorrelation.strength === "schwach"
                              ? t("insights.moodBpWeak")
                              : t("insights.moodBpNone")}{" "}
                        (n = {data.moodBpCorrelation.n})
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="text-muted-foreground flex flex-col items-center justify-center py-8 text-sm">
                    <Smile className="mb-2 h-8 w-8 opacity-50" />
                    <p>{t("insights.notEnoughMoodCorrelationData")}</p>
                    <p className="text-xs">{t("insights.minMoodCorrelationData")}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              {t("insights.bloodPressureMedicationListTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {bpMedications.length > 0 ? (
              bpMedications.map((medication) => (
                <div key={`bp-med-${medication.id}`} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{medication.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {medication.dose}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>{t("insights.compliance30d")}</span>
                      <span className="font-medium">
                        {medication.compliance30}%
                      </span>
                    </div>
                    <Progress value={medication.compliance30} className="h-2" />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground text-sm">
                {t("insights.bloodPressureMedicationListEmpty")}
              </p>
            )}
          </CardContent>
        </Card>

        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<HeartPulse className="h-5 w-5" />}
          text={bloodPressureStatus?.text ?? null}
          hasProvider={bloodPressureStatus?.hasProvider ?? false}
          cached={bloodPressureStatus?.cached ?? false}
          updatedAt={bloodPressureStatus?.updatedAt ?? null}
          loading={isBloodPressureStatusLoading}
        />
      </section>

      {/* Section 4: Weight */}
      <section id="section-weight" className="scroll-mt-28 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {t("insights.weightSectionTitle")}
          </h2>
          <Badge
            className={`border text-xs ${weightSectionStatus.className}`}
            variant="outline"
          >
            {t(`insights.generalStatusBadge.${weightSectionStatus.level}`)}
          </Badge>
        </div>

        <HealthChart
          types={["WEIGHT"]}
          title={t("charts.weight")}
          colors={["#bd93f9"]}
          unit="kg"
          valueBands={weightBands}
        />

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="text-dracula-cyan h-4 w-4" />
                  <CardTitle className="text-sm font-medium">
                    {t("insights.weightVsBp")}
                  </CardTitle>
                </div>
                {data.weightBpCorrelation && (
                  <Badge variant="outline">
                    r = {data.weightBpCorrelation.r} ·{" "}
                    {STRENGTH_LABELS[data.weightBpCorrelation.strength] ??
                      data.weightBpCorrelation.strength}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {data.scatterData.length >= 5 ? (
                <div className="space-y-2">
                  <ResponsiveContainer width="100%" height={250}>
                    <ScatterChart
                      margin={{ top: 10, right: 20, bottom: 36, left: 12 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="hsl(var(--border))"
                      />
                      <XAxis
                        dataKey="weight"
                        type="number"
                        name={t("dashboard.weight")}
                        unit=" kg"
                        tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                        tickMargin={8}
                        height={52}
                        interval="preserveStartEnd"
                        padding={{ left: 8, right: 8 }}
                        tickFormatter={(value: number) => value.toFixed(1)}
                        stroke="var(--dracula-comment)"
                        label={{
                          value: t("insights.weightKgLabel"),
                          position: "bottom",
                          fontSize: 12,
                          fill: "var(--dracula-comment)",
                        }}
                      />
                      <YAxis
                        dataKey="sysBP"
                        type="number"
                        name="Sys. BP"
                        unit=" mmHg"
                        tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                        stroke="var(--dracula-comment)"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "0.5rem",
                          fontSize: "0.75rem",
                        }}
                        itemStyle={{ color: "var(--dracula-fg)" }}
                        labelStyle={{ color: "var(--dracula-fg)" }}
                        formatter={(value, name) => [
                          `${value} ${name === t("dashboard.weight") ? "kg" : "mmHg"}`,
                          name,
                        ]}
                      />
                      <Scatter
                        data={data.scatterData}
                        fill="var(--dracula-cyan)"
                        opacity={0.8}
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                  {data.weightBpCorrelation && (
                    <p className="text-muted-foreground text-center text-xs">
                      {data.weightBpCorrelation.strength === "stark"
                        ? t("insights.weightBpStrong")
                        : data.weightBpCorrelation.strength === "moderat"
                          ? t("insights.weightBpModerate")
                          : data.weightBpCorrelation.strength === "schwach"
                            ? t("insights.weightBpWeak")
                            : t("insights.weightBpNone")}{" "}
                      (n = {data.weightBpCorrelation.n})
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-muted-foreground flex flex-col items-center justify-center py-8 text-sm">
                  <Activity className="mb-2 h-8 w-8 opacity-50" />
                  <p>{t("insights.notEnoughCorrelationData")}</p>
                  <p className="text-xs">{t("insights.minCorrelationData")}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {showMoodSection && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Smile className="text-dracula-lavender h-4 w-4" />
                    <CardTitle className="text-sm font-medium">
                      {t("insights.moodVsWeight")}
                    </CardTitle>
                  </div>
                  {data?.moodWeightCorrelation && (
                    <Badge variant="outline">
                      r = {data.moodWeightCorrelation.r} ·{" "}
                      {STRENGTH_LABELS[data.moodWeightCorrelation.strength] ??
                        data.moodWeightCorrelation.strength}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {(data?.moodWeightScatterData?.length ?? 0) >= 5 ? (
                  <div className="space-y-2">
                    <ResponsiveContainer width="100%" height={250}>
                      <ScatterChart
                        margin={{ top: 10, right: 20, bottom: 36, left: 12 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="hsl(var(--border))"
                        />
                        <XAxis
                          dataKey="mood"
                          type="number"
                          name={t("insights.moodScoreLabel")}
                          tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                          tickMargin={8}
                          height={52}
                          domain={[1, 5]}
                          ticks={[1, 2, 3, 4, 5]}
                          stroke="var(--dracula-comment)"
                          label={{
                            value: t("insights.moodScoreLabel"),
                            position: "bottom",
                            fontSize: 12,
                            fill: "var(--dracula-comment)",
                          }}
                        />
                        <YAxis
                          dataKey="weight"
                          type="number"
                          name={t("dashboard.weight")}
                          unit=" kg"
                          tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
                          stroke="var(--dracula-comment)"
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "0.5rem",
                            fontSize: "0.75rem",
                          }}
                          itemStyle={{ color: "var(--dracula-fg)" }}
                          labelStyle={{ color: "var(--dracula-fg)" }}
                        />
                        <Scatter
                          data={data?.moodWeightScatterData}
                          fill="var(--dracula-lavender)"
                          opacity={0.8}
                        />
                      </ScatterChart>
                    </ResponsiveContainer>
                    {data?.moodWeightCorrelation && (
                      <p className="text-muted-foreground text-center text-xs">
                        {data.moodWeightCorrelation.strength === "stark"
                          ? t("insights.moodWeightStrong")
                          : data.moodWeightCorrelation.strength === "moderat"
                            ? t("insights.moodWeightModerate")
                            : data.moodWeightCorrelation.strength === "schwach"
                              ? t("insights.moodWeightWeak")
                              : t("insights.moodWeightNone")}{" "}
                        (n = {data.moodWeightCorrelation.n})
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="text-muted-foreground flex flex-col items-center justify-center py-8 text-sm">
                    <Smile className="mb-2 h-8 w-8 opacity-50" />
                    <p>{t("insights.notEnoughMoodCorrelationData")}</p>
                    <p className="text-xs">{t("insights.minMoodCorrelationData")}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<Scale className="h-5 w-5" />}
          text={weightStatus?.text ?? null}
          hasProvider={weightStatus?.hasProvider ?? false}
          cached={weightStatus?.cached ?? false}
          updatedAt={weightStatus?.updatedAt ?? null}
          loading={isWeightStatusLoading}
        />
      </section>

      {/* Section 5: Pulse */}
      <section id="section-pulse" className="scroll-mt-28 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {t("insights.pulseSectionTitle")}
          </h2>
          <Badge
            className={`border text-xs ${pulseSectionStatus.className}`}
            variant="outline"
          >
            {t(`insights.generalStatusBadge.${pulseSectionStatus.level}`)}
          </Badge>
        </div>

        <HealthChart
          types={["PULSE"]}
          title={t("charts.pulse")}
          colors={["#50fa7b"]}
          unit="bpm"
          valueBands={pulseBands}
        />

        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<Heart className="h-5 w-5" />}
          text={pulseStatus?.text ?? null}
          hasProvider={pulseStatus?.hasProvider ?? false}
          cached={pulseStatus?.cached ?? false}
          updatedAt={pulseStatus?.updatedAt ?? null}
          loading={isPulseStatusLoading}
        />
      </section>

      {/* Section: Mood */}
      {showMoodSection && (
        <section id="section-mood" className="scroll-mt-28 space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">
              {t("insights.moodSectionTitle")}
            </h2>
            <Badge
              className={`border text-xs ${moodSectionStatus.className}`}
              variant="outline"
            >
              {t(`insights.generalStatusBadge.${moodSectionStatus.level}`)}
            </Badge>
          </div>

          <MoodChart />

          <InsightStatusCard
            title={t("insights.assessmentTitle")}
            icon={<Smile className="h-5 w-5" />}
            text={moodStatus?.text ?? null}
            hasProvider={moodStatus?.hasProvider ?? false}
            cached={moodStatus?.cached ?? false}
            updatedAt={moodStatus?.updatedAt ?? null}
            loading={isMoodStatusLoading}
          />
        </section>
      )}

      {/* Section 6: Medication Compliance */}
      <section id="section-meds" className="scroll-mt-28 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {t("insights.medicationCompliance")}
          </h2>
          <Badge
            className={`border text-xs ${medicationComplianceSectionStatus.className}`}
            variant="outline"
          >
            {t(
              `insights.generalStatusBadge.${medicationComplianceSectionStatus.level}`,
            )}
          </Badge>
        </div>

        {data.medications.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {data.medications.map((med) => {
              const medicationSummary = medicationSummaryById.get(med.id);
              return (
                <Card key={med.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Pill className="text-dracula-orange h-4 w-4" />
                        <CardTitle className="text-sm font-medium">
                          {med.name}
                        </CardTitle>
                      </div>
                      {med.streak > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {t("insights.dayStreak", { count: med.streak })}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">{med.dose}</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span>{t("insights.compliance7d")}</span>
                        <span className="font-medium">{med.compliance7}%</span>
                      </div>
                      <Progress value={med.compliance7} className="h-2" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span>{t("insights.compliance30d")}</span>
                        <span className="font-medium">{med.compliance30}%</span>
                      </div>
                      <Progress value={med.compliance30} className="h-2" />
                    </div>
                    <div className="text-muted-foreground flex justify-between text-xs">
                      <span>
                        <span className="text-green-500">{med.taken7}</span>{" "}
                        {t("insights.taken")}
                      </span>
                      <span>
                        <span className="text-orange-500">{med.skipped7}</span>{" "}
                        {t("insights.skipped")}
                      </span>
                      <span>
                        <span className="text-red-500">{med.missed7}</span>{" "}
                        {t("insights.missed")}
                      </span>
                    </div>

                    <MedicationComplianceCalendar medicationId={med.id} />

                    {medicationSummary ? (
                      <p className="text-muted-foreground text-sm leading-6">
                        {medicationSummary}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : null}

        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<Pill className="h-5 w-5" />}
          text={medicationComplianceStatus?.summary ?? null}
          hasProvider={medicationComplianceStatus?.hasProvider ?? false}
          cached={medicationComplianceStatus?.cached ?? false}
          updatedAt={medicationComplianceStatus?.updatedAt ?? null}
          loading={isMedicationComplianceStatusLoading}
        />
      </section>

      {/* Section 7: BMI */}
      <section id="section-bmi" className="scroll-mt-28 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {t("insights.bmiSectionTitle")}
          </h2>
          <Badge
            className={`border text-xs ${bmiSectionStatus.className}`}
            variant="outline"
          >
            {t(`insights.generalStatusBadge.${bmiSectionStatus.level}`)}
          </Badge>
        </div>

        {user?.heightCm ? (
          <HealthChart
            types={["WEIGHT"]}
            title={t("targets.bmi")}
            colors={["#f1fa8c"]}
            unit="kg/m²"
            valueMode="bmi"
            valueBands={bmiBands}
          />
        ) : (
          <p className="text-muted-foreground text-sm">{t("common.noData")}</p>
        )}

        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<Ruler className="h-5 w-5" />}
          text={bmiStatus?.text ?? null}
          hasProvider={bmiStatus?.hasProvider ?? false}
          cached={bmiStatus?.cached ?? false}
          updatedAt={bmiStatus?.updatedAt ?? null}
          loading={isBmiStatusLoading}
        />
      </section>
    </div>
  );
}

function MedicationComplianceCalendar({
  medicationId,
}: {
  medicationId: string;
}) {
  const { t } = useTranslations();
  const { data, isLoading } = useQuery({
    queryKey: ["compliance-chart-inline", medicationId],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as MedicationComplianceDailyResponse;
    },
    enabled: !!medicationId,
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="text-primary h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!data?.dailyCompliance) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-xs">
        {t("insights.complianceNoData")}
      </div>
    );
  }

  return (
    <div className="w-full">
      <ComplianceHeatmap dailyCompliance={data.dailyCompliance} stretch />
    </div>
  );
}

// ── Section Navigation ───────────────────────────────────────────────────────

const SECTION_IDS = [
  "section-general",
  "section-bp",
  "section-weight",
  "section-pulse",
  "section-mood",
  "section-meds",
  "section-bmi",
] as const;

const SECTION_LABEL_KEYS: Record<(typeof SECTION_IDS)[number], string> = {
  "section-general": "insights.navGeneral",
  "section-bp": "insights.navBloodPressure",
  "section-weight": "insights.navWeight",
  "section-pulse": "insights.navPulse",
  "section-mood": "insights.navMood",
  "section-meds": "insights.navMedication",
  "section-bmi": "insights.navBmi",
};

function InsightsSectionNav() {
  const { t } = useTranslations();
  const [activeId, setActiveId] = useState<string>(SECTION_IDS[0]);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );

    for (const id of SECTION_IDS) {
      const el = document.getElementById(id);
      if (el) observerRef.current.observe(el);
    }

    return () => observerRef.current?.disconnect();
  }, []);

  function scrollTo(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <nav className="bg-background/80 sticky top-0 z-30 -mx-4 overflow-x-auto border-b px-4 py-2 backdrop-blur-sm md:-mx-6 md:px-6">
      <div className="flex gap-2">
        {SECTION_IDS.map((id) => (
          <button
            key={id}
            onClick={() => scrollTo(id)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              activeId === id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {t(SECTION_LABEL_KEYS[id])}
          </button>
        ))}
      </div>
    </nav>
  );
}
