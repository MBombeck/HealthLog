"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, HeartPulse, Info, Upload } from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface HealthKitStatus {
  lastSyncedAt: string | null;
}

export function AppleHealthCard({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const format = useFormatters();
  const {
    data: status,
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKeys.healthKitStatus(),
    queryFn: () => apiGet<HealthKitStatus>("/api/integrations/healthkit"),
    enabled,
    refetchOnWindowFocus: true,
  });

  const lastSyncedAt = status?.lastSyncedAt ?? null;
  const statusState = isLoading
    ? "checking"
    : isError
      ? "unavailable"
      : lastSyncedAt
        ? "recent-data"
        : "setup";
  const statusLabel = isLoading
    ? t("settings.appleHealth.status.checking")
    : isError
      ? t("settings.appleHealth.status.unavailable")
      : lastSyncedAt
        ? t("settings.appleHealth.status.dataReceived")
        : t("settings.appleHealth.status.setup");

  return (
    <SettingsCard
      as="section"
      aria-labelledby="apple-health-card-title"
      data-testid="apple-health-card"
      className="space-y-4"
    >
      <SettingsCardHeader
        icon={HeartPulse}
        titleId="apple-health-card-title"
        title={t("settings.appleHealth.title")}
        description={t("settings.appleHealth.description")}
        status={
          <Badge
            variant={lastSyncedAt ? undefined : "outline"}
            data-testid="apple-health-status"
            data-state={statusState}
            className={
              lastSyncedAt
                ? "border-success/30 bg-success/15 text-success max-w-full whitespace-nowrap"
                : "max-w-full whitespace-nowrap"
            }
          >
            {lastSyncedAt ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Info className="h-3 w-3" aria-hidden="true" />
            )}
            <span className="truncate">{statusLabel}</span>
          </Badge>
        }
      />

      {lastSyncedAt && (
        <p
          className="text-muted-foreground text-xs"
          data-testid="apple-health-last-data"
        >
          {t("settings.appleHealth.lastDataLabel")}{" "}
          <time dateTime={lastSyncedAt}>{format.dateTime(lastSyncedAt)}</time>
        </p>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          {t("settings.appleHealth.setupTitle")}
        </h3>
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
          <li>{t("settings.appleHealth.permissionStep")}</li>
          <li>{t("settings.appleHealth.backgroundStep")}</li>
        </ol>
      </div>

      <div className="border-border bg-muted/30 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground text-xs sm:max-w-xl">
          {t("settings.appleHealth.importNote")}
        </p>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="min-h-11 shrink-0 sm:min-h-9"
        >
          <Link
            href="/settings/export#settings-section-import-title"
            data-testid="apple-health-import-link"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {t("settings.appleHealth.importAction")}
          </Link>
        </Button>
      </div>
    </SettingsCard>
  );
}
