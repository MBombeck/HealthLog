"use client";

/**
 * Operator panel for the shared central Codex (ChatGPT subscription) account.
 *
 * The operator connects ONE signed-in ChatGPT account here (device-code flow,
 * cookie-only `requireAdmin` on every backing route) and any user can opt into
 * it from their own AI settings. This is the ONE admin surface where the vendor
 * is named, consistent with the per-user Codex connect form — the operator is
 * knowingly linking a named account.
 *
 * The copy is loud and honest: it is a shared, signed-in account (not an API
 * key), subscription providers may use content to improve their models, the
 * account's 5-hour / weekly rate limits are shared across every opted-in user,
 * and it is never a default. OFF until the operator connects it.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Badge } from "@/components/ui/badge";
import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import { InlineAction } from "@/components/ui/inline-action";

interface CentralCodexStatus {
  status: string;
  connectedAt: string | null;
}

export function CentralCodexSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKeys.adminCentralCodex(),
    queryFn: () => apiGet<CentralCodexStatus>("/api/admin/central-codex"),
  });

  const [deviceCode, setDeviceCode] = useState<{
    userCode: string;
    verificationUrl: string;
    intervalSeconds: number;
  } | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const status = data?.status ?? "disconnected";
  const isConnected = status === "connected";

  async function handleConnect() {
    setDevicePolling(true);
    try {
      const data = await apiPost<{
        userCode: string;
        verificationUrl: string;
        intervalSeconds: number;
      }>("/api/admin/central-codex/device-start");
      setDeviceCode({
        userCode: data.userCode,
        verificationUrl: data.verificationUrl,
        intervalSeconds: data.intervalSeconds,
      });
    } catch (err) {
      showErrorToast(localizedApiError(err, t, "admin.centralCodex.error"), {
        cause: err,
      });
      setDevicePolling(false);
    }
  }

  useEffect(() => {
    if (!deviceCode) return;
    let cancelled = false;
    const intervalMs = Math.max(deviceCode.intervalSeconds, 3) * 1000;

    async function tick() {
      try {
        const data = await apiPost<{ status?: string } | null>(
          "/api/admin/central-codex/device-poll",
        );
        if (cancelled) return;
        if (data?.status === "connected") {
          setDeviceCode(null);
          setDevicePolling(false);
          toast.success(t("admin.centralCodex.connected"));
          queryClient.invalidateQueries({
            queryKey: queryKeys.adminCentralCodex(),
          });
          void invalidateKeys(queryClient, aiInputDependentKeys);
          return;
        }
        if (!cancelled) setTimeout(tick, intervalMs);
      } catch (err) {
        if (cancelled) return;
        showErrorToast(localizedApiError(err, t, "admin.centralCodex.error"), {
          cause: err,
        });
        setDeviceCode(null);
        setDevicePolling(false);
      }
    }

    const handle = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceCode]);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await apiDelete("/api/admin/central-codex");
      toast.success(t("admin.centralCodex.disconnected"));
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminCentralCodex(),
      });
      void invalidateKeys(queryClient, aiInputDependentKeys);
    } catch (err) {
      showErrorToast(localizedApiError(err, t, "admin.centralCodex.error"), {
        cause: err,
      });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <SettingsCard data-slot="admin-central-codex">
      <SettingsCardHeader
        icon={Sparkles}
        title={t("admin.centralCodex.title")}
        description={<p>{t("admin.centralCodex.description")}</p>}
        status={
          <Badge
            variant={isConnected ? "default" : "outline"}
            className={
              status === "expired"
                ? "border-warning/30 bg-warning/15 text-warning"
                : undefined
            }
          >
            {isConnected
              ? t("admin.centralCodex.statusConnected")
              : status === "expired"
                ? t("admin.centralCodex.statusExpired")
                : t("admin.centralCodex.statusDisconnected")}
          </Badge>
        }
      />

      <div className="space-y-4">
        <SettingsInfoTile icon={ShieldAlert} tone="warning">
          <p className="text-foreground">{t("admin.centralCodex.honesty")}</p>
        </SettingsInfoTile>

        {data?.connectedAt && isConnected && (
          <p className="text-muted-foreground text-xs">
            {t("admin.centralCodex.connectedSince", {
              when: formatDateTime(data.connectedAt),
            })}
          </p>
        )}

        {isConnected ? (
          <SettingsCardActions>
            <ConfirmButton
              slot="admin-central-codex-disconnect"
              destructive
              variant="destructive"
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-9"
              icon={<Trash2 className="h-4 w-4" />}
              label={t("admin.centralCodex.disconnectButton")}
              title={t("admin.centralCodex.disconnectTitle")}
              body={t("admin.centralCodex.disconnectBody")}
              confirmLabel={t("admin.centralCodex.disconnectConfirm")}
              pending={disconnecting}
              onConfirm={handleDisconnect}
            />
          </SettingsCardActions>
        ) : deviceCode ? (
          <div className="border-primary bg-primary/5 space-y-3 rounded-lg border-l-4 p-4">
            <p className="text-sm font-medium">
              {t("settings.ai.deviceCodeHeading")}
            </p>
            <ol className="text-muted-foreground list-decimal space-y-2 pl-6 text-sm">
              <li>
                {t("settings.ai.deviceCodeStep1")}{" "}
                <a
                  href={deviceCode.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary font-medium underline"
                >
                  {deviceCode.verificationUrl}
                </a>
              </li>
              <li>
                {t("settings.ai.deviceCodeStep2")}
                <div className="bg-card border-border mt-2 inline-flex items-center gap-2 rounded border px-3 py-2 font-mono text-lg tracking-widest">
                  {deviceCode.userCode}
                  <InlineAction
                    tone="muted"
                    className="underline"
                    onClick={() =>
                      navigator.clipboard?.writeText(deviceCode.userCode)
                    }
                  >
                    {t("settings.ai.deviceCodeCopy")}
                  </InlineAction>
                </div>
              </li>
              <li>{t("settings.ai.deviceCodeStep3")}</li>
            </ol>
            <div className="flex items-center gap-3 text-xs">
              {devicePolling && (
                <span className="text-muted-foreground inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                  {t("settings.ai.deviceCodeWaiting")}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setDeviceCode(null);
                  setDevicePolling(false);
                }}
                className="text-muted-foreground hover:text-foreground underline"
              >
                {t("settings.ai.deviceCodeCancel")}
              </button>
            </div>
          </div>
        ) : (
          <SettingsCardActions>
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={devicePolling}
              className="min-h-11 w-full sm:min-h-9 sm:w-auto"
              data-slot="admin-central-codex-connect"
            >
              {devicePolling ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {t("admin.centralCodex.connectButton")}
            </Button>
          </SettingsCardActions>
        )}
      </div>
    </SettingsCard>
  );
}
