"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/settings/password-input";
import { useAuth } from "@/hooks/use-auth";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface InsightsSettings {
  codexStatus: string;
  codexConnectedAt: string | null;
  hasAdminKey: boolean;
  privacyMode: string;
  lastInsightAt: string | null;
}

interface UserAIProvider {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasAnthropicKey: boolean;
  anthropicKeyPreview: string | null;
  hasLocalKey: boolean;
}

export function AiSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  return (
    <section aria-labelledby="settings-section-ai-title" className="space-y-6">
      <header className="space-y-1">
        <h1
          id="settings-section-ai-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.ai.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.ai.description")}
        </p>
      </header>

      <InsightsSettingsCard isAuthenticated={isAuthenticated} />
    </section>
  );
}

function InsightsSettingsCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["insights", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/insights/settings");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as InsightsSettings;
    },
    enabled: isAuthenticated,
  });

  const updateSettings = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch("/api/insights/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  // OAuth callback handler — reads `?codex_connected=true|codex_error=...`
  // from the URL and surfaces a toast-equivalent inline message. We do the
  // read at render time (via a `useState` lazy initialiser) so the strict
  // `react-hooks/set-state-in-effect` rule isn't triggered. The effect then
  // drains the result by clearing the URL params and invalidating queries.
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
    // The browser-history rewrite is the side effect; the matching i18n
    // message is already painted via the lazy initialiser below.
    window.history.replaceState({}, "", window.location.pathname);
    if (oauthOutcome.kind === "connected") {
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    }
  }, [oauthOutcome, queryClient]);

  // Seed the initial inline message from the OAuth outcome. Reads happen
  // during render (allowed) — `setMsg` is only called by user actions after
  // mount, never inside an effect.
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

  const hasProvider =
    settings?.codexStatus === "connected" || settings?.hasAdminKey;

  function handleConnect() {
    window.location.href = "/api/auth/codex/authorize";
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/codex/disconnect", {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error);
      }
      setMsg(t("settings.codexDisconnected"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
      setMsgType("error");
    } finally {
      setDisconnecting(false);
    }
  }

  async function togglePrivacyMode() {
    const newMode = settings?.privacyMode === "raw" ? "aggregated" : "raw";
    await updateSettings.mutateAsync({ privacyMode: newMode });
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await fetch("/api/insights/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setMsg(t("settings.regenerateRateLimit"));
        } else {
          setMsg(json.error || t("settings.savingError"));
        }
        setMsgType("error");
        return;
      }
      setMsg(t("settings.regenerateSuccess"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    } catch {
      setMsg(t("settings.savingError"));
      setMsgType("error");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.kiInsights")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {settings?.codexStatus === "connected" && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              ChatGPT verbunden
            </Badge>
          )}
          {settings?.codexStatus !== "connected" && settings?.hasAdminKey && (
            <Badge className="border-dracula-purple/30 bg-dracula-purple/15 text-dracula-purple">
              Admin-KI aktiv
            </Badge>
          )}
          {settings?.codexStatus === "expired" && (
            <Badge className="border-dracula-orange/30 bg-dracula-orange/15 text-dracula-orange">
              Verbindung abgelaufen
            </Badge>
          )}
          {settings?.lastInsightAt && (
            <Badge variant="outline" className="text-xs">
              {t("settings.lastGeneratedAt")}:{" "}
              {formatDateTime(settings.lastInsightAt)}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.kiInsightsDescription")}
      </p>

      <div className="mt-4 space-y-4">
        <div className="bg-muted/50 rounded-lg p-4">
          {settings?.codexStatus === "connected" ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">ChatGPT verbunden</p>
                <p className="text-muted-foreground text-xs">
                  Insights werden über dein ChatGPT-Abo generiert — keine
                  zusätzlichen Kosten.
                  {settings.codexConnectedAt && (
                    <>
                      {" "}
                      Verbunden seit {formatDateTime(settings.codexConnectedAt)}
                      .
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive shrink-0"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-4 w-4" />
                )}
                Trennen
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Mit ChatGPT verbinden</p>
                <p className="text-muted-foreground text-xs">
                  Verbinde dein ChatGPT Pro/Max-Konto um KI-gestützte
                  Gesundheitsanalysen basierend auf aktuellen medizinischen
                  Leitlinien zu erhalten. Keine zusätzlichen API-Kosten.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleConnect}
                className="w-full sm:w-auto"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Mit ChatGPT verbinden
              </Button>
              {settings?.hasAdminKey && (
                <p className="text-muted-foreground text-xs">
                  Alternativ nutzt HealthLog den vom Administrator
                  konfigurierten KI-Anbieter.
                </p>
              )}
            </div>
          )}
        </div>

        {msg && (
          <p
            role="alert"
            className={`text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
          >
            {msg}
          </p>
        )}

        {hasProvider && (
          <div className="bg-muted/50 rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="pr-2">
                <p className="text-sm font-medium">{t("settings.rawData")}</p>
                <p className="text-muted-foreground text-xs">
                  {settings?.privacyMode === "raw"
                    ? t("settings.rawDataOnDescription")
                    : t("settings.rawDataOffDescription")}
                </p>
              </div>
              <div className="ml-2 shrink-0">
                <Switch
                  checked={settings?.privacyMode === "raw"}
                  onCheckedChange={togglePrivacyMode}
                />
              </div>
            </div>
            {settings?.privacyMode === "raw" && (
              <div className="mt-2 rounded-lg bg-orange-500/10 p-2 text-xs text-orange-400">
                {t("settings.rawDataWarning")}
              </div>
            )}
          </div>
        )}

        {hasProvider && (
          <Button
            variant="outline"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="w-full sm:w-auto"
          >
            {regenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("settings.regenerateInsights")}
          </Button>
        )}

        <UserAIProviderSubsection />
      </div>
    </div>
  );
}

function UserAIProviderSubsection() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [anthropicKey, setAnthropicKey] = useState<string>("");
  const [localKey, setLocalKey] = useState<string>("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<boolean>(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);

  const { data, isLoading } = useQuery({
    queryKey: ["user", "ai-provider"],
    queryFn: async () => {
      const res = await fetch("/api/user/ai-provider");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as UserAIProvider;
    },
  });

  // React-recommended sync-from-server pattern (no setState-in-effect).
  const dataKey = data
    ? `${data.provider ?? ""}|${data.model ?? ""}|${data.baseUrl ?? ""}`
    : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (dataKey && dataKey !== seededKey) {
    setSeededKey(dataKey);
    setProvider(data!.provider ?? "");
    setModel(data!.model ?? "");
    setBaseUrl(data!.baseUrl ?? "");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: provider || null,
        model: model || null,
        baseUrl: baseUrl || null,
      };
      if (anthropicKey.trim()) body.anthropicKey = anthropicKey.trim();
      if (localKey.trim()) body.localKey = localKey.trim();
      const res = await fetch("/api/user/ai-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
    },
    onSuccess: () => {
      setSaveMsg("Gespeichert");
      setSaveOk(true);
      setAnthropicKey("");
      setLocalKey("");
      queryClient.invalidateQueries({ queryKey: ["user", "ai-provider"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
    onError: (e) => {
      setSaveMsg(e instanceof Error ? e.message : "Fehler");
      setSaveOk(false);
    },
  });

  async function runTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const overrideBody: Record<string, string> = {};
      if (provider) overrideBody.provider = provider;
      if (model.trim()) overrideBody.model = model.trim();
      if (baseUrl.trim()) overrideBody.baseUrl = baseUrl.trim();
      if (anthropicKey.trim()) overrideBody.anthropicKey = anthropicKey.trim();
      if (localKey.trim()) overrideBody.localKey = localKey.trim();
      const hasOverride = Object.keys(overrideBody).length > 0;
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: hasOverride ? { "Content-Type": "application/json" } : {},
        body: hasOverride ? JSON.stringify(overrideBody) : undefined,
      });
      const json = await res.json();
      if (!res.ok) {
        setTestMsg(json.error || `HTTP ${res.status}`);
        setTestOk(false);
        return;
      }
      setTestMsg(
        `OK — ${json.data.providerType} (${json.data.model})${
          json.data.tokensUsed ? `, ${json.data.tokensUsed} tokens` : ""
        }`,
      );
      setTestOk(true);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : "Test fehlgeschlagen");
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  if (isLoading) return null;

  return (
    <div className="bg-muted/50 mt-2 rounded-lg p-4">
      <div className="mb-3">
        <p className="text-sm font-medium">KI-Provider (persönlich)</p>
        <p className="text-muted-foreground text-xs">
          Eigener KI-Anbieter überschreibt die Admin-Einstellung. Leer lassen
          für Standard.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ai-provider-select">Provider</Label>
          <select
            id="ai-provider-select"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="bg-background border-input mt-1 h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="">— Standard (Admin/Codex) —</option>
            <option value="OPENAI">OpenAI</option>
            <option value="ANTHROPIC">Anthropic (Claude)</option>
            <option value="LOCAL">Lokal (OpenAI-kompatibel)</option>
            <option value="CHATGPT_OAUTH">ChatGPT OAuth</option>
          </select>
        </div>

        <div>
          <Label htmlFor="ai-model-input">Modell</Label>
          <Input
            id="ai-model-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={
              provider === "ANTHROPIC"
                ? "claude-3-5-sonnet-latest"
                : provider === "LOCAL"
                  ? "llama3:8b"
                  : "gpt-4o-mini"
            }
            className="mt-1"
          />
        </div>

        {provider === "ANTHROPIC" && (
          <div className="sm:col-span-2">
            <Label htmlFor="ai-anthropic-key">
              Anthropic API Key
              {data?.hasAnthropicKey && (
                <span className="text-muted-foreground ml-2 text-xs">
                  (gespeichert {data.anthropicKeyPreview})
                </span>
              )}
            </Label>
            <PasswordInput
              id="ai-anthropic-key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-..."
              className="mt-1"
            />
          </div>
        )}

        {provider === "LOCAL" && (
          <>
            <div className="sm:col-span-2">
              <Label htmlFor="ai-base-url">Base URL</Label>
              <Input
                id="ai-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="ai-local-key">API Key (optional)</Label>
              <PasswordInput
                id="ai-local-key"
                value={localKey}
                onChange={(e) => setLocalKey(e.target.value)}
                placeholder={data?.hasLocalKey ? "(gespeichert)" : ""}
                className="mt-1"
              />
            </div>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Speichern
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={runTest}
          disabled={testing}
        >
          {testing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          Verbindung testen
        </Button>
      </div>

      {saveMsg && (
        <p
          className={`mt-2 text-xs ${
            saveOk ? "text-dracula-green" : "text-destructive"
          }`}
        >
          {saveMsg}
        </p>
      )}
      {testMsg && (
        <p
          className={`mt-2 text-xs ${
            testOk ? "text-dracula-green" : "text-destructive"
          }`}
        >
          {testMsg}
        </p>
      )}
    </div>
  );
}
