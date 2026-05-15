"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";

// ─── Types ────────────────────────────────────────────────

interface InsightStatusCardProps {
  title: string;
  icon: React.ReactNode;
  text: string | null;
  hasProvider: boolean;
  cached: boolean;
  updatedAt: string | null;
  loading?: boolean;
}

// ─── Main Component ───────────────────────────────────────

export function InsightStatusCard({
  title,
  icon,
  text,
  hasProvider,
  cached,
  updatedAt,
  loading = false,
}: InsightStatusCardProps) {
  const { t } = useTranslations();

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="text-dracula-purple h-5 w-5 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground ml-2 text-sm">
            {t("common.loading")}
          </span>
        </CardContent>
      </Card>
    );
  }

  if (!hasProvider) {
    return (
      <Card className="opacity-60">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("insights.noProviderConfigured")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!text) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("insights.noAnalysisYet")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="animate-insight-in border-l-dracula-purple border-l-2">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {cached && (
            <span className="text-muted-foreground text-xs">
              {t("insights.cached")}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* v1.4.27 — defence-in-depth strip. Cached status text from
            pre-v1.4.27 rows can still carry literal `metric:<TYPE>`
            tokens the model embedded on the assumption a chart would
            render inline. The sub-page never mounts the chart, so the
            token surfaces verbatim. The producer side now strips too;
            this consumer-side wrap keeps existing caches clean while
            they roll forward. */}
        <p className="text-muted-foreground text-sm leading-relaxed">
          {stripChartTokens(text)}
        </p>
        <LastUpdatedFooter updatedAt={updatedAt} />
      </CardContent>
    </Card>
  );
}

function LastUpdatedFooter({ updatedAt }: { updatedAt: string | null }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!updatedAt) return null;
  return (
    <p className="text-muted-foreground text-xs">
      {t("insights.lastUpdated")}: {fmt.dateTime(updatedAt)}
    </p>
  );
}
