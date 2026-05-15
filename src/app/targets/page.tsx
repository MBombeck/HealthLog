"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { Card, CardContent } from "@/components/ui/card";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import {
  TargetCard,
  type TargetCardData,
} from "@/components/targets/target-card";
import { TargetsSummaryHeader } from "@/components/targets/targets-summary-header";
import { CoachDrawer } from "@/components/insights/coach-panel/coach-drawer";
import { useCoachHandoff } from "@/hooks/use-coach-handoff";

type TargetData = TargetCardData;

interface BpDiastolic {
  current: number | null;
  average30: number | null;
  range: { min: number; max: number } | null;
}

interface TargetPageSummary {
  targetsMetThisWeek: number;
  totalTargets: number;
  streakHighlight: { metric: string; days: number } | null;
}

interface TargetsResponse {
  targets: TargetData[];
  pageSummary?: TargetPageSummary;
  bpDiastolic: BpDiastolic;
  profile: {
    heightCm: number | null;
    age: number | null;
    gender: string | null;
    glucoseUnit?: string | null;
  };
}

/**
 * v1.4.25 W3e — provider-chain status used to gate the per-card Coach
 * CTA. Returns true when at least one provider is configured AND
 * enabled. The Settings → AI surface owns the same query
 * (`useQuery({ queryKey: ["insights", "provider-chain"] })`) so the
 * cache is shared.
 */
interface ProviderChainStatus {
  activeProvider: string | null;
  cachedActiveProvider: string | null;
  configuredChain: Array<{
    providerType: string;
    enabled: boolean;
    available: boolean;
  }>;
}

const GLUCOSE_TYPES = new Set([
  "BLOOD_GLUCOSE_FASTING",
  "BLOOD_GLUCOSE_POSTPRANDIAL",
  "BLOOD_GLUCOSE_RANDOM",
  "BLOOD_GLUCOSE_BEDTIME",
]);

/**
 * Fixed card order per Marc directive — explicitly NOT status-sorted.
 * Marc wants a stable visual hierarchy so the user's eye lands on the
 * same metric in the same place every visit. Cards whose type is not
 * in this list (glucose contexts, future metrics) sort after the
 * core six in their server-emitted order.
 */
const FIXED_TARGET_ORDER: Record<string, number> = {
  BLOOD_PRESSURE: 0,
  BLOOD_PRESSURE_IN_TARGET: 1,
  WEIGHT: 2,
  PULSE: 3,
  BMI: 4,
  MOOD_SCORE: 5,
  MOOD_STABILITY: 6,
  MEDICATION_COMPLIANCE: 7,
  SLEEP_DURATION: 8,
  BODY_FAT: 9,
  ACTIVITY_STEPS: 10,
};

function sortKey(target: TargetData): number {
  return FIXED_TARGET_ORDER[target.type] ?? 100;
}

/**
 * Source-citation URL for each target type. Kept on the page (rather
 * than the card) so the card stays presentational and the routing
 * stays declarative.
 */
function getTargetSourceLink(target: TargetData): string | null {
  if (target.type === "WEIGHT" || target.type === "BMI") {
    return "https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight";
  }
  if (
    target.type === "BLOOD_PRESSURE" ||
    target.type === "BLOOD_PRESSURE_IN_TARGET"
  ) {
    return "https://academic.oup.com/eurheartj/article/39/33/3021/5079119";
  }
  if (target.type === "PULSE") {
    if (target.source.includes("CDC/NCHS")) {
      return "https://www.cdc.gov/nchs/data/nhsr/nhsr041.pdf";
    }
    if (target.source.includes("AHA")) {
      return "https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse";
    }
  }
  if (target.type === "SLEEP_DURATION") {
    return "https://aasm.org/seven-or-more-hours-of-sleep-per-night-a-health-necessity-for-adults/";
  }
  if (target.type === "BODY_FAT") {
    return "https://www.acefitness.org/resources/everyone/blog/6596/what-are-the-guidelines-for-percentage-of-body-fat-loss/";
  }
  if (target.type === "ACTIVITY_STEPS") {
    return "https://www.who.int/publications/i/item/9789240015128";
  }
  return null;
}

export default function TargetsPage() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "targets"],
    queryFn: async () => {
      const res = await fetch("/api/insights/targets");
      if (!res.ok) throw new Error(t("targets.loadError"));
      const json = await res.json();
      return json.data as TargetsResponse;
    },
    enabled: isAuthenticated,
  });

  // v1.4.25 W3e — share the cache with Settings → AI section. When the
  // user has no configured provider, `activeProvider` is null and the
  // per-card Coach CTA hides entirely (no broken-button state).
  const { data: chainStatus } = useQuery({
    queryKey: ["insights", "provider-chain"],
    queryFn: async () => {
      const res = await fetch("/api/insights/provider-chain");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ProviderChainStatus;
    },
    enabled: isAuthenticated,
  });
  const aiEnabled = chainStatus?.activeProvider != null;

  // v1.4.25 W3e — Coach drawer state owned by the page. The per-card
  // CTA + summary header both feed the same drawer so the user only
  // ever sees one drawer instance.
  const { coachOpen, setCoachOpen, coachPrefill, coachScope, askCoach } =
    useCoachHandoff();

  const visibleTargets = useMemo(() => {
    if (!data) return [] as TargetData[];
    const displayGlucoseUnit = resolveGlucoseUnit(
      data.profile.glucoseUnit ?? null,
    );
    return data.targets
      .filter((target) => target.current != null)
      .map((target) => {
        if (!GLUCOSE_TYPES.has(target.type)) return target;
        // Server label is an i18n key for glucose; resolve here.
        const label = t(target.label);
        // Convert mg/dL canonical values to the user's display unit.
        const convert = (v: number | null) =>
          v == null ? null : convertGlucose(v, displayGlucoseUnit);
        return {
          ...target,
          label,
          unit: displayGlucoseUnit,
          current: convert(target.current),
          average30: convert(target.average30),
          range: target.range
            ? {
                min: convertGlucose(target.range.min, displayGlucoseUnit),
                max: convertGlucose(target.range.max, displayGlucoseUnit),
              }
            : null,
        };
      })
      .sort((a, b) => sortKey(a) - sortKey(b));
  }, [data, t]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
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

  const profileIncomplete = !data.profile.heightCm || !data.profile.age;

  return (
    // v1.4.19 phase A7 — the maintainer reported "relativ viel Platz" wasted
    // between the overview header and the first values on `/targets`.
    // Tighten the rhythm from `space-y-8` (32 px) to `space-y-6`
    // (24 px) — that matches the admin / settings pages.
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("targets.title")}</h1>
        <p className="mt-2 text-sm">{t("targets.introText")}</p>
      </div>

      {/* Profile incomplete hint */}
      {profileIncomplete && (
        <Card className="border-l-4 border-l-orange-500">
          <CardContent className="flex gap-3 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
            <div>
              <p className="text-sm font-medium">
                {t("targets.profileIncomplete")}
              </p>
              <p className="text-muted-foreground text-sm">
                {!data.profile.heightCm && !data.profile.age
                  ? t("targets.profileIncompleteHeightAge")
                  : !data.profile.heightCm
                    ? t("targets.profileIncompleteHeight")
                    : t("targets.profileIncompleteAge")}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* v1.4.25 W3e — page-level summary line. Renders nothing when
          the API hasn't shipped pageSummary yet (older clients during
          rollout / mocked test fixtures that pre-date this addition). */}
      {data.pageSummary && (
        <TargetsSummaryHeader
          targetsMetThisWeek={data.pageSummary.targetsMetThisWeek}
          totalTargets={data.pageSummary.totalTargets}
          streakHighlight={data.pageSummary.streakHighlight}
        />
      )}

      {/* v1.4.25 W3e — responsive grid. Mobile (default): single
          column. sm (640px+): two columns. lg (1024px+): three columns,
          matching the dashboard / insights rhythm. Cards reflow
          internally too — see <TargetCard>. */}
      {visibleTargets.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
          {visibleTargets.map((target) => (
            <TargetCard
              key={target.type}
              target={target}
              bpDiastolic={
                target.type === "BLOOD_PRESSURE" ? data.bpDiastolic : undefined
              }
              aiEnabled={aiEnabled}
              onAskCoach={askCoach}
              sourceLink={getTargetSourceLink(target)}
            />
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground border-border rounded-xl border p-6 text-sm">
          {t("targets.noMeasurementData")}
        </div>
      )}

      {/* v1.4.25 W3e — Coach drawer mounted at the page level. The
          drawer is fully-controlled; per-card CTAs flip `coachOpen`
          and seed `coachPrefill` via the `askCoach()` hook callback. */}
      <CoachDrawer
        open={coachOpen}
        onOpenChange={setCoachOpen}
        prefill={coachPrefill}
        key={`coach-drawer-${coachScope?.sources?.join(",") ?? "default"}`}
      />
    </div>
  );
}
