"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, Save, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";

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
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["telegram", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings/telegram");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as TelegramSettings;
    },
    enabled: isAuthenticated,
  });

  // Sync from server using the React-recommended "previous-payload-id"
  // pattern instead of setState-in-effect. This avoids the strict
  // `react-hooks/set-state-in-effect` lint failure that the legacy file
  // disabled at module scope.
  const settingsKey = settings
    ? `${settings.enabled}|${settings.chatId ?? ""}`
    : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (settingsKey && settingsKey !== seededKey) {
    setSeededKey(settingsKey);
    setEnabled(settings!.enabled);
    if (settings!.chatId) setChatId(settings!.chatId);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setMsgType(null);

    const body: Record<string, unknown> = { enabled };
    if (botToken.trim()) body.botToken = botToken.trim();
    if (chatId !== (settings?.chatId ?? "")) body.chatId = chatId;

    const res = await fetch("/api/settings/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setMsg(t("settings.telegramSaved"));
      setMsgType("success");
      setBotToken("");
      queryClient.invalidateQueries({ queryKey: ["telegram"] });
    } else {
      const json = await res.json();
      setMsg(json.error || t("settings.savingError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setMsg(null);
    setMsgType(null);

    const res = await fetch("/api/settings/telegram/test", { method: "POST" });
    if (res.ok) {
      setMsg(t("settings.testSent"));
      setMsgType("success");
    } else {
      const json = await res.json();
      setMsg(json.error || t("common.error"));
      setMsgType("error");
    }
    setTesting(false);
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <SettingsCardHeader
        icon={MessageCircle}
        title={t("settings.telegram")}
        description={t("settings.telegramDescription")}
      />

      <div className="mt-4 space-y-4">
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
              checked={enabled}
              onCheckedChange={setEnabled}
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
                msgType === "success"
                  ? "text-dracula-green"
                  : "text-destructive"
              }`}
            >
              {msg}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={testing || !settings?.hasBotToken}
              onClick={handleTest}
            >
              {testing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {t("settings.testMessage")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
