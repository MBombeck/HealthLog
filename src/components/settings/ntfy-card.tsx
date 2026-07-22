"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import {
  optimisticallySetChannelEnabled,
  persistChannelEnabled,
  rollbackChannelEnabled,
} from "@/components/settings/notification-channel-toggle";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";

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
    queryKey: queryKeys.settingsNtfy(),
    queryFn: async () => {
      return apiGet<NtfySettings>("/api/settings/ntfy");
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
      const res = await apiFetchRaw("/api/settings/ntfy", {
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
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsNtfy() });
      setSaveMsg(t("settings.saved"));
      setSaveMsgType("success");
      setAuthToken("");
    },
    onError: (err: Error) => {
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
  });

  const toggleEnabled = useMutation<
    void,
    Error,
    boolean,
    NtfySettings | undefined
  >({
    mutationFn: (enabled) =>
      persistChannelEnabled("/api/settings/ntfy", enabled, t("common.error")),
    onMutate: async (enabled) => {
      const queryKey = queryKeys.settingsNtfy();
      await queryClient.cancelQueries({ queryKey });
      setSaveMsg(null);
      setSaveMsgType(null);
      return optimisticallySetChannelEnabled<NtfySettings>(
        queryClient,
        queryKey,
        enabled,
      );
    },
    onSuccess: () => {
      setSaveMsg(t("settings.saved"));
      setSaveMsgType("success");
    },
    onError: (err, _enabled, previous) => {
      rollbackChannelEnabled(queryClient, queryKeys.settingsNtfy(), previous);
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsNtfy() });
    },
  });

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Bell}
        title={t("settings.ntfy")}
        description={t("settings.ntfyDescription")}
      />

      <div className="mt-4 space-y-4 pl-7">
        <div className="flex items-center justify-between">
          <Label htmlFor="ntfy-toggle">{t("settings.ntfyEnable")}</Label>
          <Switch
            id="ntfy-toggle"
            checked={settings?.enabled ?? false}
            onCheckedChange={(checked) => toggleEnabled.mutate(checked)}
            disabled={save.isPending || toggleEnabled.isPending}
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
                    ? t("settings.withingsCredentialsSavedPlaceholder")
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
              className={`text-sm ${saveMsgType === "success" ? "text-success" : "text-destructive"}`}
            >
              {saveMsg}
            </p>
          )}

          <div className="flex flex-wrap items-start justify-end gap-2">
            <TestConnectionButton
              endpoint="/api/settings/ntfy/test"
              disabled={!settings?.enabled}
            />
            <Button
              type="submit"
              disabled={save.isPending || toggleEnabled.isPending}
              className="min-h-11"
            >
              {save.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>
    </SettingsCard>
  );
}
