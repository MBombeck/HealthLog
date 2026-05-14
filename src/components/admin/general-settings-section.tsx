"use client";

import { useMemo } from "react";
import { Settings } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsToggle, useAdminSettings, useUpdateSettings } from "./_shared";
import { listSupportedTimezones } from "@/lib/tz/format";

const NATIVE_SELECT_CLASS =
  "border-input bg-background text-foreground ring-offset-background focus-visible:ring-ring flex h-9 rounded-md border px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-none";

export function GeneralSettingsSection() {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  // Memoised — `listSupportedTimezones()` calls the engine's
  // `Intl.supportedValuesOf('timeZone')` which returns ~400 strings.
  const zones = useMemo(() => listSupportedTimezones(), []);

  const currentDefaultTz = settings?.defaultUserTimezone ?? "";

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Settings className="text-primary h-5 w-5" />
        <div className="text-lg font-semibold">{t("admin.appSettings")}</div>
      </div>
      <div className="mt-4 space-y-4">
        <SettingsToggle
          label={t("admin.registrationEnabled")}
          description={t("admin.registrationEnabledDescription")}
          checked={settings?.registrationEnabled ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ registrationEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("admin.defaultLanguage")}</p>
            <p className="text-muted-foreground text-xs">
              {t("admin.defaultLanguageDescription")}
            </p>
          </div>
          <select
            value={settings?.defaultLocale ?? "de"}
            onChange={(e) =>
              updateSettings.mutate({ defaultLocale: e.target.value })
            }
            disabled={updateSettings.isPending}
            className={NATIVE_SELECT_CLASS}
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </div>

        {/* v1.4.25 W7 — server-wide default timezone for new
            signups. Existing accounts are NOT touched; this drives
            only the registration handler's fallback when the
            client doesn't send a browser-detected zone. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">
              {t("admin.defaultUserTimezone")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("admin.defaultUserTimezoneDescription")}
            </p>
          </div>
          <select
            value={currentDefaultTz}
            onChange={(e) =>
              updateSettings.mutate({ defaultUserTimezone: e.target.value })
            }
            disabled={updateSettings.isPending}
            className={NATIVE_SELECT_CLASS}
          >
            <option value="">{t("admin.defaultUserTimezoneFallback")}</option>
            {/* Preserve the stored value even if it's not in the
                current engine's IANA list (rare — but defensive). */}
            {currentDefaultTz && !zones.includes(currentDefaultTz) && (
              <option value={currentDefaultTz}>{currentDefaultTz}</option>
            )}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
