"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Activity, Heart, Percent, Plus, Smile, TrendingUp, Waves } from "lucide-react";
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
  const [quickEntryDialog, setQuickEntryDialog] = useState<"measurement" | "mood" | null>(null);

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

  const { data: moodData } = useQuery({
    queryKey: queryKeys.moodAnalytics(),
    queryFn: async () => {
      const res = await fetch("/api/mood/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as { entries: Array<{ date: string; score: number; samples: number }>; summary: DataSummary };
    },
    enabled: isAuthenticated,
  });

  const w = data?.summaries.WEIGHT;
  const sys = data?.summaries.BLOOD_PRESSURE_SYS;
  const dia = data?.summaries.BLOOD_PRESSURE_DIA;
  const p = data?.summaries.PULSE;
  const bf = data?.summaries.BODY_FAT;
  const showBodyFatCard = (bf?.count ?? 0) > 0;
  const moodSummary = moodData?.summary;
  const showMoodCard = (moodSummary?.count ?? 0) > 0;
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
            <DropdownMenuItem onClick={() => setQuickEntryDialog("measurement")}>
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
            slope30={moodSummary?.slope30 ?? null}
            icon={Smile}
          />
        ) : null}
      </div>

      <HealthChart
        types={["WEIGHT"]}
        title={t("dashboard.weight")}
        colors={["#bd93f9"]}
        unit="kg"
        valueBands={weightBands}
      />

      <HealthChart
        types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
        title={t("dashboard.bloodPressure")}
        colors={["#ff79c6", "#8be9fd"]}
        unit="mmHg"
        yAxisUnit="Hg"
        targetZones={bpTargetZones}
      />

      <HealthChart
        types={["PULSE"]}
        title={t("dashboard.pulse")}
        colors={["#50fa7b"]}
        unit="bpm"
        valueBands={pulseBands}
      />
      {user?.heightCm ? (
        <HealthChart
          types={["WEIGHT"]}
          title={t("targets.bmi")}
          colors={["#f1fa8c"]}
          unit="kg/m²"
          valueMode="bmi"
          valueBands={[
            {
              min: 0,
              max: 17,
              color: "#ff5555",
              opacity: 0.16,
            },
            {
              min: 17,
              max: 18.5,
              color: "#ffb86c",
              opacity: 0.18,
            },
            {
              min: 18.5,
              max: 24.9,
              color: "#50fa7b",
              opacity: 0.2,
            },
            {
              min: 24.9,
              max: 29.9,
              color: "#ffb86c",
              opacity: 0.18,
            },
            {
              min: 29.9,
              max: 120,
              color: "#ff5555",
              opacity: 0.16,
            },
          ]}
        />
      ) : null}

      {showBodyFatCard && (
        <HealthChart
          types={["BODY_FAT"]}
          title={t("dashboard.bodyFat")}
          colors={["#ffb86c"]}
          unit="%"
          valueBands={bodyFatBands}
        />
      )}
      {showMoodCard && <MoodChart />}
    </div>
  );
}
