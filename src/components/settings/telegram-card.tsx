"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, Save } from "lucide-react";

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

interface TelegramSettings {
  enabled: boolean;
  hasBotToken: boolean;
  chatId: string | null;
}

export function TelegramCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: settings } = useQuery({
    queryKey: queryKeys.telegramSettings(),
    queryFn: async () => {
      return apiGet<TelegramSettings>("/api/settings/telegram");
    },
    enabled: isAuthenticated,
  });

  // Sync from server using the React-recommended "previous-payload-id"
  // pattern instead of setState-in-effect. This avoids the strict
  // `react-hooks/set-state-in-effect` lint failure that the legacy file
  // disabled at module scope.
  const settingsKey = settings ? (settings.chatId ?? "") : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (settingsKey && settingsKey !== seededKey) {
    setSeededKey(settingsKey);
    if (settings!.chatId) setChatId(settings!.chatId);
  }

  const toggleEnabled = useMutation<
    void,
    Error,
    boolean,
    TelegramSettings | undefined
  >({
    mutationFn: (enabled) =>
      persistChannelEnabled(
        "/api/settings/telegram",
        enabled,
        t("settings.savingError"),
      ),
    onMutate: async (enabled) => {
      const queryKey = queryKeys.telegramSettings();
      await queryClient.cancelQueries({ queryKey });
      setMsg(null);
      setMsgType(null);
      return optimisticallySetChannelEnabled<TelegramSettings>(
        queryClient,
        queryKey,
        enabled,
      );
    },
    onSuccess: () => {
      setMsg(t("settings.saved"));
      setMsgType("success");
    },
    onError: (err, _enabled, previous) => {
      rollbackChannelEnabled(
        queryClient,
        queryKeys.telegramSettings(),
        previous,
      );
      setMsg(err.message);
      setMsgType("error");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.telegramSettings() });
    },
  });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setMsgType(null);

    const body: Record<string, unknown> = {
      enabled: settings?.enabled ?? false,
    };
    if (botToken.trim()) body.botToken = botToken.trim();
    if (chatId !== (settings?.chatId ?? "")) body.chatId = chatId;

    const res = await apiFetchRaw("/api/settings/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setMsg(t("settings.saved"));
      setMsgType("success");
      setBotToken("");
      queryClient.invalidateQueries({ queryKey: queryKeys.telegram() });
    } else {
      const json = await res.json();
      setMsg(json.error || t("settings.savingError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={MessageCircle}
        title={t("settings.telegram")}
        description={t("settings.telegramDescription")}
      />

      <div className="mt-4 space-y-4 pl-7">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tg-token">{t("settings.botToken")}</Label>
              <PasswordInput
                id="tg-token"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={
                  settings?.hasBotToken
                    ? t("settings.withingsCredentialsSavedPlaceholder")
                    : "123456:ABC-DEF..."
                }
                maxLength={100}
                autoComplete="off"
                inputMode="text"
                spellCheck={false}
                autoCapitalize="none"
                enterKeyHint="next"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tg-chatid">{t("settings.chatId")}</Label>
              <Input
                id="tg-chatid"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="123456789"
                maxLength={50}
                autoComplete="off"
                inputMode="text"
                spellCheck={false}
                autoCapitalize="none"
                enterKeyHint="done"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id="tg-enabled"
              checked={settings?.enabled ?? false}
              onCheckedChange={(checked) => toggleEnabled.mutate(checked)}
              disabled={saving || toggleEnabled.isPending}
            />
            <Label htmlFor="tg-enabled" className="cursor-pointer">
              {t("settings.enableNotifications")}
            </Label>
          </div>

          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-xs">
            <p>{t("settings.telegramStep1")}</p>
            <p>{t("settings.telegramStep2")}</p>
            <p>{t("settings.telegramStep3")}</p>
          </div>

          {msg && (
            <p
              role="alert"
              className={`text-sm ${
                msgType === "success" ? "text-success" : "text-destructive"
              }`}
            >
              {msg}
            </p>
          )}

          <div className="flex flex-wrap items-start justify-end gap-2">
            <TestConnectionButton
              endpoint="/api/settings/telegram/test"
              disabled={!settings?.hasBotToken}
            />
            <Button
              type="submit"
              disabled={saving || toggleEnabled.isPending}
              className="min-h-11"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>
    </SettingsCard>
  );
}
