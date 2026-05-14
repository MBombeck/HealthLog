"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import type {
  InsightRecommendation,
  InsightRecommendationRationale,
} from "@/lib/ai/types";
import { HealthChart } from "@/components/charts/health-chart";
import { MoodChart } from "@/components/charts/mood-chart";
import { getMedicalReferenceById } from "@/lib/ai/medical-references";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import type { Locale } from "@/lib/i18n/config";
import {
  RecommendationFeedback,
  type RecommendationFeedbackSeverity,
  type RecommendationFeedbackTimeRange,
} from "./recommendation-feedback";
import { ConfidenceMeter } from "./confidence-meter";

/**
 * Collapsible recommendation card with severity badge, confidence
 * meter, and an expandable rationale block (window / compared-to /
 * deviation) + mini-chart. Plain-string and rationale-less recs
 * render as a non-expandable row.
 */

const SEVERITY_BADGE_STYLES: Record<string, string> = {
  info: "bg-dracula-cyan/10 text-dracula-cyan border border-dracula-cyan/25",
  suggestion:
    "bg-dracula-purple/10 text-dracula-purple border border-dracula-purple/25",
  important:
    "bg-dracula-orange/10 text-dracula-orange border border-dracula-orange/25",
  urgent: "bg-dracula-red/10 text-dracula-red border border-dracula-red/25",
};

interface RecommendationCardProps {
  rec: InsightRecommendation;
  index: number;
  /** Force the rationale block visible — mostly for tests + storybook. */
  initiallyExpanded?: boolean;
}

interface NormalisedRec {
  text: string;
  severity?: "info" | "suggestion" | "important" | "urgent";
  rationale?: InsightRecommendationRationale;
  metricSource?: { type: string; timeRange: string; summary: string };
  referenceId?: string;
  id?: string;
  /**
   * v1.4.16 phase B5d — server-computed confidence (0-100). Optional
   * because legacy cached payloads predate the field; the rec card's
   * confidence slot stays empty in that case rather than tagging
   * legacy recs as "draft".
   */
  confidence?: number;
}

function normalise(rec: InsightRecommendation): NormalisedRec {
  if (typeof rec === "string") return { text: rec };
  return {
    text: rec.text,
    severity: rec.severity,
    rationale: rec.rationale,
    metricSource: rec.metricSource,
    referenceId: rec.referenceId,
    id: rec.id,
    confidence: rec.confidence,
  };
}

/**
 * v1.4.16 phase B5d — caption threshold. Below 50, the expanded
 * rationale card surfaces a "Low confidence — based on limited data"
 * sentence so the rec stays visible but framed as preliminary.
 * Above 50 the meter alone speaks; below 25 the meter is replaced by
 * a draft pill (handled inside `<ConfidenceMeter>`) and the caption
 * still applies (draft <= low).
 */
const LOW_CONFIDENCE_CAPTION_THRESHOLD = 50;

/**
 * Map a `metricSource.type` value to the chart-types[] the dashboard
 * uses. The model speaks snapshot-key vocabulary ("bloodPressure",
 * "weight", "pulse", "mood", "medications.compliance30") which
 * doesn't 1:1 match the measurement-type enum the chart consumes
 * ("BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "WEIGHT", …). This
 * map is deliberately tight; unknown types fall through to a single-
 * type chart so a future provider that emits a new key still renders
 * something rather than nothing.
 */
function metricTypeToChartTypes(metricType: string | undefined): string[] {
  if (!metricType) return [];
  const lower = metricType.toLowerCase();
  if (lower === "bloodpressure" || lower === "blood_pressure") {
    return ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"];
  }
  if (lower === "weight") return ["WEIGHT"];
  if (lower === "pulse") return ["PULSE"];
  if (lower === "bodyfat" || lower === "body_fat") return ["BODY_FAT"];
  if (lower === "sleep" || lower === "sleep_duration") {
    return ["SLEEP_DURATION"];
  }
  if (lower === "activity" || lower === "steps") {
    return ["ACTIVITY_STEPS"];
  }
  if (lower === "bloodglucose" || lower === "blood_glucose") {
    return ["BLOOD_GLUCOSE"];
  }
  // Unknown / synthetic key — pass it through verbatim so the chart
  // can render empty rather than nothing.
  return [metricType];
}

function isMoodMetric(metricType: string | undefined): boolean {
  return metricType?.toLowerCase() === "mood";
}

function isComplianceMetric(metricType: string | undefined): boolean {
  return (
    metricType?.toLowerCase().startsWith("medications.compliance") === true ||
    metricType?.toLowerCase() === "medication"
  );
}

function CitationFootnote({
  referenceId,
  locale,
}: {
  referenceId: string;
  locale: Locale;
}) {
  const { t } = useTranslations();
  const ref = getMedicalReferenceById(referenceId);
  if (!ref) return null;
  const label = locale === "de" ? ref.titleDe : ref.title;
  return (
    <a
      href={ref.url}
      target="_blank"
      rel="noreferrer"
      title={t("insights.recommendation.viewSource")}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
      data-slot="insight-recommendation-source"
      data-reference-id={referenceId}
    >
      <span className="font-medium">
        {t("insights.recommendation.source")}:
      </span>
      <span>
        {ref.org} {ref.publishedYear} — {label}
      </span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function RationaleRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="grid grid-cols-[7rem_1fr] items-start gap-2 text-xs"
      data-slot="rec-rationale-row"
    >
      <span className="text-muted-foreground font-medium">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function RationaleCard({
  rationale,
  metricSource,
  referenceId,
  confidence,
  locale,
  feedbackProps,
}: {
  rationale: InsightRecommendationRationale;
  metricSource:
    | { type: string; timeRange: string; summary: string }
    | undefined;
  referenceId: string | undefined;
  confidence: number | undefined;
  locale: Locale;
  feedbackProps: {
    recId: string;
    recText: string;
    recSeverity: RecommendationFeedbackSeverity;
    metricSourceType: string;
    metricSourceTimeRange: RecommendationFeedbackTimeRange;
  } | null;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const metricType = metricSource?.type;
  const chartTypes = metricTypeToChartTypes(metricType);
  const showLowConfidenceCaption =
    typeof confidence === "number" &&
    confidence < LOW_CONFIDENCE_CAPTION_THRESHOLD;

  return (
    <div
      data-slot="rec-rationale-card"
      className="bg-muted/30 mt-3 space-y-3 rounded-md px-3 py-2.5"
    >
      <div className="space-y-1.5">
        <RationaleRow
          label={t("insights.recommendation.rationaleWindow")}
          value={stripChartTokens(rationale.dataWindow)}
        />
        <RationaleRow
          label={t("insights.recommendation.rationaleComparedTo")}
          value={stripChartTokens(rationale.comparedTo)}
        />
        <RationaleRow
          label={t("insights.recommendation.rationaleDeviation")}
          value={stripChartTokens(rationale.deviation)}
        />
      </div>

      {/* Mini-chart pinned to the rec's window. mood + medication-
          compliance get dedicated wrappers; everything else routes
          through HealthChart with the metric-key vocabulary. */}
      {isMoodMetric(metricType) ? (
        <MoodChart
          mini
          windowOverride={rationale.dataWindow}
          userTimezone={user?.timezone}
        />
      ) : isComplianceMetric(metricType) ? null : chartTypes.length > 0 ? (
        <HealthChart
          types={chartTypes}
          title={metricType ?? ""}
          mini
          windowOverride={rationale.dataWindow}
          userTimezone={user?.timezone}
        />
      ) : null}

      {showLowConfidenceCaption && (
        <p
          data-slot="rec-low-confidence-caption"
          className="text-muted-foreground text-xs italic"
        >
          {t("insights.recommendation.confidenceLow")}
        </p>
      )}

      {referenceId && (
        <div>
          <CitationFootnote referenceId={referenceId} locale={locale} />
        </div>
      )}

      {/* v1.4.16 phase B5e — fills the rec-feedback-slot reserved by
       * B5c. The feedback row only appears when the rec carries the
       * full attribute set the API endpoint requires; legacy recs
       * without an id stay un-rateable (the empty slot keeps the DOM
       * stable for downstream tests). */}
      <div data-slot="rec-feedback-slot">
        {feedbackProps && <RecommendationFeedback {...feedbackProps} />}
      </div>
    </div>
  );
}

/**
 * Validate the rec's metricSource.timeRange against the four-window
 * vocabulary the feedback endpoint accepts. Returns null when the
 * value is missing or out-of-vocabulary so the feedback slot stays
 * empty rather than rendering a feedback row that would 422 on
 * submit.
 */
function asFeedbackTimeRange(
  value: string | undefined,
): RecommendationFeedbackTimeRange | null {
  switch (value) {
    case "last7days":
    case "last30days":
    case "last90days":
    case "allTime":
      return value;
    default:
      return null;
  }
}

export function RecommendationCard({
  rec,
  index,
  initiallyExpanded = false,
}: RecommendationCardProps) {
  const { t, locale } = useTranslations();
  const norm = normalise(rec);
  const expandable = norm.rationale !== undefined;
  const [expanded, setExpanded] = useState(initiallyExpanded);

  // Feedback row is only renderable when the rec carries every
  // attribute the API endpoint validates. Legacy / partial recs
  // (no id, no severity, or an unknown timeRange) leave the slot
  // empty so a thumbs-click can never produce a 422.
  const feedbackTimeRange = asFeedbackTimeRange(norm.metricSource?.timeRange);
  const feedbackProps =
    norm.id && norm.severity && norm.metricSource?.type && feedbackTimeRange
      ? {
          recId: norm.id,
          recText: norm.text,
          recSeverity: norm.severity,
          metricSourceType: norm.metricSource.type,
          metricSourceTimeRange: feedbackTimeRange,
        }
      : null;

  return (
    <div
      data-slot="rec-card"
      data-index={index}
      className="border-border/40 bg-card/20 rounded-lg border px-3 py-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span
            className="text-muted-foreground mt-0.5 shrink-0 text-xs font-medium tabular-nums"
            aria-hidden="true"
          >
            {index + 1}.
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {norm.severity && (
                <Badge
                  className={`text-[10px] tracking-wide uppercase ${
                    SEVERITY_BADGE_STYLES[norm.severity] ?? ""
                  }`}
                  variant="outline"
                >
                  {norm.severity}
                </Badge>
              )}
              <p className="text-sm leading-snug">
                {stripChartTokens(norm.text)}
              </p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span data-slot="rec-confidence-slot">
            {typeof norm.confidence === "number" && (
              <ConfidenceMeter value={norm.confidence} />
            )}
          </span>
          {expandable && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              title={
                expanded
                  ? t("insights.recommendation.rationaleCollapse")
                  : t("insights.recommendation.rationaleExpand")
              }
              data-slot="rec-expand-toggle"
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {expandable && expanded && norm.rationale && (
        <div
          className="animate-insight-in"
          style={{ animationDuration: "200ms" }}
        >
          <RationaleCard
            rationale={norm.rationale}
            metricSource={norm.metricSource}
            referenceId={norm.referenceId}
            confidence={norm.confidence}
            locale={locale}
            feedbackProps={feedbackProps}
          />
        </div>
      )}

      {/* Inline-only citation footnote: a legacy rec (no rationale)
       * still surfaces its medical reference under the rec text.
       * Recs WITH rationale only render the footnote inside the
       * expanded RationaleCard so it doesn't double-print. */}
      {!expandable && norm.referenceId && (
        <div className="mt-1 ml-6">
          <CitationFootnote referenceId={norm.referenceId} locale={locale} />
        </div>
      )}
    </div>
  );
}
