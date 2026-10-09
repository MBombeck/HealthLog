"use client";

/**
 * v1.23 — Settings → "Trusted devices" ("remember this device").
 *
 * Lists the browsers the user opted to trust at the second-factor step. A
 * trusted device skips factor 2 for 30 days (the password is still required);
 * this card makes them visible and revocable. The list is hidden entirely when
 * empty so a user who never opted in sees no clutter.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiDelete } from "@/lib/api/api-fetch";

interface TrustedDeviceRow {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export function TrustedDevicesCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.trustedDevices(),
    queryFn: () =>
      apiGet<{ devices: TrustedDeviceRow[] }>("/api/auth/me/trusted-devices"),
    enabled: isAuthenticated,
  });

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.trustedDevices(),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.securityActivity(),
    });
  }

  const revokeOne = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/auth/me/trusted-devices/${id}`),
    onSuccess: () => {
      setStatus(null);
      invalidate();
    },
    onError: () => setStatus(t("settings.security.trustedDevices.revokeError")),
  });

  const revokeAll = useMutation({
    mutationFn: () =>
      apiDelete<{ revoked: number }>("/api/auth/me/trusted-devices"),
    onSuccess: (res) => {
      setStatus(
        t("settings.security.trustedDevices.revokeAllDone", {
          count: res?.revoked ?? 0,
        }),
      );
      invalidate();
    },
    onError: () => setStatus(t("settings.security.trustedDevices.revokeError")),
  });

  const devices = data?.devices ?? [];

  // Hide the whole card when the user has no trusted devices — nothing to show
  // and no opt-in is offered here (that happens at the second-factor step).
  if (!isLoading && !isError && devices.length === 0) {
    return null;
  }

  return (
    <SettingsCard data-slot="settings-trusted-devices-card">
      <SettingsCardHeader
        anchor="trusted-devices"
        icon={ShieldCheck}
        title={t("settings.security.trustedDevices.title")}
      />
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs">
          {t("settings.security.trustedDevices.description")}
        </p>

        {isLoading && (
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
        )}

        {isError && (
          <QueryErrorRow
            message={t("settings.security.trustedDevices.loadError")}
            onRetry={() => refetch()}
          />
        )}

        {devices.length > 0 && (
          <ul className="divide-border divide-y">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-3 py-3"
                data-slot="trusted-device-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {d.label ?? t("settings.security.trustedDevices.unnamed")}
                    {d.isCurrent && (
                      <span className="text-success ml-2 text-xs font-normal">
                        {t("settings.security.trustedDevices.current")}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("settings.security.trustedDevices.expires", {
                      date: fmt.date(d.expiresAt),
                    })}
                  </p>
                </div>
                <ConfirmButton
                  slot="revoke-trusted-device"
                  size="sm"
                  className="min-h-9 shrink-0"
                  label={t("settings.security.trustedDevices.revoke")}
                  title={t(
                    "settings.security.trustedDevices.revokeConfirmTitle",
                  )}
                  body={t("settings.security.trustedDevices.revokeConfirmBody")}
                  confirmLabel={t("settings.security.trustedDevices.revoke")}
                  onConfirm={() => revokeOne.mutate(d.id)}
                  pending={revokeOne.isPending}
                />
              </li>
            ))}
          </ul>
        )}

        {devices.length > 0 && (
          <SettingsCardActions>
            <ConfirmButton
              slot="revoke-all-trusted-devices"
              className="min-h-11 sm:min-h-9"
              label={t("settings.security.trustedDevices.revokeAll")}
              title={t(
                "settings.security.trustedDevices.revokeAllConfirmTitle",
              )}
              body={t("settings.security.trustedDevices.revokeAllConfirmBody")}
              confirmLabel={t("settings.security.trustedDevices.revokeAll")}
              onConfirm={() => revokeAll.mutate()}
              pending={revokeAll.isPending}
            />
          </SettingsCardActions>
        )}

        {status && (
          <p role="status" className="text-muted-foreground text-right text-sm">
            {status}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
