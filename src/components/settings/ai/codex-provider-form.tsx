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
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

import type { InsightsSettings } from "./shared";

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
    const url = new URL(window.location.href);
    url.searchParams.delete("codex_connected");
    url.searchParams.delete("codex_error");
    window.history.replaceState({}, "", url.toString());
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
      const res = await apiFetchRaw("/api/auth/codex/device-start", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.savingError"));
      setDeviceCode({
        userCode: json.data.userCode,
        verificationUrl: json.data.verificationUrl,
        intervalSeconds: json.data.intervalSeconds,
      });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
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
        const res = await apiFetchRaw("/api/auth/codex/device-poll", {
          method: "POST",
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(json.error || t("settings.savingError"));
        }
        if (json.data?.status === "connected") {
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
        setMsg(err instanceof Error ? err.message : t("settings.savingError"));
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
      const res = await apiFetchRaw("/api/auth/codex/disconnect", {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error);
      }
      setMsg(t("settings.codexDisconnected"));
      setMsgType("success");
      void invalidateKeys(queryClient, aiInputDependentKeys);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
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
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard?.writeText(deviceCode.userCode)
                  }
                  className="text-muted-foreground hover:text-foreground text-xs underline"
                >
                  {t("settings.ai.deviceCodeCopy")}
                </button>
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
