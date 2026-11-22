"use client";

/* ────────────────────────────────────────────────────────────────
 * Runtime actions — Test active provider, regenerate insights, raw-mode toggle.
 * ──────────────────────────────────────────────────────────────── */

import { useState, type ReactNode } from "react";
import { Activity, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiFetchRaw, apiPut } from "@/lib/api/api-fetch";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { translateCodeOrNull } from "@/lib/i18n/translate-code";

import {
  localiseTestReason,
  uiToLegacyProviderEnum,
  type ProviderType,
  type UserAIProvider,
} from "./shared";

/**
 * #1417 — the stored provider value the connection test is asked to probe for
 * the provider card on screen, or null for the operator's key, which has no
 * provider value of its own: the test then probes the saved chain's first
 * entry, which is what serves the account.
 */
function testedProviderValue(provider: ProviderType): string | null {
  return provider === "codex"
    ? "CHATGPT_OAUTH"
    : uiToLegacyProviderEnum(provider);
}

type Translate = ReturnType<typeof useTranslations>["t"];

/**
 * #1417 — test the provider whose card is on screen, with what is saved for
 * it. The test used to always probe the saved setup, so picking Local and
 * pressing Test reported the gateway.
 */
function requestConnectionTest(tested: string | null): Promise<Response> {
  return apiFetchRaw(
    "/api/ai/test",
    tested
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: tested }),
        }
      : { method: "POST" },
  );
}

/** The Test button names the provider it tests. */
function testButtonLabel(
  t: Translate,
  provider: ProviderType,
  tested: string | null,
): string {
  return tested
    ? t("settings.ai.testNamedProvider", {
        provider: t(`settings.ai.providerSelect.${provider}` as const),
      })
    : t("settings.ai.testProvider");
}

/** A served provider type in words, or as sent when there are none. */
function providerName(t: Translate, type: string): string {
  return (
    translateCodeOrNull(t, "settings.ai.providerChain.types", type) ?? type
  );
}

export function RuntimeActionsRow({
  provider,
  userProvider,
  canRegenerate,
  privacyMode,
  lastInsightAt,
  onRegenerated,
  onPrivacyChanged,
  footnote,
}: {
  provider: ProviderType;
  userProvider: UserAIProvider | null | undefined;
  canRegenerate: boolean;
  privacyMode: string;
  lastInsightAt: string | null;
  onRegenerated: () => void;
  onPrivacyChanged: () => void;
  /** A closing statement rendered above the action row (the data posture). */
  footnote?: ReactNode;
}) {
  const [{ t }, fmt] = [useTranslations(), useFormatters()];
  // "Regenerate" writes the daily briefing, so it is offered only while the
  // `briefing` capability is available (operator switch, AI analysis opt-out,
  // provider, consent). The connection test stays: it is how a provider gets
  // checked before anything else can be on.
  const briefing = useAiCapability("briefing");
  const showRegenerate = canRegenerate && briefing.available;

  const testedValue = testedProviderValue(provider);
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
      const res = await requestConnectionTest(testedValue);
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
      };
      try {
        json = await res.json();
      } catch {
        setTestOk(false);
        setTestMsg(t("settings.ai.testUnexpectedResponse"));
        return;
      }
      // 4xx config errors still arrive via the error envelope. A refusal
      // because the operator switched AI off says so in words.
      if (!res.ok) {
        setTestOk(false);
        const code = (json as { meta?: { errorCode?: unknown } | null }).meta
          ?.errorCode;
        setTestMsg(
          typeof code === "string" && code.startsWith("assistant.disabled.")
            ? t("settings.ai.operatorOff.testRefused")
            : t("settings.ai.testFailedShort", {
                message:
                  translateCodeOrNull(
                    t,
                    "apiErrors",
                    typeof code === "string" ? code : null,
                  ) ?? `HTTP ${res.status}`,
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
          provider: providerName(t, json.data?.providerType ?? ""),
          model: json.data?.model ?? "",
        }),
      );
    } catch {
      setTestOk(false);
      setTestMsg(
        t("settings.ai.testFailedShort", { message: t("common.networkError") }),
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
    } catch (failure) {
      showErrorToast(t("settings.savingError"), { cause: failure });
    }
  }

  const lastInsightLine = lastInsightAt
    ? `${t("settings.lastGeneratedAt")}: ${fmt.dateTime(lastInsightAt)}`
    : null;

  // The API decides whether the provider is set up; `userProvider` stays
  // unread here.
  void userProvider;

  return (
    // §12 — the action row is the LAST thing in the block. The raw-data
    // setting and every status line (last-generated, test / regenerate
    // result) sit ABOVE it, never under it.
    <SettingsCard data-slot="ai-runtime-card">
      <SettingsCardHeader
        anchor="ai-runtime"
        icon={Activity}
        title={t("settings.ai.runtimeTitle")}
        description={lastInsightLine ?? undefined}
      />
      {showRegenerate && (
        <div>
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

      {footnote}

      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={runTest}
          disabled={testing}
          data-testid="ai-test-active-provider"
        >
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {testButtonLabel(t, provider, testedValue)}
        </Button>
        {showRegenerate && (
          <Button
            size="sm"
            variant="outline"
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
      </SettingsCardActions>
    </SettingsCard>
  );
}
