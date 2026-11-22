import { useState } from "react";

import { SwitchRow } from "@/components/ui/switch-row";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { accountLabel } from "@/lib/sharing/account-access-view";

import type { SettingsFormProps } from "./form-kit";

/**
 * #1403 — the managed profile's own "read documents automatically with AI"
 * switch. The trade is spelled out above the switch rather than behind a
 * confirm, because flipping it is the explicit step here.
 *
 * The same shape as the owner's card: one switch that saves when flipped, no
 * separate Save. With no provider that could read the profile's documents (or
 * AI off for the record or the server), turning it on would record a consent
 * that reads nothing, so the switch is disabled and says why. Turning an
 * already-on switch off always stays possible.
 */
export function DocumentsSettingsForm({
  settings,
  disabled,
  onSave,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const active = user?.accountAccess?.active ?? null;
  const name = active ? accountLabel(active) : "";
  const documentAi = useAiCapability("documentAi");
  // Show the requested position while the save is in flight, and the saved
  // one otherwise, so a refused save springs back instead of lying.
  const [requested, setRequested] = useState<boolean | null>(null);
  const saved = settings.autoAiRead === true;
  const on = disabled && requested !== null ? requested : saved;

  // `consent_required` is the one refusal this switch itself resolves:
  // switching it on records that consent.
  const blocked =
    !documentAi.available && documentAi.reason !== "consent_required";
  const blockedCopy = !blocked
    ? null
    : documentAi.reason === "operator_disabled"
      ? t("settings.ai.operatorOff.autoRead")
      : documentAi.reason === "no_provider"
        ? t("settings.sharedRecord.managedSettings.documents.noProvider", {
            name,
          })
        : t("settings.sharedRecord.managedSettings.documents.aiOff", { name });

  function flip(next: boolean) {
    setRequested(next);
    onSave({ autoAiRead: next });
  }

  const label = t("settings.sharedRecord.managedSettings.documents.autoAiRead");
  return (
    <div className="space-y-4">
      <p className="text-foreground text-sm">
        {t("settings.sharedRecord.managedSettings.documents.honesty")}
      </p>
      <SwitchRow
        id="managed-switch-autoAiRead"
        label={label}
        checked={on}
        onCheckedChange={flip}
        disabled={disabled || (blocked && !on)}
        data-slot="managed-documents-auto-read"
      >
        {blockedCopy ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="managed-documents-auto-read-blocked"
          >
            {blockedCopy}
          </p>
        ) : null}
      </SwitchRow>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
