"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Loader2, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/settings/password-input";
import { useTranslations } from "@/lib/i18n/context";

interface NtfySettings {
  enabled: boolean;
  serverUrl: string;
  topic: string;
  hasAuthToken: boolean;
}

export function NtfyCard({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [serverUrl, setServerUrl] = useState("https://ntfy.sh");
  const [topic, setTopic] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveMsgType, setSaveMsgType] = useState<"success" | "error" | null>(
    null,
  );

  const { data: settings } = useQuery({
    queryKey: ["settings", "ntfy"],
    queryFn: async () => {
      const res = await fetch("/api/settings/ntfy");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as NtfySettings;
    },
    enabled: isAuthenticated,
  });

  // React-recommended sync-from-server pattern (no setState-in-effect).
  const settingsKey = settings
    ? `${settings.serverUrl}|${settings.topic}`
    : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (settingsKey && settingsKey !== seededKey) {
    setSeededKey(settingsKey);
    setServerUrl(settings!.serverUrl);
    setTopic(settings!.topic);
  }

  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/settings/ntfy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverUrl,
          topic,
          authToken: authToken || undefined,
          enabled,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || t("common.error"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "ntfy"] });
      setSaveMsg(t("settings.saved"));
      setSaveMsgType("success");
      setAuthToken("");
    },
    onError: (err: Error) => {
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
  });

  const test = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/ntfy/test", { method: "POST" });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || t("common.error"));
      }
    },
    onSuccess: () => {
      setSaveMsg(t("settings.testSent"));
      setSaveMsgType("success");
    },
    onError: (err: Error) => {
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
  });

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bell className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.ntfy")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {settings?.serverUrl && settings?.topic && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.configured")}
            </Badge>
          )}
          {settings?.enabled && (
            <Badge variant="outline" className="text-xs">
              {t("common.enabled")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.ntfyDescription")}
      </p>

      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="ntfy-toggle">{t("settings.ntfyEnable")}</Label>
          <Switch
            id="ntfy-toggle"
            checked={settings?.enabled ?? false}
            onCheckedChange={(checked) => save.mutate(checked)}
            disabled={save.isPending}
          />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(settings?.enabled ?? false);
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ntfy-server">{t("settings.ntfyServer")}</Label>
              <Input
                id="ntfy-server"
                placeholder="https://ntfy.sh"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ntfy-topic">{t("settings.ntfyTopic")}</Label>
              <Input
                id="ntfy-topic"
                placeholder="healthlog-mein-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="ntfy-auth">{t("settings.ntfyAuthToken")}</Label>
              <PasswordInput
                id="ntfy-auth"
                placeholder={
                  settings?.hasAuthToken
                    ? t("settings.saved")
                    : t("common.optional")
                }
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.ntfyAuthTokenHint")}
              </p>
            </div>
          </div>

          {saveMsg && (
            <p
              role="alert"
              className={`text-sm ${saveMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
            >
              {saveMsg}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={test.isPending || !settings?.enabled}
              onClick={() => test.mutate()}
            >
              {test.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.testMessage")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
