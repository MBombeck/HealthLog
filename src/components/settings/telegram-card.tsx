"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2, MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { isTelegramFormDirty } from "@/components/settings/channel-form-dirty";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useChannelEnabledToggle } from "@/components/settings/notification-channel-toggle";
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
  const [error, setError] = useState<string | null>(null);

  const { data: settings } = useQuery({
    queryKey: queryKeys.telegramSettings(),
    queryFn: async () => {
      return apiGet<TelegramSettings>("/api/settings/telegram");
    },
    enabled: isAuthenticated,
  });

  // Sync from server using the React-recommended "previous-payload-id"
  // pattern instead of setState-in-effect.
  const settingsKey = settings ? (settings.chatId ?? "") : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (settingsKey && settingsKey !== seededKey) {
    setSeededKey(settingsKey);
    if (settings!.chatId) setChatId(settings!.chatId);
  }
  const dirty = isTelegramFormDirty({ botToken, chatId }, settings);
  // The enable switch saves on tap; the form's Save covers token and chat.
  const toggle = useChannelEnabledToggle<TelegramSettings>(
    "/api/settings/telegram",
    queryKeys.telegramSettings(),
  );

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = {
      enabled: settings?.enabled ?? false,
    };
    if (botToken.trim()) body.botToken = botToken.trim();
    if (chatId !== (settings?.chatId ?? "")) body.chatId = chatId;

    try {
      // A request that never reaches the server (offline, a dropped
      // connection) is a failed save like any other, not a stuck one.
      const res = await apiFetchRaw("/api/settings/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);

      if (res?.ok) {
        toastWrittenOutcome("success", t("settings.saved"));
        setBotToken("");
        queryClient.invalidateQueries({ queryKey: queryKeys.telegram() });
      } else {
        const json = (await res?.json().catch(() => null)) as {
          error?: string;
        } | null;
        // A form shows its refusal inline, next to the fields it is about.
        setError(json?.error || t("settings.savingError"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={MessageCircle}
        title={t("settings.telegram")}
        description={t("settings.telegramDescription")}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="tg-enabled">
            {t("settings.enableNotifications")}
          </Label>
          <Switch
            id="tg-enabled"
            checked={settings?.enabled ?? false}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={!settings || saving || toggle.isPending}
          />
        </div>

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

          <SettingsInfoTile icon={Info} tone="neutral">
            <ol className="list-decimal space-y-1 pl-4">
              <li>{t("settings.telegramStep1")}</li>
              <li>{t("settings.telegramStep2")}</li>
              <li>{t("settings.telegramStep3")}</li>
            </ol>
          </SettingsInfoTile>

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}

          <SettingsCardActions>
            <TestConnectionButton
              endpoint="/api/settings/telegram/test"
              disabled={!settings?.hasBotToken}
              unsavedChanges={dirty}
            />
            <Button
              size="sm"
              type="submit"
              disabled={saving || toggle.isPending}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("common.save")}
            </Button>
          </SettingsCardActions>
        </form>
      </div>
    </SettingsCard>
  );
}
