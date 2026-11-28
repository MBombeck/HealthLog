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
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { helpfulRateColour } from "./_shared";
import { EmptyState } from "@/components/ui/empty-state";

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

const SEVERITY_TINT: Record<string, string> = {
  info: "text-info",
  suggestion: "text-primary",
  important: "text-warning",
  urgent: "text-destructive",
};

export function AiQualitySection() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const query = useQuery({
    queryKey: queryKeys.adminAiQuality(),
    queryFn: async () => {
      const data = await apiGet<{ summary: FeedbackSummary | null } | null>(
        "/api/admin/ai-quality",
      );
      return data?.summary ?? null;
    },
  });

  const summary = query.data ?? null;
  const buckets = summary?.buckets ?? [];
  const hasData = !!summary && buckets.length > 0;

  // v1.18.1 — keep the outer card + header rendered across every query
  // state (loading / error / empty / data) so the heading baseline stays at
  // a constant Y-offset and the section never snaps downward when the data
  // resolves. Mirrors <CoachFeedbackSection> (header outside the
  // fetch-state branch).
  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Sparkles}
        title={t("admin.aiQuality.title")}
        status={
          hasData && summary ? (
            <p className="text-muted-foreground text-xs">
              {t("admin.aiQuality.windowLabel", {
                days: String(summary.windowDays),
              })}
              {", "}
              {t("admin.aiQuality.generatedAtLabel")}{" "}
              {fmt.dateTime(summary.generatedAt)}
            </p>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-sm">
            {t("admin.aiQuality.loading")}
          </span>
        </div>
      ) : query.isError ? (
        <QueryErrorRow
          inset
          error={query.error}
          message={t("admin.aiQuality.loadError")}
          onRetry={() => void query.refetch()}
        />
      ) : !hasData ? (
        <EmptyState variant="plain" title={t("admin.aiQuality.empty")} />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm" data-slot="ai-quality-table">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left text-xs">
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
              {buckets.map((bucket, idx) => {
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
      )}
    </SettingsCard>
  );
}
