"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsToggle, useAdminSettings, useUpdateSettings } from "./_shared";

export function GeneralSettingsSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Settings className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("admin.appSettings")}</h2>
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
            className="border-input bg-background text-foreground ring-offset-background focus-visible:ring-ring flex h-9 rounded-md border px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
    </div>
  );
}
