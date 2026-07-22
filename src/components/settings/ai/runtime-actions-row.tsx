"use client";

/* ────────────────────────────────────────────────────────────────
 * Runtime actions — Test active provider, regenerate insights, raw-mode toggle.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiFetchRaw, apiPut } from "@/lib/api/api-fetch";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

import {
  localiseTestReason,
  type ProviderType,
  type UserAIProvider,
} from "./shared";

export function RuntimeActionsRow({
  provider,
  userProvider,
  canRegenerate,
  privacyMode,
  lastInsightAt,
  onRegenerated,
  onPrivacyChanged,
}: {
  provider: ProviderType;
  userProvider: UserAIProvider | null | undefined;
  canRegenerate: boolean;
  privacyMode: string;
  lastInsightAt: string | null;
  onRegenerated: () => void;
  onPrivacyChanged: () => void;
}) {
  const { t } = useTranslations();

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [regen, setRegen] = useState(false);
  const [regenMsg, setRegenMsg] = useState<string | null>(null);
  const [regenOk, setRegenOk] = useState(false);

  async function runTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await apiFetchRaw("/api/ai/test", { method: "POST" });
      // Guard against a non-JSON body. A reverse proxy / Cloudflare can
      // rewrite an origin error to its own HTML page; parsing that as JSON
      // throws `Unexpected token '<'` (Safari: "did not match the
      // expected pattern"). Show a clean message instead of leaking that.
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        setTestOk(false);
        setTestMsg(t("settings.ai.testUnexpectedResponse"));
        return;
      }
      let json: {
        data?: {
          ok?: boolean;
          providerType?: string;
          model?: string;
          reasonCode?: string;
          reason?: string;
          httpStatus?: number | null;
        } | null;
        error?: string | null;
      };
      try {
        json = await res.json();
      } catch {
        setTestOk(false);
        setTestMsg(t("settings.ai.testUnexpectedResponse"));
        return;
      }
      // 4xx config errors still arrive via the error envelope.
      if (!res.ok) {
        setTestOk(false);
        setTestMsg(
          t("settings.ai.testFailedShort", {
            message: json.error ?? `HTTP ${res.status}`,
          }),
        );
        return;
      }
      // Provider-call failures now arrive as 200 + { ok:false, reasonCode }
      // so the body is never rewritten by a proxy. Map the stable code to a
      // localised string; fall back to the server's plain `reason` for any
      // unmapped / legacy code, then to a generic message.
      if (json.data && json.data.ok === false) {
        setTestOk(false);
        setTestMsg(
          localiseTestReason(
            t,
            json.data.reasonCode,
            json.data.reason,
            json.data.httpStatus,
          ) ??
            t("settings.ai.testFailedShort", { message: `HTTP ${res.status}` }),
        );
        return;
      }
      setTestOk(true);
      setTestMsg(
        t("settings.ai.testSuccess", {
          provider: json.data?.providerType ?? "",
          model: json.data?.model ?? "",
        }),
      );
    } catch (e) {
      setTestOk(false);
      setTestMsg(
        t("settings.ai.testFailedShort", {
          message: e instanceof Error ? e.message : "fetch error",
        }),
      );
    } finally {
      setTesting(false);
    }
  }

  async function regenerate() {
    setRegen(true);
    setRegenMsg(null);
    try {
      const res = await apiFetchRaw("/api/insights/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      // Same defensive guard as the connection test: a proxy can rewrite
      // a 5xx (e.g. all-providers-failed) to an HTML page, which would
      // crash `res.json()` with `Unexpected token '<'`.
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        setRegenOk(false);
        setRegenMsg(
          res.status === 429
            ? t("settings.regenerateRateLimit")
            : t("settings.ai.testUnexpectedResponse"),
        );
        return;
      }
      let json: { error?: string | null };
      try {
        json = await res.json();
      } catch {
        setRegenOk(false);
        setRegenMsg(t("settings.ai.testUnexpectedResponse"));
        return;
      }
      if (!res.ok) {
        setRegenOk(false);
        setRegenMsg(
          res.status === 429
            ? t("settings.regenerateRateLimit")
            : json.error || t("settings.savingError"),
        );
        return;
      }
      setRegenOk(true);
      setRegenMsg(t("settings.regenerateSuccess"));
      onRegenerated();
    } catch {
      setRegenOk(false);
      setRegenMsg(t("settings.savingError"));
    } finally {
      setRegen(false);
    }
  }

  async function togglePrivacy() {
    const next = privacyMode === "raw" ? "aggregated" : "raw";
    // Privacy mode is a sensitive control: only reflect the new mode
    // once the server confirms it. A swallowed 4xx/5xx would leave the
    // UI showing a setting the server never accepted.
    try {
      await apiPut("/api/insights/settings", { privacyMode: next });
      onPrivacyChanged();
    } catch {
      toast.error(t("settings.savingError"));
    }
  }

  const lastInsightLine = lastInsightAt
    ? `${t("settings.lastGeneratedAt")}: ${formatDateTime(lastInsightAt)}`
    : null;

  // Reserved for a future iteration that gates the Test button per
  // provider (e.g. disable when admin-openai is selected and no admin
  // key is present). For v1.4.16 the API decides.
  void provider;
  void userProvider;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          onClick={runTest}
          disabled={testing}
          data-testid="ai-test-active-provider"
        >
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {t("settings.ai.testProvider")}
        </Button>
        {canRegenerate && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={regenerate}
            disabled={regen}
          >
            {regen ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("settings.regenerateInsights")}
          </Button>
        )}
        {lastInsightLine && (
          <span className="text-muted-foreground text-xs">
            {lastInsightLine}
          </span>
        )}
      </div>

      {canRegenerate && (
        <div className="bg-muted/50 rounded-lg p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="pr-2">
              <p className="text-sm font-medium">{t("settings.rawData")}</p>
              <p className="text-muted-foreground text-xs">
                {privacyMode === "raw"
                  ? t("settings.rawDataOnDescription")
                  : t("settings.rawDataOffDescription")}
              </p>
            </div>
            <Switch
              aria-label={t("settings.rawData")}
              checked={privacyMode === "raw"}
              onCheckedChange={togglePrivacy}
            />
          </div>
          {privacyMode === "raw" && (
            <div className="bg-warning/15 text-warning mt-2 rounded-lg p-2 text-xs">
              {t("settings.rawDataWarning")}
            </div>
          )}
        </div>
      )}

      {testMsg && (
        <p
          className={`text-xs ${testOk ? "text-success" : "text-destructive"}`}
        >
          {testMsg}
        </p>
      )}
      {regenMsg && (
        <p
          className={`text-xs ${regenOk ? "text-success" : "text-destructive"}`}
        >
          {regenMsg}
        </p>
      )}
    </div>
  );
}
