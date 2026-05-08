"use client";

import { useState } from "react";
import type { InsightResult, InsightFinding } from "@/lib/ai/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Minus,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
} from "lucide-react";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { HealthChart } from "@/components/charts/health-chart";
import {
  parseChartTokens,
  stripChartTokens,
  tokenToMetric,
  type ChartToken,
} from "@/lib/insights/chart-tokens";

// ─── Types ────────────────────────────────────────────────

interface InsightAdvisorCardProps {
  title: string;
  icon?: React.ReactNode;
  insight: InsightResult | null;
  loading?: boolean;
  error?: string | null;
  onRegenerate?: () => void;
  regenerating?: boolean;
  cachedAt?: string | null;
}

// ─── Classification Colors ───────────────────────────────

const CLASSIFICATION_STYLES: Record<string, { badge: string; border: string }> =
  {
    optimal: {
      badge:
        "bg-dracula-green/10 text-dracula-green border border-dracula-green/25 hover:bg-dracula-green/15",
      border: "border-l-dracula-green",
    },
    gut: {
      badge:
        "bg-dracula-cyan/10 text-dracula-cyan border border-dracula-cyan/25 hover:bg-dracula-cyan/15",
      border: "border-l-dracula-cyan",
    },
    grenzwertig: {
      badge:
        "bg-dracula-yellow/10 text-dracula-yellow border border-dracula-yellow/25 hover:bg-dracula-yellow/15",
      border: "border-l-dracula-yellow",
    },
    erhoht: {
      badge:
        "bg-dracula-orange/10 text-dracula-orange border border-dracula-orange/25 hover:bg-dracula-orange/15",
      border: "border-l-dracula-orange",
    },
    kritisch: {
      badge:
        "bg-dracula-red/10 text-dracula-red border border-dracula-red/25 hover:bg-dracula-red/15",
      border: "border-l-dracula-red",
    },
  };

// ─── Assessment Icons ─────────────────────────────────────

function AssessmentIcon({
  assessment,
}: {
  assessment: InsightFinding["assessment"];
}) {
  switch (assessment) {
    case "positive":
      return <CheckCircle2 className="text-dracula-green h-4 w-4 shrink-0" />;
    case "neutral":
      return <Minus className="text-muted-foreground h-4 w-4 shrink-0" />;
    case "attention":
      return <AlertCircle className="text-dracula-orange h-4 w-4 shrink-0" />;
    case "warning":
      return <AlertTriangle className="text-dracula-red h-4 w-4 shrink-0" />;
  }
}

// ─── Hero Finding ─────────────────────────────────────────

const HERO_STYLES: Record<
  InsightFinding["assessment"],
  { wrapper: string; icon: string; label: string }
> = {
  positive: {
    wrapper:
      "from-dracula-green/15 via-dracula-green/5 to-transparent border-l-dracula-green",
    icon: "text-dracula-green",
    label: "text-dracula-green",
  },
  neutral: {
    wrapper:
      "from-dracula-cyan/12 via-dracula-cyan/4 to-transparent border-l-dracula-cyan",
    icon: "text-dracula-cyan",
    label: "text-dracula-cyan",
  },
  attention: {
    wrapper:
      "from-dracula-orange/15 via-dracula-orange/5 to-transparent border-l-dracula-orange",
    icon: "text-dracula-orange",
    label: "text-dracula-orange",
  },
  warning: {
    wrapper:
      "from-dracula-red/15 via-dracula-red/5 to-transparent border-l-dracula-red",
    icon: "text-dracula-red",
    label: "text-dracula-red",
  },
};

function HeroFinding({ finding }: { finding: InsightFinding }) {
  const { t } = useTranslations();
  const style = HERO_STYLES[finding.assessment];
  const labelKey =
    finding.assessment === "positive"
      ? "insights.heroFindingPositive"
      : finding.assessment === "warning"
        ? "insights.heroFindingWarning"
        : finding.assessment === "attention"
          ? "insights.heroFindingAttention"
          : "insights.heroFindingNeutral";
  const labelTokens = parseChartTokens(finding.label);
  const cleanLabel = stripChartTokens(finding.label);
  const guidelineTokens = finding.guideline
    ? parseChartTokens(finding.guideline)
    : [];
  const cleanGuideline = finding.guideline
    ? stripChartTokens(finding.guideline)
    : "";
  return (
    <div
      data-slot="insight-hero-finding"
      className={`rounded-lg border-l-2 bg-gradient-to-br ${style.wrapper} px-4 py-3.5`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className={`mt-0.5 shrink-0 ${style.icon}`}>
            <AssessmentIcon assessment={finding.assessment} />
          </div>
          <div className="min-w-0 space-y-1">
            <p
              className={`text-xs font-semibold tracking-widest uppercase ${style.label}`}
            >
              {t(labelKey)}
            </p>
            <p className="text-sm leading-snug font-medium">{cleanLabel}</p>
            {cleanGuideline && (
              <p className="text-muted-foreground text-xs leading-snug">
                {cleanGuideline}
              </p>
            )}
          </div>
        </div>
        <span className="shrink-0 text-base leading-snug font-semibold tabular-nums">
          {finding.value}
        </span>
      </div>
      {(labelTokens.length > 0 || guidelineTokens.length > 0) && (
        <div className="mt-3">
          <InlineCharts tokens={[...labelTokens, ...guidelineTokens]} />
        </div>
      )}
    </div>
  );
}

// ─── Confidence Colors ────────────────────────────────────

const CONFIDENCE_STYLES: Record<string, string> = {
  hoch: "text-dracula-green",
  mittel: "text-dracula-yellow",
  gering: "text-dracula-orange",
};

const CONFIDENCE_LABEL_KEYS: Record<string, string> = {
  hoch: "insights.confidenceHoch",
  mittel: "insights.confidenceMittel",
  gering: "insights.confidenceGering",
};

// ─── Inline Chart Renderer ────────────────────────────────
//
// Expand a list of allowlisted ChartTokens into HealthChart instances.
// HealthChart already understands the `MeasurementType`-style strings
// (WEIGHT, BLOOD_PRESSURE_SYS, …); the synthetic MOOD and COMPLIANCE
// tokens map to the dedicated chart components shipped elsewhere — for
// now we render them as a HealthChart with the token's metric name as
// the type, which the chart will gracefully render empty if there's no
// matching data, instead of silently swallowing the user's expectation.
//
// Tokens are deduped per call so the prose `metric:WEIGHT … metric:WEIGHT`
// doesn't render the same chart twice in a row.

const INLINE_CHART_TITLE_KEYS: Record<string, string> = {
  WEIGHT: "charts.weight",
  BLOOD_PRESSURE_SYS: "charts.systolic",
  BLOOD_PRESSURE_DIA: "charts.diastolic",
  PULSE: "charts.pulse",
  BODY_FAT: "charts.bodyFat",
  SLEEP_DURATION: "charts.sleep",
  ACTIVITY_STEPS: "charts.steps",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
  TOTAL_BODY_WATER: "charts.bodyWater",
  BONE_MASS: "charts.boneMass",
  OXYGEN_SATURATION: "charts.spo2",
  MOOD: "insights.navMood",
  COMPLIANCE: "insights.navMedication",
};

function InlineCharts({ tokens }: { tokens: ChartToken[] }) {
  const { t } = useTranslations();
  if (tokens.length === 0) return null;

  // Dedup while preserving the order the model emitted them.
  const seen = new Set<ChartToken>();
  const unique: ChartToken[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }

  return (
    <div data-slot="insight-inline-charts" className="space-y-3">
      {unique.map((token) => {
        const metric = tokenToMetric(token);
        const titleKey = INLINE_CHART_TITLE_KEYS[metric];
        const title = titleKey ? t(titleKey) : metric;
        return (
          <div
            key={token}
            data-slot="insight-inline-chart"
            data-metric={metric}
          >
            <HealthChart types={[metric]} title={title} />
          </div>
        );
      })}
    </div>
  );
}

// ─── Section Separator ────────────────────────────────────

function SectionSeparator({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
      <span>{label}</span>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────

export function InsightAdvisorCard({
  title,
  icon,
  insight,
  loading = false,
  error = null,
  onRegenerate,
  regenerating = false,
  cachedAt,
}: InsightAdvisorCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [dataQualityOpen, setDataQualityOpen] = useState(false);

  const classStyle = insight
    ? (CLASSIFICATION_STYLES[insight.classification] ??
      CLASSIFICATION_STYLES.gut)
    : CLASSIFICATION_STYLES.gut;

  // ── Loading State ─────────────────────────────────────
  if (loading && !insight) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="text-dracula-purple h-6 w-6 animate-spin" />
          <span className="text-muted-foreground ml-2 text-sm">
            {t("insights.generating")}
          </span>
        </CardContent>
      </Card>
    );
  }

  // ── Empty / No Data State ─────────────────────────────
  if (!insight) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {icon ?? <Sparkles className="text-dracula-purple h-5 w-5" />}
              <CardTitle className="text-lg">
                {t("insights.aiAnalysisTitle")}
              </CardTitle>
            </div>
          </div>
          <p className="text-muted-foreground text-sm">{title}</p>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg p-3 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {!error && (
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-muted-foreground text-sm">
                {t("insights.noAnalysisYet")}
              </p>
              {onRegenerate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRegenerate}
                  disabled={regenerating}
                >
                  {regenerating ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("insights.startAnalysis")}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Full Insight Card ─────────────────────────────────
  return (
    <Card className="animate-insight-in">
      {/* Header */}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon ?? <Sparkles className="text-dracula-purple h-5 w-5" />}
            <CardTitle className="text-lg">
              {t("insights.aiAnalysisTitle")}
            </CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={classStyle.badge}>
              {insight.classificationLabel ?? insight.classification}
            </Badge>
            {onRegenerate && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onRegenerate}
                disabled={regenerating}
                title={t("insights.refreshAnalysis")}
              >
                {regenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
          </div>
        </div>
        <p className="text-muted-foreground text-sm">{title}</p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Error banner */}
        {error && (
          <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg p-3 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Primary Recommendation */}
        {insight.primaryRecommendation && (
          <div className="border-dracula-purple bg-dracula-purple/5 rounded-md border-l-2 px-4 py-3">
            <p className="text-dracula-purple mb-1 text-xs font-medium tracking-widest uppercase">
              {t("insights.keyTakeaway")}
            </p>
            <p className="text-sm">{insight.primaryRecommendation}</p>
          </div>
        )}

        {/* Summary — prose first, then any allowlisted charts the model
         * inlined via `metric:<TYPE>` tokens. Tokens are dropped from the
         * visible text so the literal substring never reaches the DOM. */}
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm leading-relaxed">
            {stripChartTokens(insight.summary)}
          </p>
          <InlineCharts tokens={parseChartTokens(insight.summary)} />
        </div>

        {/* Findings — top finding gets a hero treatment, rest are a compact list */}
        {insight.findings.length > 0 && (
          <div className="space-y-3">
            <SectionSeparator label={t("insights.findingsTitle")} />
            {/* v1.4 — pull the first finding into a severity-tinted hero
             * card. The model is instructed to put the most clinically
             * relevant finding first; we let the UI honour that by giving
             * it more weight than the secondary findings.
             */}
            <HeroFinding finding={insight.findings[0]} />
            {insight.findings.length > 1 && (
              <div className="space-y-2 pt-1">
                {insight.findings.slice(1).map((finding, i) => {
                  const labelTokens = parseChartTokens(finding.label);
                  const guidelineTokens = finding.guideline
                    ? parseChartTokens(finding.guideline)
                    : [];
                  const tokens = [...labelTokens, ...guidelineTokens];
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <AssessmentIcon assessment={finding.assessment} />
                          <span className="text-sm">
                            {stripChartTokens(finding.label)}
                          </span>
                        </div>
                        <span className="text-sm font-medium tabular-nums">
                          {finding.value}
                        </span>
                      </div>
                      {finding.guideline && (
                        <p className="text-muted-foreground mt-0.5 ml-6 text-xs">
                          {stripChartTokens(finding.guideline)}
                        </p>
                      )}
                      {tokens.length > 0 && (
                        <div className="mt-2 ml-6">
                          <InlineCharts tokens={tokens} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Correlations */}
        {insight.correlations.length > 0 && (
          <div className="space-y-3">
            <SectionSeparator label={t("insights.correlationsTitle")} />
            <div className="flex flex-wrap gap-2">
              {insight.correlations.map((corr, i) => (
                <div
                  key={i}
                  className="bg-muted/50 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs"
                >
                  <span>{corr.factor}</span>
                  <span className="text-muted-foreground">↔</span>
                  <span>{corr.effect}</span>
                  <span
                    className={`ml-1 font-medium ${CONFIDENCE_STYLES[corr.confidence] ?? ""}`}
                  >
                    {corr.confidence}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recommendations */}
        {insight.recommendations.length > 0 && (
          <div className="space-y-3">
            <SectionSeparator label={t("insights.recommendationsTitle")} />
            <ol className="space-y-1.5 pl-0">
              {insight.recommendations.map((rec, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="text-muted-foreground shrink-0 font-medium">
                    {i + 1}.
                  </span>
                  <span>{rec}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Data Quality (collapsible) */}
        {insight.dataQuality && (
          <div>
            <button
              onClick={() => setDataQualityOpen((v) => !v)}
              aria-expanded={dataQualityOpen}
              className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-xs transition-colors"
            >
              {dataQualityOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <span>{t("insights.dataFoundation")}</span>
              <span className="mx-1">·</span>
              <span>
                {t("insights.confidence")}:{" "}
                <span
                  className={`font-medium ${CONFIDENCE_STYLES[insight.dataQuality.confidence] ?? ""}`}
                >
                  {t(
                    CONFIDENCE_LABEL_KEYS[insight.dataQuality.confidence] ??
                      "insights.confidenceMittel",
                  )}
                </span>
              </span>
            </button>

            {dataQualityOpen && (
              <div className="bg-muted/30 text-muted-foreground animate-insight-in mt-2 space-y-2 rounded-md px-3 py-2.5 text-xs">
                <p>{insight.dataQuality.coverage}</p>
                {insight.dataQuality.gaps.length > 0 && (
                  <div>
                    <p className="font-medium">{t("insights.dataGaps")}</p>
                    <ul className="mt-1 list-inside list-disc space-y-0.5">
                      {insight.dataQuality.gaps.map((gap, i) => (
                        <li key={i}>{gap}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {cachedAt && (
          <p className="text-muted-foreground text-xs">
            {t("insights.lastUpdated")}: {fmt.dateTime(cachedAt)}
          </p>
        )}

        {/* Disclaimer */}
        <div className="flex items-start gap-1.5 pt-1">
          <Info className="text-muted-foreground mt-0.5 h-3 w-3 shrink-0" />
          <p className="text-muted-foreground text-xs">{insight.disclaimer}</p>
        </div>
      </CardContent>
    </Card>
  );
}
