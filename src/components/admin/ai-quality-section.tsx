"use client";

/**
 * `<AiQualitySection>` — admin AI quality preview (v1.4.16 phase B5e).
 *
 * Surfaces the aggregator-written helpful-rate per (severity x
 * provider x prompt-version) bucket. The pg-boss `feedback-aggregator`
 * queue writes the underlying summary daily at 04:00 Europe/Berlin
 * to `AppSettings.adminAiInsightsFeedbackSummary`; this component
 * reads it via `GET /api/admin/ai-quality` (admin-gated).
 *
 * Empty-state ("no summary yet") rendered as a quiet message rather
 * than a fake zero row so the operator can tell "no feedback" apart
 * from "all-zeros".
 *
 * Layout: a compact table with one row per bucket. Mobile (<sm) keeps
 * the table — the columns are short enough that horizontal-scroll
 * isn't punishing, and the simpler card-list fallback obscures the
 * provider comparison that's the whole point of the view.
 */

import { useQuery } from "@tanstack/react-query";
import { Sparkles, Loader2 } from "lucide-react";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { helpfulRateColour } from "./_shared";

interface FeedbackBucket {
  severity: string;
  metricSourceType: string;
  providerType: string;
  promptVersion: string;
  helpful: number;
  notHelpful: number;
  total: number;
  helpfulRate: number;
}

interface FeedbackSummary {
  generatedAt: string;
  windowDays: number;
  buckets: FeedbackBucket[];
}

interface AiQualityResponse {
  data: { summary: FeedbackSummary | null } | null;
  error?: string | null;
}

const SEVERITY_TINT: Record<string, string> = {
  info: "text-dracula-cyan",
  suggestion: "text-dracula-purple",
  important: "text-dracula-orange",
  urgent: "text-dracula-red",
};

export function AiQualitySection() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const query = useQuery({
    queryKey: queryKeys.adminAiQuality(),
    queryFn: async () => {
      const res = await fetch("/api/admin/ai-quality");
      const json = (await res.json()) as AiQualityResponse;
      if (!res.ok) throw new Error(json.error ?? "ai_quality_failed");
      return json.data?.summary ?? null;
    },
  });

  if (query.isLoading) {
    return (
      <div className="bg-card border-border flex items-center gap-2 rounded-xl border p-6">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        <span className="text-muted-foreground text-sm">
          {t("admin.aiQuality.loading")}
        </span>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div
        role="alert"
        className="text-destructive bg-destructive/10 border-destructive/30 rounded-xl border p-4 text-sm"
      >
        {t("admin.aiQuality.loadError")}
      </div>
    );
  }

  const summary = query.data;

  if (!summary || summary.buckets.length === 0) {
    return (
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="text-dracula-purple h-5 w-5" />
          <div className="text-lg font-semibold">
            {t("admin.aiQuality.title")}
          </div>
        </div>
        <p className="text-muted-foreground mt-3 text-sm">
          {t("admin.aiQuality.empty")}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-card border-border space-y-4 rounded-xl border p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="text-dracula-purple h-5 w-5" />
          <div className="text-lg font-semibold">
            {t("admin.aiQuality.title")}
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("admin.aiQuality.windowLabel", {
            days: String(summary.windowDays),
          })}
          {" · "}
          {t("admin.aiQuality.generatedAtLabel")}{" "}
          {fmt.dateTime(summary.generatedAt)}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-slot="ai-quality-table">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-xs tracking-wider uppercase">
              <th className="py-2 pr-3 font-medium">
                {t("admin.aiQuality.colSeverity")}
              </th>
              <th className="py-2 pr-3 font-medium">
                {t("admin.aiQuality.colMetric")}
              </th>
              <th className="py-2 pr-3 font-medium">
                {t("admin.aiQuality.colProvider")}
              </th>
              <th className="py-2 pr-3 font-medium">
                {t("admin.aiQuality.colPromptVersion")}
              </th>
              <th className="py-2 pr-3 font-medium tabular-nums">
                {t("admin.aiQuality.colHelpful")}
              </th>
              <th className="py-2 pr-3 font-medium tabular-nums">
                {t("admin.aiQuality.colNotHelpful")}
              </th>
              <th className="py-2 font-medium tabular-nums">
                {t("admin.aiQuality.colHelpfulRate")}
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.buckets.map((bucket, idx) => {
              const ratePct = Math.round(bucket.helpfulRate * 100);
              return (
                <tr
                  key={`${bucket.severity}-${bucket.metricSourceType}-${bucket.providerType}-${bucket.promptVersion}-${idx}`}
                  className="border-border/40 border-b last:border-0"
                  data-slot="ai-quality-bucket"
                >
                  <td
                    className={`py-2 pr-3 font-medium ${
                      SEVERITY_TINT[bucket.severity] ?? ""
                    }`}
                  >
                    {bucket.severity}
                  </td>
                  <td className="py-2 pr-3">{bucket.metricSourceType}</td>
                  <td className="py-2 pr-3">{bucket.providerType}</td>
                  <td className="text-muted-foreground py-2 pr-3 text-xs">
                    {bucket.promptVersion}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{bucket.helpful}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {bucket.notHelpful}
                  </td>
                  <td
                    className={`py-2 font-semibold tabular-nums ${helpfulRateColour(
                      bucket.helpfulRate,
                    )}`}
                  >
                    {ratePct}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
