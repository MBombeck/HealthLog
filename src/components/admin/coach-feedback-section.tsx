"use client";

/**
 * `<CoachFeedbackSection>` — admin view onto the v1.4.23 H7 Coach
 * helpful/unhelpful aggregate. Reads the same feedback-aggregator row
 * that the AI Quality view consumes; this section just slices the
 * Coach-only buckets so the operator can see prompt-version × helpful-
 * rate × n at a glance.
 *
 * First useful question this answers in the v1.4.23 first-week window:
 * "Is the v1.4.22 Coach prose rewrite (PROMPT_VERSION 4.22.0 → 4.23.x)
 * landing well, or did the warm tone overshoot?" If the helpful-rate
 * for the new prompt version drops below 50 % within the first 100
 * ratings, v1.4.24 walks the persona back.
 *
 * Empty state when the aggregator hasn't run or no Coach feedback has
 * landed in the rolling window. Cross-user aggregation only — the
 * admin view never exposes per-user prose.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";

import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { helpfulRateColour } from "./_shared";

interface CoachFeedbackBucket {
  promptVersion: string;
  tone: string;
  verbosity: string;
  helpful: number;
  notHelpful: number;
  total: number;
  helpfulRate: number;
}

interface FeedbackSummary {
  generatedAt: string;
  windowDays: number;
  coachBuckets?: CoachFeedbackBucket[];
}

interface CoachFeedbackResponse {
  data: { summary: FeedbackSummary | null } | null;
  error?: string | null;
}

export function CoachFeedbackSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const query = useQuery({
    queryKey: queryKeys.adminCoachFeedback(),
    queryFn: async () => {
      const res = await fetch("/api/admin/ai-quality");
      const json = (await res.json()) as CoachFeedbackResponse;
      if (!res.ok) throw new Error(json.error ?? "coach_feedback_failed");
      return json.data?.summary ?? null;
    },
  });

  const summary = query.data ?? null;
  const buckets = summary?.coachBuckets ?? [];
  const hasData = !!summary && buckets.length > 0;

  // v1.4.25 W8 — keep the section's outer card + header rendered across
  // every query state (loading / error / empty / data) so the heading
  // baseline stays at a constant Y-offset. Previously the loading branch
  // returned a thin flex-row stub and the error branch a p-4 alert with
  // NO heading, which made the entire section snap downward when the
  // fetched data resolved — Marc reported the visible layout shift on
  // /admin/coach-feedback. Mirrors the canonical structure used by
  // <SystemStatusSection> (header outside the fetch-state branch).
  return (
    <div className="bg-card border-border space-y-4 rounded-xl border p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="text-dracula-purple h-5 w-5" />
          <div className="text-lg font-semibold">
            {t("admin.coachFeedback.title")}
          </div>
        </div>
        {hasData && summary && (
          <p className="text-muted-foreground text-xs">
            {t("admin.coachFeedback.windowLabel", {
              days: String(summary.windowDays),
            })}
            {" · "}
            {t("admin.coachFeedback.generatedAtLabel")}{" "}
            {fmt.dateTime(summary.generatedAt)}
          </p>
        )}
      </div>

      {query.isLoading ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-sm">
            {t("admin.coachFeedback.loading")}
          </span>
        </div>
      ) : query.isError ? (
        <div
          role="alert"
          className="text-destructive bg-destructive/10 border-destructive/30 rounded-md border p-3 text-sm"
        >
          {t("admin.coachFeedback.loadError")}
        </div>
      ) : !hasData ? (
        <p className="text-muted-foreground text-sm">
          {t("admin.coachFeedback.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-slot="coach-feedback-table">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left text-xs tracking-wider uppercase">
                <th className="py-2 pr-3 font-medium">
                  {t("admin.coachFeedback.colPromptVersion")}
                </th>
                <th className="py-2 pr-3 font-medium">
                  {t("admin.coachFeedback.colTone")}
                </th>
                <th className="py-2 pr-3 font-medium">
                  {t("admin.coachFeedback.colVerbosity")}
                </th>
                <th className="py-2 pr-3 font-medium tabular-nums">
                  {t("admin.coachFeedback.colHelpful")}
                </th>
                <th className="py-2 pr-3 font-medium tabular-nums">
                  {t("admin.coachFeedback.colNotHelpful")}
                </th>
                <th className="py-2 pr-3 font-medium tabular-nums">
                  {t("admin.coachFeedback.colN")}
                </th>
                <th className="py-2 font-medium tabular-nums">
                  {t("admin.coachFeedback.colHelpfulRate")}
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket, idx) => {
                const ratePct = Math.round(bucket.helpfulRate * 100);
                return (
                  <tr
                    key={`${bucket.promptVersion}-${bucket.tone}-${bucket.verbosity}-${idx}`}
                    className="border-border/40 border-b last:border-0"
                    data-slot="coach-feedback-bucket"
                  >
                    <td className="text-muted-foreground py-2 pr-3 text-xs">
                      {bucket.promptVersion}
                    </td>
                    <td className="py-2 pr-3">{bucket.tone}</td>
                    <td className="py-2 pr-3">{bucket.verbosity}</td>
                    <td className="py-2 pr-3 tabular-nums">{bucket.helpful}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {bucket.notHelpful}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{bucket.total}</td>
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
    </div>
  );
}
