"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDateTime } from "@/lib/format";

/**
 * v1.37.31 — the delivery-health readout the `provider_health` ledger never
 * had. The ledger records every AI call outcome per user and provider tag;
 * before this card, a failing central provider was invisible until someone
 * read the database. The card shows one row per provider type: how many
 * users' chains touch it, how many of them are currently failing, the worst
 * uninterrupted failure run, and the last success / failure instants.
 *
 * The failure line also carries the HTTP status the ledger recorded for that
 * failure, because "failing" on its own does not say whose problem it is. A
 * 401 is a dead credential and waiting will not fix it; a 429 or a 503 is the
 * provider's day and waiting is exactly right. Absent for a network-class
 * failure, which never had a status to record.
 */

/**
 * v1.38.19 — the day's spend, split by who pays for it. The operator
 * opens this card when a surface refuses on budget, and one mixed number could
 * not answer the question that raises: a day at 1.24 M tokens is alarming until
 * you see that 151 200 of them were the instance's own key and the rest ran on
 * the users' own plans. The operator ceiling is enforced against the second
 * figure, so both belong on screen.
 */
interface SpendToday {
  dateKey: string;
  totalTokens: number;
  operatorTokens: number;
}

interface ProviderHealthRow {
  providerType: string;
  tracked: number;
  failing: number;
  maxConsecutiveFailures: number;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
}

export function ProviderHealthSection() {
  const { t, locale } = useTranslations();
  // Seven-digit token counts are the point of this readout; ungrouped digits
  // are what made the mixed figure unreadable in the first place.
  const groupDigits = (value: number): string =>
    new Intl.NumberFormat(locale).format(value);

  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.adminProviderHealth(),
    queryFn: () =>
      apiGet<{ providers: ProviderHealthRow[]; spendToday: SpendToday }>(
        "/api/admin/provider-health",
      ),
  });

  const typeLabel = (type: string): string => {
    switch (type) {
      case "admin-openai":
        return t("admin.providerHealth.typeAdminOpenai");
      case "admin-codex":
        return t("admin.providerHealth.typeAdminCodex");
      case "openai":
        return t("admin.providerHealth.typeOpenai");
      case "anthropic":
        return t("admin.providerHealth.typeAnthropic");
      case "codex":
        return t("admin.providerHealth.typeCodex");
      case "local":
        return t("admin.providerHealth.typeLocal");
      case "openai-compatible":
        return t("admin.providerHealth.typeGateway");
      default:
        return type;
    }
  };

  const providers = data?.providers ?? [];
  const spendToday = data?.spendToday ?? null;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Activity}
        title={t("admin.providerHealth.title")}
        description={t("admin.providerHealth.description")}
      />
      {spendToday ? (
        <p className="text-muted-foreground text-sm" data-slot="ai-spend-today">
          {t("admin.providerHealth.spendToday", {
            date: spendToday.dateKey,
            total: groupDigits(spendToday.totalTokens),
            operator: groupDigits(spendToday.operatorTokens),
          })}
        </p>
      ) : null}
      {isPending ? (
        <p className="text-muted-foreground text-sm">
          {t("admin.providerHealth.loading")}
        </p>
      ) : isError ? (
        <p className="text-muted-foreground text-sm">
          {t("admin.providerHealth.loadError")}
        </p>
      ) : providers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("admin.providerHealth.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="provider-health-list">
          {providers.map((p) => (
            <li
              key={p.providerType}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              data-provider-type={p.providerType}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium">
                  {typeLabel(p.providerType)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t("admin.providerHealth.trackedUsers", {
                    count: p.tracked,
                  })}
                  {p.lastOkAt
                    ? ` · ${t("admin.providerHealth.lastOk", {
                        at: formatDateTime(p.lastOkAt),
                      })}`
                    : ""}
                  {p.failing > 0 && p.lastFailureAt
                    ? ` · ${t("admin.providerHealth.lastFailure", {
                        at: formatDateTime(p.lastFailureAt),
                      })}`
                    : ""}
                  {p.failing > 0 &&
                  p.lastFailureAt &&
                  p.lastFailureStatus !== null
                    ? ` · ${t("admin.providerHealth.lastFailureStatus", {
                        status: p.lastFailureStatus,
                      })}`
                    : ""}
                </span>
              </div>
              {p.failing === 0 ? (
                <Badge variant="secondary">
                  {t("admin.providerHealth.statusHealthy")}
                </Badge>
              ) : (
                <Badge variant="destructive">
                  {t("admin.providerHealth.statusFailing", {
                    failing: p.failing,
                    tracked: p.tracked,
                    run: p.maxConsecutiveFailures,
                  })}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
