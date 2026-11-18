import type { FormEvent } from "react";

import { useTranslations } from "@/lib/i18n/context";

import {
  FormFooter,
  ManagedSwitchRow,
  type SettingsFormProps,
} from "./form-kit";

/**
 * #1403 — the managed profile's own "read documents automatically with AI"
 * switch. The trade is spelled out above the switch rather than behind a
 * confirm, because the save is already its own explicit step here.
 */
export function DocumentsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({ autoAiRead: form.get("autoAiRead") === "on" });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-muted-foreground text-sm">
        {t("settings.sharedRecord.managedSettings.documents.honesty")}
      </p>
      <ManagedSwitchRow
        name="autoAiRead"
        label={t("settings.sharedRecord.managedSettings.documents.autoAiRead")}
        defaultChecked={settings.autoAiRead === true}
        disabled={disabled}
      />
      <FormFooter disabled={disabled} label={saveLabel} error={error} />
    </form>
  );
}
