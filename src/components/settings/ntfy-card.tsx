"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { isNtfyFormDirty } from "@/components/settings/channel-form-dirty";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  channelSaveError,
  useChannelEnabledToggle,
} from "@/components/settings/notification-channel-toggle";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet, throwApiError } from "@/lib/api/api-fetch";

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
  const [saveError, setSaveError] = useState<string | null>(null);

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
  const dirty = isNtfyFormDirty({ serverUrl, topic, authToken }, settings);
  // The enable switch saves on tap; the form's Save covers the fields below.
  const toggle = useChannelEnabledToggle<NtfySettings>(
    "/api/settings/ntfy",
    queryKeys.settingsNtfy(),
  );

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/settings/ntfy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverUrl,
          topic,
          authToken: authToken || undefined,
          enabled: settings?.enabled ?? false,
        }),
      });
      if (!res.ok) await throwApiError(res);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsNtfy() });
      setSaveError(null);
      toastWrittenOutcome("success", t("settings.saved"));
      setAuthToken("");
    },
    // A form shows its refusal inline, next to the fields it is about.
    onError: (err) => {
      setSaveError(channelSaveError(err, t));
    },
  });

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Bell}
        title={t("settings.ntfy")}
        description={t("settings.ntfyDescription")}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="ntfy-toggle">{t("settings.ntfyEnable")}</Label>
          <Switch
            id="ntfy-toggle"
            checked={settings?.enabled ?? false}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={!settings || save.isPending || toggle.isPending}
          />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
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

          {saveError && (
            <p role="alert" className="text-destructive text-sm">
              {saveError}
            </p>
          )}

          <SettingsCardActions>
            <TestConnectionButton
              endpoint="/api/settings/ntfy/test"
              disabled={!settings?.enabled}
              unsavedChanges={dirty}
            />
            <Button
              type="submit"
              disabled={save.isPending || toggle.isPending}
              className="min-h-11"
            >
              {save.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("common.save")}
            </Button>
          </SettingsCardActions>
        </form>
      </div>
    </SettingsCard>
  );
}
