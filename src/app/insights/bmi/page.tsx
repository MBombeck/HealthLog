"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Ruler } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.25 W4 — `/insights/bmi`.
 *
 * Routed BMI sub-page. BMI is derived from `WEIGHT / (height/100)^2`,
 * so the chart sets `valueMode="bmi"` on `<HealthChart>` and the
 * underlying WEIGHT series is reused. When the user has no height set
 * the chart can't compute; we surface the same plain empty-state the
 * mother page used.
 */
const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false },
);

const BMI_BANDS = [
  { min: 0, max: 17, color: "#ff5555", opacity: 0.16 },
  { min: 17, max: 18.5, color: "#ffb86c", opacity: 0.18 },
  { min: 18.5, max: 24.9, color: "#50fa7b", opacity: 0.2 },
  { min: 24.9, max: 29.9, color: "#ffb86c", opacity: 0.18 },
  { min: 29.9, max: 120, color: "#ff5555", opacity: 0.16 },
];

export default function InsightsBmiPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: status, isLoading: isStatusLoading } = useInsightStatus("bmi");

  if (!user?.heightCm) {
    return (
      <SubPageShell title={t("insights.bmiSectionTitle")}>
        <EmptyState
          icon={<Ruler className="size-6" />}
          title={t("insights.bmiEmptyTitle")}
          description={t("insights.bmiEmptyDescription")}
          action={
            <Button size="sm" asChild>
              <Link href="/settings/account">
                {t("insights.bmiEmptyAction")}
              </Link>
            </Button>
          }
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.bmiSectionTitle")}
      description={t("insights.subPage.bmiDescription")}
    >
      <HealthChart
        chartKey="bmi"
        types={["WEIGHT"]}
        title={t("targets.bmi")}
        colors={["#f1fa8c"]}
        unit="kg/m²"
        valueMode="bmi"
        valueBands={BMI_BANDS}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />

      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Ruler className="h-5 w-5" />}
        text={status?.text ?? null}
        hasProvider={status?.hasProvider ?? false}
        cached={status?.cached ?? false}
        updatedAt={status?.updatedAt ?? null}
        loading={isStatusLoading}
      />
    </SubPageShell>
  );
}
