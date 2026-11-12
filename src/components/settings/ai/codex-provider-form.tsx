"use client";

/* ────────────────────────────────────────────────────────────────
 * Codex (ChatGPT account) form — connect / disconnect / status.
 * ──────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { apiDelete, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

import type { InsightsSettings } from "./shared";
import { InlineAction } from "@/components/ui/inline-action";
import { dropParams, writeUrlState } from "@/lib/url-state";

export function CodexProviderForm({
  settings,
}: {
  settings: InsightsSettings | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<{
    userCode: string;
    verificationUrl: string;
    intervalSeconds: number;
  } | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);

  // OAuth callback handler — reads `?codex_connected=true|codex_error=…`
  // from the URL and surfaces an inline message.
  const [oauthOutcome] = useState<
    { kind: "connected" } | { kind: "error" } | null
  >(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get("codex_connected") === "true") return { kind: "connected" };
    if (params.get("codex_error")) return { kind: "error" };
    return null;
  });

  useEffect(() => {
    if (!oauthOutcome) return;
    writeUrlState(dropParams("codex_connected", "codex_error"), {
      afterPaint: true,
    });
    if (oauthOutcome.kind === "connected") {
      void invalidateKeys(queryClient, aiInputDependentKeys);
    }
  }, [oauthOutcome, queryClient]);

  const [oauthMsgSeeded, setOauthMsgSeeded] = useState(false);
  if (!oauthMsgSeeded && oauthOutcome) {
    setOauthMsgSeeded(true);
    if (oauthOutcome.kind === "connected") {
      setMsg(t("settings.codexConnected"));
      setMsgType("success");
    } else {
      setMsg(t("settings.codexConnectionFailed"));
      setMsgType("error");
    }
  }

  async function handleConnect() {
    setMsg(null);
    setDevicePolling(true);
    try {
      const data = await apiPost<{
        userCode: string;
        verificationUrl: string;
        intervalSeconds: number;
      }>("/api/auth/codex/device-start");
      setDeviceCode({
        userCode: data.userCode,
        verificationUrl: data.verificationUrl,
        intervalSeconds: data.intervalSeconds,
      });
    } catch (err) {
      setMsg(localizedApiError(err, t, "settings.codexConnectionFailed"));
      setMsgType("error");
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
          "/api/auth/codex/device-poll",
        );
        if (cancelled) return;
        if (data?.status === "connected") {
          setDeviceCode(null);
          setDevicePolling(false);
          setMsg(t("settings.codexConnected"));
          setMsgType("success");
          void invalidateKeys(queryClient, aiInputDependentKeys);
          return;
        }
        if (!cancelled) setTimeout(tick, intervalMs);
      } catch (err) {
        if (cancelled) return;
        setMsg(localizedApiError(err, t, "settings.codexConnectionFailed"));
        setMsgType("error");
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

  function handleCancelDevice() {
    setDeviceCode(null);
    setDevicePolling(false);
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setMsg(null);
    try {
      await apiDelete("/api/auth/codex/disconnect");
      setMsg(t("settings.codexDisconnected"));
      setMsgType("success");
      void invalidateKeys(queryClient, aiInputDependentKeys);
    } catch (err) {
      setMsg(localizedApiError(err, t, "settings.savingError"));
      setMsgType("error");
    } finally {
      setDisconnecting(false);
    }
  }

  const status = settings?.codexStatus;
  const isConnected = status === "connected";

  return (
    <div data-testid="ai-provider-config-codex" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {t("settings.ai.codex.modelSlugLabel")}
        </span>
        {isConnected ? (
          <Badge className="border-success/30 bg-success/15 text-success">
            {t("settings.ai.codex.statusConnected")}
          </Badge>
        ) : status === "expired" ? (
          <Badge className="border-warning/30 bg-warning/15 text-warning">
            {t("settings.ai.codex.statusExpired")}
          </Badge>
        ) : (
          <Badge variant="outline">
            {t("settings.ai.codex.statusDisconnected")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t("settings.ai.codex.modelSlugBody")}
      </p>
      {settings?.lastInsightAt && (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.codex.lastInsight", {
            when: formatDateTime(settings.lastInsightAt),
          })}
        </p>
      )}
      {settings?.codexConnectedAt && isConnected && (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.connectedSince", {
            when: formatDateTime(settings.codexConnectedAt),
          })}
        </p>
      )}

      {settings?.codexOauthConfigured === false ? (
        <p className="text-muted-foreground text-xs italic">
          {t("settings.ai.oauthNotConfigured")}
        </p>
      ) : isConnected ? (
        <ConfirmButton
          slot="settings-codex-disconnect"
          destructive
          variant="outline"
          size="sm"
          className="text-destructive min-h-11 shrink-0 sm:min-h-9"
          icon={<Trash2 className="h-4 w-4" />}
          label={t("settings.ai.codex.disconnectButton")}
          title={t("settings.ai.codex.disconnectTitle")}
          body={t("settings.ai.codex.disconnectBody")}
          confirmLabel={t("settings.ai.codex.disconnectConfirm")}
          pending={disconnecting}
          onConfirm={handleDisconnect}
        />
      ) : deviceCode ? (
        <div className="border-primary bg-primary/5 space-y-3 rounded-lg border-l-4 p-4">
          <p className="text-sm font-medium">
            {t("settings.ai.deviceCodeHeading")}
          </p>
          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
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
                  onClick={() =>
                    navigator.clipboard?.writeText(deviceCode.userCode)
                  }
                  tone="muted"
                  className="underline"
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
              onClick={handleCancelDevice}
              className="text-muted-foreground hover:text-foreground underline"
            >
              {t("settings.ai.deviceCodeCancel")}
            </button>
          </div>
        </div>
      ) : (
        <SettingsCardActions>
          <Button
            variant="outline"
            onClick={handleConnect}
            disabled={devicePolling}
            className="min-h-11 sm:min-h-9"
          >
            {devicePolling ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {t("settings.ai.codex.connectButton")}
          </Button>
        </SettingsCardActions>
      )}

      {msg && (
        <p
          role="alert"
          className={`text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
