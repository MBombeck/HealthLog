"use client";

/**
 * v1.23 — Settings → account → "Security activity".
 *
 * A read-only feed of the user's recent account-security events (sign-ins, MFA
 * changes, password changes, session revocations, exports, deletions) from the
 * shared `GET /api/auth/me/security-activity` endpoint. Each row shows a
 * readable action label, the resolved location, the masked IP, and the time.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2, ShieldCheck } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { cn } from "@/lib/utils";

interface ActivityRow {
  action: string;
  createdAt: string;
  location: string | null;
  ipMasked: string | null;
  carrier: string | null;
}

/** Map an audit action onto a stable, translatable label key. */
function actionLabelKey(action: string): string {
  if (action === "auth.login.new_device")
    return "settings.security.action.newDevice";
  if (action === "auth.login.failed")
    return "settings.security.action.loginFailed";
  // v1.42 (#959) — claiming a managed profile is the account's first sign-in.
  if (
    action.startsWith("auth.login") ||
    action === "auth.register" ||
    action === "auth.claim"
  )
    return "settings.security.action.login";
  if (action.startsWith("auth.password"))
    return "settings.security.action.passwordChange";
  if (action.startsWith("auth.mfa")) return "settings.security.action.mfa";
  if (action.startsWith("auth.session"))
    return "settings.security.action.sessionRevoke";
  if (action.startsWith("auth.token") || action.startsWith("auth.bearer"))
    return "settings.security.action.token";
  if (action === "user.account.delete")
    return "settings.security.action.accountDelete";
  if (action === "user.data.clear") return "settings.security.action.dataClear";
  if (action.includes("export")) return "settings.security.action.export";
  return "settings.security.action.other";
}

export function SecurityActivityCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Collapsed by default — the feed opens only on demand, keeping the security
  // surface skimmable. UI-only state; nothing is persisted across reloads.
  const [open, setOpen] = useState(false);
  const regionId = useId();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.securityActivity(),
    queryFn: () =>
      apiGet<{ events: ActivityRow[] }>("/api/auth/me/security-activity"),
    enabled: isAuthenticated,
  });

  const events = data?.events ?? [];

  return (
    <SettingsCard data-slot="settings-security-activity-card">
      <SettingsCardHeader
        anchor="security-activity"
        icon={ShieldCheck}
        title={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={regionId}
            data-slot="settings-security-activity-toggle"
            className="hover:text-foreground focus-visible:ring-ring/50 -m-1 flex min-h-11 items-center gap-2 rounded-md p-1 text-left focus-visible:ring-2 focus-visible:outline-none"
          >
            {t("settings.security.activityTitle")}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        }
        description={t("settings.security.activityDescription")}
      />
      <div id={regionId} hidden={!open} className="space-y-4">
        {isLoading && (
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
        )}

        {isError && (
          <QueryErrorRow
            message={t("settings.security.activityLoadError")}
            onRetry={() => refetch()}
          />
        )}

        {!isLoading && !isError && events.length === 0 && (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("settings.security.activityEmpty")}
          />
        )}

        {events.length > 0 && (
          <ul className="divide-border divide-y">
            {events.map((e, idx) => (
              <li
                key={`${e.action}-${e.createdAt}-${idx}`}
                className="flex items-center justify-between gap-3 py-2"
                data-slot="security-activity-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {t(actionLabelKey(e.action))}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {[
                      e.location ?? t("settings.security.unknownLocation"),
                      e.ipMasked,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <p className="text-muted-foreground shrink-0 text-xs">
                  {fmt.dateTime(e.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );
}
