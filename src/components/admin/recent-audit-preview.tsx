"use client";

/**
 * `<RecentAuditPreview>` — compact list of the 10 most recent audit
 * entries for the `/admin` overview landing page. The full filterable
 * viewer lives at `/admin/login-overview`.
 *
 * Reuses `/api/admin/audit-log` so the data source matches the
 * detail-page section (`<LoginOverviewSection>`).
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  ScrollText,
  XCircle,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  type AdminAuditEntry,
  AuditActedBy,
  useAuthActionLabels,
} from "./_shared";
import { apiGet } from "@/lib/api/api-fetch";
import { InlineAction } from "@/components/ui/inline-action";

const PREVIEW_LIMIT = 10;

interface AuditLogResponse {
  entries: AdminAuditEntry[];
  meta: { total: number; limit: number; offset: number };
}

export function RecentAuditPreview() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.adminAuditOverview(),
    queryFn: async () => {
      return apiGet<AuditLogResponse>(
        `/api/admin/audit-log?limit=${PREVIEW_LIMIT}&filter=auth`,
      );
    },
    // Avoid hitting the DB on every page focus; the overview is the
    // type of page admins keep open and re-render frequently.
    staleTime: 30_000,
  });

  const AUTH_ACTION_LABELS = useAuthActionLabels();

  const entries = data?.entries ?? [];

  return (
    <SettingsCard as="section" aria-labelledby="admin-overview-audit-heading">
      <SettingsCardHeader
        icon={ScrollText}
        titleId="admin-overview-audit-heading"
        title={t("admin.overview.auditTitle")}
        status={
          <InlineAction asChild size="sm">
            <Link href="/admin/login-overview">
              {t("admin.overview.auditViewAll")}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </InlineAction>
        }
      />

      <div>
        {isLoading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2
              className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span className="text-muted-foreground text-sm">
              {t("admin.overview.auditLoading")}
            </span>
          </div>
        ) : isError ? (
          <QueryErrorRow
            inset
            error={error}
            message={t("admin.overview.auditLoadError")}
            onRetry={() => void refetch()}
          />
        ) : entries.length === 0 ? (
          // v1.4.15: compact + plain so it nests inside the
          // overview card without doubling the dashed border. Reuses
          // the existing audit-empty string.
          <EmptyState
            size="compact"
            variant="plain"
            icon={<ScrollText className="size-5" />}
            title={t("admin.overview.auditEmpty")}
          />
        ) : (
          // `admin-audit-rows` names the read entries. The branches above
          // are a spinner, a load error and an empty state, so the marker
          // stands for a card that has actually answered.
          <ul data-slot="admin-audit-rows" className="divide-border divide-y">
            {entries.map((entry) => {
              const isFailed = entry.action === "auth.login.failed";
              // F-31 (v1.4.19): each row links into the full
              // /admin/login-overview viewer so admins can investigate
              // failed logins without re-finding the row by hand.
              return (
                <li key={entry.id}>
                  <Link
                    href="/admin/login-overview"
                    className="hover:bg-muted/40 -mx-2 flex items-center gap-3 rounded px-2 py-2 text-sm transition-colors"
                  >
                    <span className="shrink-0" aria-hidden="true">
                      {isFailed ? (
                        <XCircle className="text-destructive h-4 w-4" />
                      ) : (
                        <CheckCircle2 className="text-success h-4 w-4" />
                      )}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate font-medium ${isFailed ? "text-destructive" : ""}`}
                    >
                      {entry.user?.username ?? t("common.unknown")}
                      <AuditActedBy
                        actor={entry.actor}
                        className="ml-1.5 text-xs font-normal"
                      />
                    </span>
                    <span
                      className={`hidden truncate sm:inline ${isFailed ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {AUTH_ACTION_LABELS[entry.action] ?? entry.action}
                    </span>
                    {entry.ipAddress && (
                      <span className="text-muted-foreground hidden shrink-0 font-mono text-xs sm:inline">
                        {entry.ipAddress}
                      </span>
                    )}
                    <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
                      {fmt.dateTime(entry.createdAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SettingsCard>
  );
}
