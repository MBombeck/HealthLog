"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import Link from "next/link";
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
import { ComplianceHeatmap } from "@/components/charts/compliance-heatmap";
import {
  Activity,
  Heart,
  HeartPulse,
  Loader2,
  Pill,
  Ruler,
  Scale,
  Smile,
  TrendingUp,
} from "lucide-react";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { InsightAdvisorCard } from "@/components/insights/insight-advisor-card";
import { HeroStrip } from "@/components/insights/hero-strip";
import { InsightsTabStrip } from "@/components/insights/insights-tab-strip";
import { DailyBriefing } from "@/components/insights/daily-briefing";
import { CoachDrawer } from "@/components/insights/coach-panel/coach-drawer";
import { TrendsRow } from "@/components/insights/trends-row";
import { CorrelationRow } from "@/components/insights/correlation-row";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import type { CorrelationResult } from "@/lib/insights/correlations";
import { toWeekISO } from "@/lib/insights/week-iso";
// Recharts is ~108 KiB Brotli — defer-load it via a self-contained scatter
// wrapper so the bundle only lands once a correlation card actually renders.
// Every scatter card sits inside a `length >= 5` gate and below the fold,
// matching the existing HealthChart / MoodChart pattern. The earlier attempt
// (v1.5 phase 4) wrapped each Recharts primitive (XAxis/YAxis/etc.) in
// next/dynamic individually, which broke Recharts' internal child-type
// detection (`findAllByType` compares against the original component
// identity, not the dynamic HOC). Splitting at the wrapper level keeps the
// bundle savings while preserving visual parity. See
// docs/audit/v15-performance.md (v1.5 phase-4 perf audit).
const ScatterCorrelationChart = dynamic(
  () =>
    import("@/components/charts/scatter-correlation-chart").then((mod) => ({
      default: mod.ScatterCorrelationChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted/40 h-[250px] w-full animate-pulse rounded-md motion-reduce:animate-none" />
    ),
  },
);
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
import type { DataSummary } from "@/lib/analytics/trends";
import {
  resolveDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

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
  /**
   * v1.4.20 phase B3 — three pre-defined correlation hypothesis runners
   * computed server-side. Optional + nullable so the page handles the
   * v1.4.19-style cached `analytics` payload without flashing an empty
   * row before the next refetch.
   */
  correlations?: {
    bpCompliance: CorrelationResult;
    moodPulse: CorrelationResult;
    weightWeekday: CorrelationResult;
  } | null;
  /**
   * v1.4.20 phase B5 — composite Personal Health Score with sub-component
   * breakdown + delta vs last week. Optional + nullable so older cached
   * `analytics` payloads continue to render the rest of the page; the
   * hero panel hides cleanly when the field is absent.
   */
  healthScore?: {
    score: number;
    band: "green" | "yellow" | "red";
    components: {
      bp: { value: number | null; weight: number };
      weight: { value: number | null; weight: number };
      mood: { value: number | null; weight: number };
      compliance: { value: number | null; weight: number };
    };
    delta: number | null;
  } | null;
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

/**
 * v1.4.16 phase B1b — pick the freshest ISO timestamp from a list so the
 * page hero's "Generated …" caption surfaces a single representative
 * value across the per-section caches. Returns null when nothing's
 * been generated yet so the caption hides cleanly.
 */
function freshestUpdatedAt(
  candidates: Array<string | null | undefined>,
): string | null {
  let freshest: number | null = null;
  let freshestIso: string | null = null;
  for (const iso of candidates) {
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) continue;
    if (freshest === null || ms > freshest) {
      freshest = ms;
      freshestIso = iso;
    }
  }
  return freshestIso;
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

function getMoodSectionStatus(input: { avg30: number | null | undefined }): {
  level: "good" | "watch" | "critical";
  className: string;
} {
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

  if (
    input.average30 == null ||
    input.totalEvents < MIN_EVENTS_FOR_ASSESSMENT
  ) {
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

// v1.4.20 phase D reconcile — module-scope so the map isn't recreated
// on every render of `<InsightsPage>` (the page renders often on
// TanStack-Query refetches; this map carries no closures over locals).
const STORYBOARD_COLOR_BY_CATEGORY: Record<string, string> = {
  medication: "var(--dracula-pink)",
  event: "var(--dracula-cyan)",
  milestone: "var(--dracula-green)",
  warning: "var(--dracula-orange)",
};

export default function InsightsPage() {
  const { isAuthenticated, user } = useAuth();
  const { t, locale } = useTranslations();

  // v1.4.20 phase B2b — Coach drawer state. The hero strip's
  // "Ask the coach" button + suggested-prompt chips toggle the drawer
  // here; the drawer ingests `coachPrefill` once on open and resets on
  // close so the next open starts blank.
  const [coachOpen, setCoachOpen] = useState<boolean>(false);
  const [coachPrefill, setCoachPrefill] = useState<string | null>(null);

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

  // v1.4.16 phase B8 — share comparison baseline between dashboard
  // and insights surfaces. The two pages read from the same persisted
  // preference so a toggle flip in Settings → Dashboard updates both
  // surfaces atomically.
  const { data: layoutData } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
    enabled: isAuthenticated,
  });
  const compareBaseline =
    resolveDashboardLayout(layoutData).comparisonBaseline ?? "none";

  // v1.4.16 phase D reconcile (CRITICAL C1) — pull the rich advisor
  // payload (severity-ordered recommendations + rationale + confidence
  // + medical-citation footnotes + thumbs feedback) so this page
  // surfaces the polished `<InsightAdvisorCard>` from B5c/d/e/B1b
  // instead of the v1.4.15 text-only `<InsightStatusCard>` summary.
  // Cache-aware: a regenerate on the dashboard preview (C2) hot-swaps
  // this query under the same key.
  const advisor = useInsightsAdvisorQuery(isAuthenticated);

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

  const { data: bloodPressureStatus, isLoading: isBloodPressureStatusLoading } =
    useQuery({
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

  const { data: weightStatus, isLoading: isWeightStatusLoading } = useQuery({
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

  const { data: pulseStatus, isLoading: isPulseStatusLoading } = useQuery({
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

  const { data: bmiStatus, isLoading: isBmiStatusLoading } = useQuery({
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

  const { data: moodStatus, isLoading: isMoodStatusLoading } = useQuery({
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
  const w = analytics?.summaries?.WEIGHT;
  const sys = analytics?.summaries?.BLOOD_PRESSURE_SYS;
  const dia = analytics?.summaries?.BLOOD_PRESSURE_DIA;
  const p = analytics?.summaries?.PULSE;
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
    data?.medications?.filter(
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
    // v1.4.15 phase-C5: replace bare "no data" text with EmptyState +
    // CTA into /measurements so the user has a single-click path out
    // of the empty insights view.
    return (
      <EmptyState
        icon={<TrendingUp className="size-6" />}
        title={t("insights.emptyTitle")}
        description={t("insights.emptyDescription")}
        action={
          <Button size="sm" asChild>
            <Link href="/measurements">
              {t("insights.emptyAddMeasurement")}
            </Link>
          </Button>
        }
      />
    );
  }

  // Wire the hero's "Generated …" caption from the freshest of the per-
  // section caches so the user gets a single timestamp without having to
  // expand every card. Falls back to null when no section has shipped a
  // payload yet (the hero just hides the caption).
  const heroUpdatedAt = freshestUpdatedAt([
    bloodPressureStatus?.updatedAt,
    weightStatus?.updatedAt,
    pulseStatus?.updatedAt,
    bmiStatus?.updatedAt,
    moodStatus?.updatedAt,
    medicationComplianceStatus?.updatedAt,
  ]);

  // v1.4.20 phase B1 — derive the user's display name for the hero
  // greeting. We use the username (HealthLog has no separate display-
  // name field) and stop at the first whitespace so a "first.last"
  // handle reads cleanly. Falls back to no-name greeting when the user
  // has no username so the hero never paints "Good morning, undefined".
  const heroGreetingName =
    user?.username?.trim() && user.username.trim().length > 0
      ? user.username.split(/\s+/)[0]
      : null;
  const briefingPayload = advisor.payload?.dailyBriefing ?? null;
  const heroStripUpdatedAt = advisor.payload?.cachedAt ?? heroUpdatedAt;

  // v1.4.20 phase B4 — surface a banner-card on the hero whenever the
  // cached AI payload carries a weeklyReport block. The banner deep-
  // links into `/insights/report/[week]` for Read / Share / Export PDF.
  const weeklyReport = (
    advisor.payload?.insights as
      | {
          weeklyReport?: { weekISO: string } | null;
        }
      | undefined
  )?.weeklyReport;
  const weeklyReportReady = weeklyReport
    ? {
        weekISO: weeklyReport.weekISO,
        href: `/insights/report/${weeklyReport.weekISO}`,
      }
    : undefined;
  // v1.4.20 phase D reconcile — the action-row "Generate weekly report"
  // button links into the current ISO week's report (B4 shipped the
  // route, so the disabled-primary placeholder no longer makes sense).
  const currentWeekHref = `/insights/report/${toWeekISO(new Date())}`;

  // v1.4.20 phase B4 — storyboard annotations for the 90-day BP chart.
  // The advisor payload may carry up to 20 entries; we transform them
  // into the {date, label, color} shape <HealthChart> consumes. The
  // colour map mirrors the four canonical categories (hoisted to
  // module scope above). Cached payloads from before PROMPT_VERSION
  // 4.20.2 simply produce an empty array.
  const rawStoryboard = (
    advisor.payload?.insights as
      | {
          storyboardAnnotations?: Array<{
            date: string;
            label: string;
            category: string;
          }>;
        }
      | undefined
  )?.storyboardAnnotations;
  const bpStoryboardAnnotations = (rawStoryboard ?? []).map((entry) => ({
    date: entry.date,
    label: entry.label,
    color:
      STORYBOARD_COLOR_BY_CATEGORY[entry.category] ?? "var(--dracula-purple)",
  }));

  return (
    <div className="space-y-8">
      {/* v1.4.25 W3 — section tabs + regenerate affordance live in the
          dedicated `<InsightsTabStrip>` component. The strip is sticky
          so the user can re-run the analysis without scrolling back to
          the hero band. The hero strip no longer carries its own
          regenerate button — the icon-only RefreshCw on this strip is
          the canonical page-level affordance. */}
      <InsightsTabStrip
        onRegenerate={advisor.regenerate}
        regenerating={advisor.isRegenerating}
      />

      <HeroStrip
        briefing={briefingPayload}
        updatedAt={heroStripUpdatedAt}
        userName={heroGreetingName}
        onAskCoach={(prefill?: string) => {
          // The action-row button passes no prefill (drawer opens blank);
          // the Health Score panel passes a score-aware question. Both
          // share the same drawer state so the user only ever sees one
          // drawer instance.
          setCoachPrefill(prefill ?? null);
          setCoachOpen(true);
        }}
        onPickPrompt={(prompt) => {
          setCoachPrefill(prompt);
          setCoachOpen(true);
        }}
        weeklyReportReady={weeklyReportReady}
        weeklyReportHref={currentWeekHref}
        healthScore={analytics?.healthScore ?? undefined}
      />

      <DailyBriefing
        briefing={briefingPayload}
        updatedAt={heroStripUpdatedAt}
        loading={advisor.isLoading}
        onRegenerate={advisor.regenerate}
        regenerating={advisor.isRegenerating}
      />

      {/* v1.4.20 phase B3 — Correlation discovery row. Three pre-defined
          hypotheses (BP × compliance, mood × pulse, weight × weekday) gated
          on n >= 14 + p < 0.05; cards below the bar render a per-card
          empty-state. The row-level disclaimer ("Relationships are
          observational, not causal …") sits below the grid once. */}
      {analytics?.correlations && (
        <CorrelationRow results={analytics.correlations} />
      )}

      {/* v1.4.20 phase B3 — Trends row. Mini BP / Weight / Mood charts
          with an inline AI-authored sentence below each. Annotations come
          from `advisor.payload.trendAnnotations` (PROMPT_VERSION 4.20.1+);
          legacy cached payloads simply paint the per-metric empty hint. */}
      <TrendsRow annotations={advisor.payload?.trendAnnotations ?? null} />

      {/* v1.4.16 phase D reconcile (CRITICAL C1) — wire the polished
          `<InsightAdvisorCard>` (severity-ordered recommendations grid +
          per-rec rationale expand + confidence meter + thumbs feedback +
          medical-citation footnotes) into the live route. The
          per-section status cards stay below as supplemental detail. */}
      <InsightAdvisorCard
        insight={advisor.payload?.insights ?? null}
        loading={advisor.isLoading}
        error={advisor.error?.message ?? null}
        cachedAt={advisor.payload?.cachedAt ?? null}
        legacyPayload={advisor.payload?.legacyPayload ?? false}
      />

      {/* Section 3: Blood pressure */}
      <section id="section-bp" className="scroll-mt-16 space-y-4">
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
          chartKey="bp"
          types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
          title={t("charts.bloodPressure")}
          colors={["#ff79c6", "#8be9fd"]}
          unit="mmHg"
          yAxisUnit="Hg"
          targetZones={bpTargetZones}
          compareBaseline={compareBaseline}
          annotations={bpStoryboardAnnotations}
        />

        {/* v1.4.22 A4 — row-fill rule: 2 cards → 50/50 (xl), 1 card →
            100 % width. When the mood section is hidden the BP-medication
            card collapses to full-width instead of leaving the right
            half empty. */}
        <div
          className={
            showMoodSection ? "grid gap-4 xl:grid-cols-2" : "grid gap-4"
          }
        >
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
                  <ScatterCorrelationChart
                    data={data.bpMedicationScatterData}
                    fill="var(--dracula-orange)"
                    xAxis={{
                      dataKey: "continuityPct",
                      name: t("insights.continuityLabel"),
                      unit: "%",
                      label: t("insights.continuityBpLabel"),
                    }}
                    yAxis={{
                      dataKey: "sysBP",
                      name: "Sys. BP",
                      unit: " mmHg",
                    }}
                    tooltipFormatter={(value, name) => [
                      `${value}${name === t("insights.continuityLabel") ? "%" : " mmHg"}`,
                      name,
                    ]}
                  />
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
                    <ScatterCorrelationChart
                      data={data?.moodBpScatterData}
                      fill="var(--dracula-lavender)"
                      xAxis={{
                        dataKey: "mood",
                        name: t("insights.moodScoreLabel"),
                        label: t("insights.moodScoreLabel"),
                        domain: [1, 5],
                        ticks: [1, 2, 3, 4, 5],
                      }}
                      yAxis={{
                        dataKey: "sysBP",
                        name: "Sys. BP",
                        unit: " mmHg",
                      }}
                    />
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
                    <p className="text-xs">
                      {t("insights.minMoodCorrelationData")}
                    </p>
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
      <section id="section-weight" className="scroll-mt-16 space-y-4">
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
          chartKey="weight"
          types={["WEIGHT"]}
          title={t("charts.weight")}
          colors={["#bd93f9"]}
          unit="kg"
          valueBands={weightBands}
          compareBaseline={compareBaseline}
        />

        {/* v1.4.22 A4 — row-fill rule: 2 cards → 50/50 (xl), 1 card →
            100 % width. Mirrors the BP-section grid normalisation. */}
        <div
          className={
            showMoodSection ? "grid gap-4 xl:grid-cols-2" : "grid gap-4"
          }
        >
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
                  <ScatterCorrelationChart
                    data={data.scatterData}
                    fill="var(--dracula-cyan)"
                    xAxis={{
                      dataKey: "weight",
                      name: t("dashboard.weight"),
                      unit: " kg",
                      label: t("insights.weightKgLabel"),
                      tickFormatter: (value: number) => value.toFixed(1),
                    }}
                    yAxis={{
                      dataKey: "sysBP",
                      name: "Sys. BP",
                      unit: " mmHg",
                    }}
                    tooltipFormatter={(value, name) => [
                      `${value} ${name === t("dashboard.weight") ? "kg" : "mmHg"}`,
                      name,
                    ]}
                  />
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
                    <ScatterCorrelationChart
                      data={data?.moodWeightScatterData}
                      fill="var(--dracula-lavender)"
                      xAxis={{
                        dataKey: "mood",
                        name: t("insights.moodScoreLabel"),
                        label: t("insights.moodScoreLabel"),
                        domain: [1, 5],
                        ticks: [1, 2, 3, 4, 5],
                      }}
                      yAxis={{
                        dataKey: "weight",
                        name: t("dashboard.weight"),
                        unit: " kg",
                      }}
                    />
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
                    <p className="text-xs">
                      {t("insights.minMoodCorrelationData")}
                    </p>
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
      <section id="section-pulse" className="scroll-mt-16 space-y-4">
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
          chartKey="pulse"
          types={["PULSE"]}
          title={t("charts.pulse")}
          colors={["#50fa7b"]}
          unit="bpm"
          valueBands={pulseBands}
          compareBaseline={compareBaseline}
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
        <section id="section-mood" className="scroll-mt-16 space-y-4">
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

          <MoodChart chartKey="mood" compareBaseline={compareBaseline} />

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
      <section id="section-meds" className="scroll-mt-16 space-y-4">
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
          /* v1.4.22 A4 — row-fill rule: a single medication card fills
             100 % width instead of half the row. */
          <div
            className={
              data.medications.length >= 2
                ? "grid gap-4 sm:grid-cols-2"
                : "grid gap-4"
            }
          >
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
      <section id="section-bmi" className="scroll-mt-16 space-y-4">
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
            chartKey="bmi"
            types={["WEIGHT"]}
            title={t("targets.bmi")}
            colors={["#f1fa8c"]}
            unit="kg/m²"
            valueMode="bmi"
            valueBands={bmiBands}
            compareBaseline={compareBaseline}
          />
        ) : (
          // v1.4.15 phase-C5: explicit empty state when the user
          // hasn't set a height yet — without it the BMI card looked
          // broken. Plain variant so the dashed border doesn't double
          // up inside the section card.
          <EmptyState
            variant="plain"
            size="compact"
            icon={<Ruler className="size-5" />}
            title={t("insights.bmiEmptyTitle")}
            description={t("insights.bmiEmptyDescription")}
            action={
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/account">
                  {t("insights.bmiEmptyAction")}
                </Link>
              </Button>
            }
          />
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

      {/* v1.4.20 phase B2b — AI Coach drawer.
          v1.4.23 H3 — `prefill` is a controlled prop now; the drawer
          watches it via an in-render ref and resets the composer
          when the parent changes which suggested-prompt chip is
          active. The old `key={prefill}` weaponise-React-keys pattern
          is gone (Sr-HIGH-4). */}
      <CoachDrawer
        open={coachOpen}
        onOpenChange={setCoachOpen}
        prefill={coachPrefill}
      />
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
// v1.4.25 W3 — the legacy inline `InsightsSectionNav` was promoted to a
// dedicated component at `src/components/insights/insights-tab-strip.tsx`
// so the regenerate affordance could share the sticky strip with the
// metric pills. The page just mounts `<InsightsTabStrip>` near the top
// of the layout.
