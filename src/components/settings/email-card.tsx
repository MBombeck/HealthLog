"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

interface EmailSettings {
  enabled: boolean;
  recipient: string;
  /** Operator-side: false when SMTP_* env is unset (card hides itself). */
  smtpConfigured: boolean;
}

export function EmailCard({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [recipient, setRecipient] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveMsgType, setSaveMsgType] = useState<"success" | "error" | null>(
    null,
  );

  const { data: settings } = useQuery({
    queryKey: queryKeys.settingsEmail(),
    queryFn: async () => {
      return apiGet<EmailSettings>("/api/settings/email");
    },
    enabled: isAuthenticated,
  });

  // React-recommended sync-from-server pattern (no setState-in-effect).
  const settingsKey = settings ? settings.recipient : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (settingsKey !== null && settingsKey !== seededKey) {
    setSeededKey(settingsKey);
    setRecipient(settings!.recipient);
  }

  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiFetchRaw("/api/settings/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient, enabled }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || t("common.error"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsEmail() });
      setSaveMsg(t("settings.saved"));
      setSaveMsgType("success");
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
    EmailSettings | undefined
  >({
    mutationFn: (enabled) =>
      persistChannelEnabled("/api/settings/email", enabled, t("common.error")),
    onMutate: async (enabled) => {
      const queryKey = queryKeys.settingsEmail();
      await queryClient.cancelQueries({ queryKey });
      setSaveMsg(null);
      setSaveMsgType(null);
      return optimisticallySetChannelEnabled<EmailSettings>(
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
      rollbackChannelEnabled(queryClient, queryKeys.settingsEmail(), previous);
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsEmail() });
    },
  });

  // Operator hasn't configured SMTP — no transport, so no card. The dispatcher
  // skips the channel too; surfacing an unusable toggle would only confuse.
  if (settings && !settings.smtpConfigured) return null;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Mail}
        title={t("settings.email")}
        description={t("settings.emailDescription")}
      />

      <div className="mt-4 space-y-4 pl-7">
        <div className="flex items-center justify-between">
          <Label htmlFor="email-toggle">{t("settings.emailEnable")}</Label>
          <Switch
            id="email-toggle"
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
          <div className="space-y-2">
            <Label htmlFor="email-recipient">
              {t("settings.emailRecipient")}
            </Label>
            <Input
              id="email-recipient"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
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
              endpoint="/api/settings/email/test"
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
