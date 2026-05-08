"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Smile,
  Unlink,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/settings/password-input";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { useAuth } from "@/hooks/use-auth";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, measurementDependentKeys } from "@/lib/query-keys";

interface MoodLogStatus {
  configured: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
  entryCount: number;
  webhookSecret: string | null;
}

interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
  moodLogGlobal: boolean;
}

export function IntegrationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data: globalServices } = useQuery({
    queryKey: ["settings", "global-services"],
    queryFn: async () => {
      const res = await fetch("/api/settings/global-services");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as GlobalServiceAvailability;
    },
    enabled: isAuthenticated,
  });

  const moodLogEnabled = globalServices?.moodLogGlobal ?? true;

  return (
    <section
      aria-labelledby="settings-section-integrations-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-integrations-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.integrations.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.integrations.description")}
        </p>
      </header>

      <WithingsCard isAuthenticated={isAuthenticated} />
      {moodLogEnabled && <MoodLogCard />}
    </section>
  );
}

function WithingsCard({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslations();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["withings", "status"],
    queryFn: async () => {
      const res = await fetch("/api/withings/status");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        connected: boolean;
        configured: boolean;
        lastSyncedAt?: string | null;
        connectedAt?: string;
        tokenExpired?: boolean;
      };
    },
    enabled: isAuthenticated,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/withings/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["withings"] });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await fetch("/api/withings/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(
          fullSync
            ? t("settings.withingsFullSyncResult", {
                count: json.data.imported,
              })
            : t("settings.withingsSyncResult", { count: json.data.imported }),
        );
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
      } else {
        setSyncMsg(json.error || t("settings.withingsSyncFailed"));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t("settings.withingsSyncFailed"));
      setSyncMsgType("error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await fetch("/api/withings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.withingsCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: ["withings"] });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link2 className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.withings")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status?.configured && !status?.connected && (
            <Badge variant="outline" className="text-xs">
              {t("settings.configured")}
            </Badge>
          )}
          {status?.connected && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.withingsConnected")}
            </Badge>
          )}
          {status?.lastSyncedAt && (
            <Badge variant="outline" className="text-xs">
              {t("settings.withingsLastSync")}:{" "}
              {formatDateTime(status.lastSyncedAt)}
            </Badge>
          )}
          {status?.tokenExpired && (
            <Badge variant="destructive" className="text-xs">
              {t("settings.withingsTokenExpired")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.withingsDescription")}
      </p>

      <div className="mt-4 space-y-4">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">
            {t("settings.withingsCredentials")}
          </h3>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="w-clientid">
                  {t("settings.withingsClientId")}
                </Label>
                <Input
                  id="w-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholder")
                      : t("settings.withingsClientId")
                  }
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-secret">
                  {t("settings.withingsClientSecret")}
                </Label>
                <PasswordInput
                  id="w-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholderSecret")
                      : t("settings.withingsClientSecret")
                  }
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="invisible">{t("common.save")}</Label>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  className="h-9 w-full"
                  disabled={
                    credsSaving || !clientId.trim() || !clientSecret.trim()
                  }
                >
                  {credsSaving ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t("settings.withingsSaveCredentials")}
                </Button>
              </div>
            </div>
            {credsMsg && (
              <p
                role="alert"
                className={`text-sm ${credsMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
          </form>
        </div>

        {status?.connected ? (
          <>
            <div className="flex flex-wrap items-start gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.withingsSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={syncing}>
                    {syncing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t("settings.withingsFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.withingsSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/withings/test"
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                  >
                    <Unlink className="mr-1 h-3.5 w-3.5" />
                    {t("settings.withingsDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.withingsDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncMsg && (
              <p
                role="alert"
                className={`text-sm ${syncMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/withings/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            {t("settings.withingsConnect")}
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            {t("settings.withingsNoCredentials")}
          </div>
        )}
      </div>
    </div>
  );
}

function MoodLogCard() {
  const { t } = useTranslations();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["moodlog-status"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/moodlog/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as MoodLogStatus;
    },
  });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/settings/moodlog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim(), apiKey: apiKey.trim() }),
    });
    if (res.ok) {
      setMsg(t("settings.moodLogSaved"));
      setMsgType("success");
      setUrl("");
      setApiKey("");
      await refetchStatus();
    } else {
      const json = await res.json();
      setMsg(json.error || t("settings.savingError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations/moodlog/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      if (res.ok) {
        const json = await res.json();
        setMsg(
          t("settings.moodLogSyncResult").replace(
            "{count}",
            String(json.data.imported),
          ),
        );
        setMsgType("success");
        await refetchStatus();
      } else {
        setMsg(t("settings.moodLogSyncFailed"));
        setMsgType("error");
      }
    } catch {
      setMsg(t("settings.moodLogSyncFailed"));
      setMsgType("error");
    }
    setSyncing(false);
  }

  async function handleDisconnect() {
    const res = await fetch("/api/settings/moodlog", { method: "DELETE" });
    if (res.ok) {
      setMsg(t("settings.moodLogDisconnected"));
      setMsgType("success");
      await refetchStatus();
    }
  }

  return (
    <div className="bg-card border-border space-y-4 rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Smile className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">
            <a
              href="https://moodlog.onback.io"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {t("settings.moodLogTitle")}
            </a>
          </h2>
        </div>
        {status?.configured && (
          <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
            {status.enabled
              ? t("settings.withingsConnected")
              : t("settings.configured")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t("settings.moodLogDescription")}
      </p>

      <form onSubmit={handleSave} className="space-y-3">
        <div>
          <Label>{t("settings.moodLogUrl")}</Label>
          <Input
            type="url"
            placeholder={t("settings.moodLogUrlPlaceholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("settings.moodLogApiKey")}</Label>
          <PasswordInput
            placeholder={
              status?.configured
                ? t("settings.withingsCredentialsSavedPlaceholder")
                : t("settings.moodLogApiKeyPlaceholder")
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button
            type="submit"
            disabled={saving || (!url.trim() && !apiKey.trim())}
            size="sm"
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" />
            {t("common.save")}
          </Button>
          <TestConnectionButton
            endpoint="/api/integrations/moodlog/test"
            disabled={!status?.configured}
          />
        </div>
      </form>

      {status?.configured && (
        <div className="space-y-3 border-t pt-3">
          {status.webhookSecret && (
            <div>
              <Label>{t("settings.moodLogWebhookSecret")}</Label>
              <div className="flex gap-2">
                <Input
                  value={status.webhookSecret}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(status.webhookSecret!);
                    setMsg(t("common.copied"));
                    setMsgType("success");
                  }}
                >
                  {t("common.copied").replace("!", "")}
                </Button>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("settings.moodLogWebhookSecretHelp")}
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-4 text-sm">
            {status.lastSyncedAt && (
              <span>
                {t("settings.moodLogLastSync")}:{" "}
                {formatDateTime(status.lastSyncedAt)}
              </span>
            )}
            <span>
              {t("settings.moodLogEntries")}: {status.entryCount}
            </span>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={syncing}
              onClick={() => handleSync(false)}
            >
              {syncing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("settings.moodLogSync")}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={syncing}>
                  <Download className="mr-2 h-4 w-4" />
                  {t("settings.moodLogFullSync")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("settings.moodLogFullSyncTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("settings.moodLogFullSyncDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => handleSync(true)}>
                    {t("settings.moodLogFullSync")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Unlink className="mr-2 h-4 w-4" />
                  {t("settings.moodLogDisconnect")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("settings.moodLogDisconnectTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("settings.moodLogDisconnectDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDisconnect}>
                    {t("settings.moodLogDisconnect")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {msg && (
        <p
          role="alert"
          className={`text-sm ${msgType === "error" ? "text-destructive" : "text-dracula-green"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
