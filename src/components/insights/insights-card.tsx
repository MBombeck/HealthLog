"use client";

import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import type { InsightResult } from "@/lib/ai/types";
import { sortRecommendationsBySeverity } from "./recommendations-grid";
import { ConfidenceMeter } from "./confidence-meter";

/**
 * v1.4.16 phase B1b — dashboard <InsightsCardPreview>.
 *
 * Compact preview of the top 1-2 severity-ordered recommendations
 * + a "View all" CTA pointing at `/insights`. Visual language matches
 * the page hero (Dracula gradient sparkle, severity-coloured left
 * border, mini confidence meter inline) so the dashboard reads as
 * a smaller window onto the same surface.
 *
 * Design notes:
 *  - The preview is dashboard-anchored, so it doesn't carry the full
 *    rationale-expand mechanic. Recs render as one-row tiles.
 *  - When the preview has zero recs OR no insight at all, the
 *    component returns `null` so the dashboard's parent card grid
 *    doesn't render an empty box. The full empty-state lives on
 *    `/insights` proper.
 *  - The legacy `InsightsCard` (which fetched its own data + rendered
 *    the v1.4.0 changed/stable/drivers/nextSteps shape) was an
 *    orphan component with zero non-test imports — it's been replaced
 *    by this leaner preview.
 */

interface InsightsCardPreviewProps {
  insight: InsightResult | null;
  /** Maximum number of recs to surface; defaults to 2. */
  topN?: number;
}

const SEVERITY_BORDER_CLASSES: Record<string, string> = {
  urgent: "border-l-dracula-red/70",
  important: "border-l-dracula-orange/70",
  suggestion: "border-l-dracula-purple/70",
  info: "border-l-dracula-cyan/70",
};

const SEVERITY_BORDER_FALLBACK = "border-l-border";

export function InsightsCardPreview({
  insight,
  topN = 2,
}: InsightsCardPreviewProps) {
  const { t } = useTranslations();
  if (!insight || insight.recommendations.length === 0) return null;

  const ordered = sortRecommendationsBySeverity(insight.recommendations).slice(
    0,
    topN,
  );

  return (
    <Card data-slot="insights-card-preview" className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles
              className="text-dracula-purple h-5 w-5"
              aria-hidden="true"
            />
            <CardTitle className="text-base">
              {t("insights.aiInsights")}
            </CardTitle>
          </div>
          <Button
            asChild
            variant="ghost"
            size="sm"
            data-slot="insights-card-view-all"
            className="gap-1.5"
          >
            <Link href="/insights">
              {t("insights.viewAll")}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {ordered.map((rec, index) => {
            const text = typeof rec === "string" ? rec : rec.text;
            const severity = typeof rec === "string" ? null : rec.severity;
            const confidence =
              typeof rec === "string" ? undefined : rec.confidence;
            const id = typeof rec === "string" ? `${index}-${rec}` : rec.id;
            const borderClass =
              (severity && SEVERITY_BORDER_CLASSES[severity]) ||
              SEVERITY_BORDER_FALLBACK;
            return (
              <li
                key={id ?? index}
                className={`bg-card/40 flex items-start justify-between gap-2 rounded-md border-l-2 px-3 py-2 ${borderClass}`}
              >
                <p className="text-sm leading-snug">{stripChartTokens(text)}</p>
                {typeof confidence === "number" && (
                  <span className="shrink-0">
                    <ConfidenceMeter value={confidence} variant="ring" />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
