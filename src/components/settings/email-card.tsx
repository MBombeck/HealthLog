"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { isEmailFormDirty } from "@/components/settings/channel-form-dirty";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  channelSaveError,
  useChannelEnabledToggle,
} from "@/components/settings/notification-channel-toggle";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet, throwApiError } from "@/lib/api/api-fetch";

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
  const [saveError, setSaveError] = useState<string | null>(null);

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
  const dirty = isEmailFormDirty({ recipient }, settings);
  // The enable switch saves on tap; the form's Save covers the recipient.
  const toggle = useChannelEnabledToggle<EmailSettings>(
    "/api/settings/email",
    queryKeys.settingsEmail(),
  );

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/settings/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient,
          enabled: settings?.enabled ?? false,
        }),
      });
      if (!res.ok) await throwApiError(res);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settingsEmail() });
      setSaveError(null);
      toastWrittenOutcome("success", t("settings.saved"));
    },
    // A form shows its refusal inline, next to the field it is about.
    onError: (err) => {
      setSaveError(channelSaveError(err, t));
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

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="email-toggle">{t("settings.emailEnable")}</Label>
          <Switch
            id="email-toggle"
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

          {saveError && (
            <p role="alert" className="text-destructive text-sm">
              {saveError}
            </p>
          )}

          <SettingsCardActions>
            <TestConnectionButton
              endpoint="/api/settings/email/test"
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
