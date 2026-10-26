import type { FormEvent } from "react";

import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";

import {
  asNumber,
  asRecord,
  FormFooter,
  formNumber,
  ManagedSwitchRow,
  type SettingsFormProps,
} from "./form-kit";

export function NotificationsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const preferences = asRecord(settings.notificationPreferences);
  const medication = asRecord(preferences.medication);
  const mood = asRecord(preferences.mood);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      moodReminderEnabled: form.get("moodReminderEnabled") === "on",
      notificationPreferences: {
        medication: {
          lowStockRunwayDays:
            form.get("lowStockRunwayDays") === ""
              ? null
              : formNumber(form, "lowStockRunwayDays", 7),
          reorderLeadDays: formNumber(form, "reorderLeadDays", 10),
        },
        mood: { reminderHour: formNumber(form, "reminderHour", 22) },
      },
    });
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <ManagedSwitchRow
        name="moodReminderEnabled"
        label={t(
          "settings.sharedRecord.managedSettings.notifications.moodReminder",
        )}
        defaultChecked={settings.moodReminderEnabled === true}
        disabled={disabled}
        className="flex items-center justify-between gap-3 text-sm sm:col-span-2"
      />
      <label className="grid gap-1 text-sm" htmlFor="managed-reminder-hour">
        {t("settings.sharedRecord.managedSettings.notifications.reminderHour")}
        <Input
          defaultValue={asNumber(mood.reminderHour, 22)}
          disabled={disabled}
          id="managed-reminder-hour"
          max="23"
          min="0"
          name="reminderHour"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-low-stock">
        {t(
          "settings.sharedRecord.managedSettings.notifications.lowStockRunwayDays",
        )}
        <Input
          defaultValue={
            medication.lowStockRunwayDays === null
              ? ""
              : asNumber(medication.lowStockRunwayDays, 7)
          }
          disabled={disabled}
          id="managed-low-stock"
          max="60"
          min="1"
          name="lowStockRunwayDays"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-reorder-lead">
        {t(
          "settings.sharedRecord.managedSettings.notifications.reorderLeadDays",
        )}
        <Input
          defaultValue={asNumber(medication.reorderLeadDays, 10)}
          disabled={disabled}
          id="managed-reorder-lead"
          max="60"
          min="0"
          name="reorderLeadDays"
          type="number"
        />
      </label>
      <FormFooter
        disabled={disabled}
        label={saveLabel}
        error={error}
        span="sm:col-span-2"
      />
    </form>
  );
}
