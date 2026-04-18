"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

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
          <Loader2 className="h-5 w-5 animate-spin text-dracula-purple" />
          <span className="ml-2 text-sm text-muted-foreground">
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
          <p className="text-sm text-muted-foreground">
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
          <p className="text-sm text-muted-foreground">
            {t("insights.noAnalysisYet")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="animate-insight-in border-l-2 border-l-dracula-purple">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {cached && (
            <span className="text-xs text-muted-foreground">
              {t("insights.cached")}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
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
    <p className="text-xs text-muted-foreground">
      {t("insights.lastUpdated")}: {fmt.dateTime(updatedAt)}
    </p>
  );
}
