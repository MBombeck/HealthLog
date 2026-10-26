import type { FormEvent } from "react";

import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { locales } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import { asString, FormFooter, type SettingsFormProps } from "./form-kit";

export function ProfileSettingsForm({
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
    const displayName = asString(form.get("displayName")).trim();
    const heightValue = asString(form.get("heightCm")).trim();
    onSave({
      displayName: displayName || null,
      heightCm: heightValue === "" ? null : Number(heightValue),
      dateOfBirth: asString(form.get("dateOfBirth")) || null,
      gender: asString(form.get("gender")) || null,
      locale: asString(form.get("locale")) || null,
      timezone: asString(form.get("timezone")),
      unitPreference: asString(form.get("unitPreference")),
      timeFormat: asString(form.get("timeFormat")),
      dateFormat: asString(form.get("dateFormat")),
    });
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className="grid gap-1 text-sm" htmlFor="managed-display-name">
        {t("settings.sharedRecord.managedSettings.profile.displayName")}
        <Input
          defaultValue={asString(settings.displayName)}
          disabled={disabled}
          id="managed-display-name"
          name="displayName"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-height">
        {t("settings.sharedRecord.managedSettings.profile.height")}
        <Input
          defaultValue={
            settings.heightCm === null ? "" : String(settings.heightCm ?? "")
          }
          disabled={disabled}
          id="managed-height"
          max="300"
          min="30"
          name="heightCm"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-date-of-birth">
        {t("settings.sharedRecord.managedSettings.profile.dateOfBirth")}
        {/* The profile date must not depend on the browser's date
            parsing; DateField displays in the user's order and submits ISO
            through its hidden mirror. */}
        <DateField
          defaultValue={asString(settings.dateOfBirth)}
          disabled={disabled}
          id="managed-date-of-birth"
          name="dateOfBirth"
          autoComplete="bday"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-gender">
        {t("settings.sharedRecord.managedSettings.profile.gender")}
        <NativeSelect
          defaultValue={asString(settings.gender)}
          disabled={disabled}
          id="managed-gender"
          name="gender"
        >
          <option value="">
            {t("settings.sharedRecord.managedSettings.profile.notSpecified")}
          </option>
          <option value="MALE">
            {t("settings.sharedRecord.managedSettings.profile.male")}
          </option>
          <option value="FEMALE">
            {t("settings.sharedRecord.managedSettings.profile.female")}
          </option>
          <option value="OTHER">
            {t("settings.sharedRecord.managedSettings.profile.other")}
          </option>
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-locale">
        {t("settings.sharedRecord.managedSettings.profile.locale")}
        <NativeSelect
          defaultValue={asString(settings.locale)}
          disabled={disabled}
          id="managed-locale"
          name="locale"
        >
          <option value="">
            {t("settings.sharedRecord.managedSettings.profile.systemDefault")}
          </option>
          {locales.map((locale) => (
            <option key={locale} value={locale}>
              {locale}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-timezone">
        {t("settings.sharedRecord.managedSettings.profile.timezone")}
        <Input
          defaultValue={asString(settings.timezone, DEFAULT_TIMEZONE)}
          disabled={disabled}
          id="managed-timezone"
          name="timezone"
          required
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-units">
        {t("settings.sharedRecord.managedSettings.profile.units")}
        <NativeSelect
          defaultValue={asString(settings.unitPreference, "metric")}
          disabled={disabled}
          id="managed-units"
          name="unitPreference"
        >
          <option value="metric">
            {t("settings.sharedRecord.managedSettings.profile.metric")}
          </option>
          <option value="imperial">
            {t("settings.sharedRecord.managedSettings.profile.imperial")}
          </option>
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-time-format">
        {t("settings.sharedRecord.managedSettings.profile.timeFormat")}
        <NativeSelect
          defaultValue={asString(settings.timeFormat, "AUTO")}
          disabled={disabled}
          id="managed-time-format"
          name="timeFormat"
        >
          <option value="AUTO">
            {t("settings.sharedRecord.managedSettings.profile.automatic")}
          </option>
          <option value="H12">
            {t("settings.sharedRecord.managedSettings.profile.hour12")}
          </option>
          <option value="H24">
            {t("settings.sharedRecord.managedSettings.profile.hour24")}
          </option>
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-date-format">
        {t("settings.sharedRecord.managedSettings.profile.dateFormat")}
        <NativeSelect
          defaultValue={asString(settings.dateFormat, "AUTO")}
          disabled={disabled}
          id="managed-date-format"
          name="dateFormat"
        >
          <option value="AUTO">
            {t("settings.sharedRecord.managedSettings.profile.automatic")}
          </option>
          <option value="DMY">
            {t("settings.sharedRecord.managedSettings.profile.dateDmy")}
          </option>
          <option value="MDY">
            {t("settings.sharedRecord.managedSettings.profile.dateMdy")}
          </option>
          <option value="YMD">
            {t("settings.sharedRecord.managedSettings.profile.dateYmd")}
          </option>
        </NativeSelect>
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
