"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Webhook } from "lucide-react";

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

interface WebhookSettings {
  enabled: boolean;
  url: string;
  headerName: string;
  hasHeaderValue: boolean;
}

export function WebhookCard({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveMsgType, setSaveMsgType] = useState<"success" | "error" | null>(
    null,
  );

  const { data: settings } = useQuery({
    queryKey: queryKeys.settingsWebhook(),
    queryFn: async () => {
      return apiGet<WebhookSettings>("/api/settings/webhook");
    },
    enabled: isAuthenticated,
  });

  // React-recommended sync-from-server pattern (no setState-in-effect).
  const settingsKey = settings
    ? `${settings.url}|${settings.headerName}`
    : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (settingsKey && settingsKey !== seededKey) {
    setSeededKey(settingsKey);
    setUrl(settings!.url);
    setHeaderName(settings!.headerName);
  }

  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiFetchRaw("/api/settings/webhook", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          headerName: headerName || undefined,
          headerValue: headerValue || undefined,
          enabled,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || t("common.error"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsWebhook() });
      setSaveMsg(t("settings.saved"));
      setSaveMsgType("success");
      setHeaderValue("");
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
    WebhookSettings | undefined
  >({
    mutationFn: (enabled) =>
      persistChannelEnabled(
        "/api/settings/webhook",
        enabled,
        t("common.error"),
      ),
    onMutate: async (enabled) => {
      const queryKey = queryKeys.settingsWebhook();
      await queryClient.cancelQueries({ queryKey });
      setSaveMsg(null);
      setSaveMsgType(null);
      return optimisticallySetChannelEnabled<WebhookSettings>(
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
      rollbackChannelEnabled(
        queryClient,
        queryKeys.settingsWebhook(),
        previous,
      );
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsWebhook() });
    },
  });

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Webhook}
        title={t("settings.webhook")}
        description={t("settings.webhookDescription")}
      />

      <div className="mt-4 space-y-4 pl-7">
        <div className="flex items-center justify-between">
          <Label htmlFor="webhook-toggle">{t("settings.webhookEnable")}</Label>
          <Switch
            id="webhook-toggle"
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
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="webhook-url">{t("settings.webhookUrl")}</Label>
              <Input
                id="webhook-url"
                placeholder="https://gotify.example.com/message?token=..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.webhookUrlHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="webhook-header-name">
                {t("settings.webhookHeaderName")}
              </Label>
              <Input
                id="webhook-header-name"
                placeholder="Authorization"
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="webhook-header-value">
                {t("settings.webhookHeaderValue")}
              </Label>
              <PasswordInput
                id="webhook-header-value"
                placeholder={
                  settings?.hasHeaderValue
                    ? t("settings.withingsCredentialsSavedPlaceholder")
                    : t("common.optional")
                }
                value={headerValue}
                onChange={(e) => setHeaderValue(e.target.value)}
              />
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
              endpoint="/api/settings/webhook/test"
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
