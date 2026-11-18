"use client";

/**
 * The bring-your-own OAuth app credentials form, one copy for every provider
 * that takes a client id and secret (Withings, WHOOP, Google Health,
 * Polar, Oura, Strava). It sits in the not-connected card before "Connect",
 * and behind "Change credentials" in the menu once connected.
 *
 * Config fields, so no password manager is offered them (`autoComplete="off"`
 * on both, the secret through `PasswordInput`).
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export function CredentialsForm({
  provider,
  i18nPrefix,
  saved,
  secretPlaceholder,
  statusQueryKey,
}: {
  /** Route segment: PUT `/api/<provider>/credentials`; also the field ids. */
  provider: string;
  /** i18n base, e.g. `settings.withings`. */
  i18nPrefix: string;
  /** A pair is stored already: the fields show the saved placeholder. */
  saved: boolean;
  /**
   * The provider ships a secret-specific saved placeholder
   * (`…CredentialsSavedPlaceholderSecret`); the others reuse the id's.
   */
  secretPlaceholder: boolean;
  statusQueryKey: readonly unknown[];
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetchRaw(`/api/${provider}/credentials`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });
      if (res.ok) {
        setMsg({ kind: "success", text: t(`${i18nPrefix}CredentialsSaved`) });
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: statusQueryKey });
        // The cards read the consolidated envelope; repaint it as well.
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        let text = t("settings.savingError");
        try {
          const json = await res.json();
          if (json.error) text = json.error;
        } catch {
          // keep the generic message
        }
        setMsg({ kind: "error", text });
      }
    } catch {
      setMsg({ kind: "error", text: t("common.networkError") });
    }
    setSaving(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3"
      data-testid={`${provider}-credentials`}
    >
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t(`${i18nPrefix}Credentials`)}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${provider}-clientid`}>
            {t(`${i18nPrefix}ClientId`)}
          </Label>
          <Input
            id={`${provider}-clientid`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={
              saved
                ? t(`${i18nPrefix}CredentialsSavedPlaceholder`)
                : t(`${i18nPrefix}ClientId`)
            }
            maxLength={200}
            autoComplete="off"
            inputMode="text"
            spellCheck={false}
            autoCapitalize="none"
            enterKeyHint="next"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${provider}-secret`}>
            {t(`${i18nPrefix}ClientSecret`)}
          </Label>
          <PasswordInput
            id={`${provider}-secret`}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={
              !saved
                ? t(`${i18nPrefix}ClientSecret`)
                : secretPlaceholder
                  ? t(`${i18nPrefix}CredentialsSavedPlaceholderSecret`)
                  : t(`${i18nPrefix}CredentialsSavedPlaceholder`)
            }
            maxLength={200}
            autoComplete="off"
            inputMode="text"
            spellCheck={false}
            autoCapitalize="none"
            enterKeyHint="done"
          />
        </div>
      </div>
      {msg && (
        <p
          role={msg.kind === "error" ? "alert" : "status"}
          className={`text-sm ${msg.kind === "success" ? "text-success" : "text-destructive"}`}
        >
          {msg.text}
        </p>
      )}
      <SettingsCardActions>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="min-h-11 w-full sm:min-h-9 sm:w-auto"
          disabled={saving || !clientId.trim() || !clientSecret.trim()}
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="size-3.5" aria-hidden="true" />
          )}
          {t(`${i18nPrefix}SaveCredentials`)}
        </Button>
      </SettingsCardActions>
    </form>
  );
}
