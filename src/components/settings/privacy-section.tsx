"use client";

/**
 * v1.23 — "Data & Privacy" dashboard (P7).
 *
 * One coherent pane that ASSEMBLES already-shipped machinery — it does not
 * rebuild any of it. Each block either embeds an existing card (active
 * sessions, security activity, trusted devices) or links to the existing
 * surface that owns the action (export incl. the passphrase option, account
 * deletion / data reset, AI privacy mode, research mode). The retention +
 * encryption facts are read from the server so the copy stays truthful, and
 * the backup↔deletion lag is disclosed honestly.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Database,
  Download,
  ShieldCheck,
  Trash2,
  Clock,
  Sparkles,
  Info,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { SecuritySessionsCard } from "@/components/settings/security-sessions-card";
import { SecurityActivityCard } from "@/components/settings/security-activity-card";
import { TrustedDevicesCard } from "@/components/settings/trusted-devices-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { MODULE_KEYS, MODULE_REGISTRY } from "@/lib/modules/registry";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

interface PrivacySummary {
  retention: {
    coachMessagesDays: number;
    auditLogDays: number;
    deliveryLogDays: number;
  };
  encryption: {
    algorithm: string;
    columnCount: number;
    modelCount: number;
  };
}

/**
 * The modules that keep records of their own, read off the module registry
 * so a new module joins the "What's stored" list without anyone editing it.
 * The hand-kept list this replaced had stopped at six lines while documents,
 * vaccinations, the cycle and workouts were all being stored. Two categories
 * hold nothing of their own: an export assembles what other modules store,
 * and the connector's tokens are covered by the integration line.
 */
export function storedModuleLabelKeys(): string[] {
  return MODULE_KEYS.map((key) => MODULE_REGISTRY[key])
    .filter((m) => m.category !== "export" && m.category !== "integration")
    .map((m) => m.labelKey);
}

export function PrivacySection() {
  const { t, locale } = useTranslations();
  const { isAuthenticated } = useAuth();

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useQuery({
    queryKey: queryKeys.privacySummary(),
    queryFn: () => apiGet<PrivacySummary>("/api/settings/privacy-summary"),
    enabled: isAuthenticated,
  });

  return (
    <div className="space-y-6">
      {/* Encryption at rest */}
      <SettingsCard>
        <SettingsCardHeader
          anchor="encryption"
          icon={ShieldCheck}
          title={t("settings.privacy.encryption.title")}
        />
        <div className="space-y-3">
          <p className="text-sm">
            {summary
              ? t("settings.privacy.encryption.summary", {
                  algorithm: summary.encryption.algorithm,
                  columns: summary.encryption.columnCount,
                  models: summary.encryption.modelCount,
                })
              : t("settings.privacy.encryption.statement")}
          </p>
        </div>
      </SettingsCard>

      {/* What's stored */}
      <SettingsCard>
        <SettingsCardHeader
          anchor="stored-data"
          icon={Database}
          title={t("settings.privacy.stored.title")}
        />
        <ul
          className="list-disc space-y-1 pl-5 text-sm"
          data-testid="privacy-stored-list"
        >
          <li>{t("settings.privacy.stored.measurements")}</li>
          <li>{t("settings.privacy.stored.profile")}</li>
          <li data-slot="privacy-stored-modules">
            {t("settings.privacy.stored.modules", {
              list: new Intl.ListFormat(locale, {
                style: "long",
                type: "conjunction",
              }).format(storedModuleLabelKeys().map((key) => t(key))),
            })}
          </li>
          <li>{t("settings.privacy.stored.integrations")}</li>
          <li>{t("settings.privacy.stored.security")}</li>
        </ul>
      </SettingsCard>

      {/* Retention */}
      <SettingsCard>
        <SettingsCardHeader
          anchor="retention"
          icon={Clock}
          title={t("settings.privacy.retention.title")}
          description={t("settings.privacy.retention.description")}
        />
        {summaryLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : summaryError || !summary ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.privacy.retention.unavailable")}
          </p>
        ) : (
          <ul className="text-muted-foreground space-y-1 text-sm">
            <li>
              {t("settings.privacy.retention.coach", {
                days: summary.retention.coachMessagesDays,
              })}
            </li>
            <li>
              {t("settings.privacy.retention.audit", {
                days: summary.retention.auditLogDays,
              })}
            </li>
            <li>
              {t("settings.privacy.retention.delivery", {
                days: summary.retention.deliveryLogDays,
              })}
            </li>
          </ul>
        )}
      </SettingsCard>

      {/* Export */}
      <SettingsCard>
        <SettingsCardHeader
          anchor="your-data-export"
          icon={Download}
          title={t("settings.privacy.export.title")}
          description={t("settings.privacy.export.description")}
        />
        <SettingsCardActions align="start">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/export">
              {t("settings.privacy.export.openExport")}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/gesundheitsakte">
              {t("settings.privacy.export.openHealthRecord")}
            </Link>
          </Button>
        </SettingsCardActions>
      </SettingsCard>

      {/* Delete / reset — with the honest backup lag disclosure */}
      <SettingsCard>
        <SettingsCardHeader
          anchor="delete-data"
          icon={Trash2}
          title={t("settings.privacy.delete.title")}
          description={t("settings.privacy.delete.description")}
        />
        <SettingsInfoTile icon={Info} tone="warning">
          {t("settings.privacy.delete.backupLag")}
        </SettingsInfoTile>
        <SettingsCardActions align="start">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/advanced">
              {t("settings.privacy.delete.openAdvanced")}
            </Link>
          </Button>
        </SettingsCardActions>
      </SettingsCard>

      {/* Privacy posture. The AI privacy mode is what is left to decide here:
          research mode is gone, so the second button pointed at a page that
          no longer carries the control it named. */}
      <SettingsCard>
        <SettingsCardHeader
          anchor="privacy-posture"
          icon={Sparkles}
          title={t("settings.privacy.posture.title")}
          description={t("settings.privacy.posture.description")}
        />
        <SettingsCardActions align="start">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/ai">
              {t("settings.privacy.posture.openAi")}
            </Link>
          </Button>
        </SettingsCardActions>
      </SettingsCard>

      {/* Active sessions + trusted devices + security activity (embedded) */}
      <SecuritySessionsCard isAuthenticated={isAuthenticated} />
      <TrustedDevicesCard isAuthenticated={isAuthenticated} />
      <SecurityActivityCard isAuthenticated={isAuthenticated} />
    </div>
  );
}
