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
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { type AdminAuditEntry, useAuthActionLabels } from "./_shared";

const PREVIEW_LIMIT = 10;

interface AuditLogResponse {
  entries: AdminAuditEntry[];
  meta: { total: number; limit: number; offset: number };
}

export function RecentAuditPreview() {
  const { t } = useTranslations();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "audit-log", "overview-preview"],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/audit-log?limit=${PREVIEW_LIMIT}&filter=auth`,
      );
      if (!res.ok) throw new Error("Failed to load audit log");
      return (await res.json()).data as AuditLogResponse;
    },
    // Avoid hitting the DB on every page focus; the overview is the
    // type of page admins keep open and re-render frequently.
    staleTime: 30_000,
  });

  const AUTH_ACTION_LABELS = useAuthActionLabels();

  const entries = data?.entries ?? [];

  return (
    <section
      aria-labelledby="admin-overview-audit-heading"
      className="bg-card border-border rounded-xl border p-6"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="text-primary h-5 w-5" aria-hidden="true" />
          <h2
            id="admin-overview-audit-heading"
            className="text-lg font-semibold"
          >
            {t("admin.overview.auditTitle")}
          </h2>
        </div>
        <Link
          href="/admin/login-overview"
          className="text-primary hover:text-primary/80 inline-flex items-center gap-1 text-sm"
        >
          {t("admin.overview.auditViewAll")}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-4">
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
          <div
            role="alert"
            className="text-destructive bg-destructive/10 border-destructive/30 rounded-md border px-3 py-2 text-sm"
          >
            {t("admin.overview.auditLoadError")}
          </div>
        ) : entries.length === 0 ? (
          // v1.4.15 phase-C5: compact + plain so it nests inside the
          // overview card without doubling the dashed border. Reuses
          // the existing audit-empty string.
          <EmptyState
            size="compact"
            variant="plain"
            icon={<ScrollText className="size-5" />}
            title={t("admin.overview.auditEmpty")}
          />
        ) : (
          <ul className="divide-border divide-y">
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
                        <CheckCircle2 className="text-dracula-green h-4 w-4" />
                      )}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate font-medium ${isFailed ? "text-destructive" : ""}`}
                    >
                      {entry.user?.username ?? t("common.unknown")}
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
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
