"use client";

import { Bell, Globe, Key, MessageCircle } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsToggle, useAdminSettings, useUpdateSettings } from "./_shared";

export function ServicesSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Globe className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("admin.servicesGlobal")}</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("admin.servicesGlobalDescription")}
      </p>
      <div className="mt-4 space-y-3">
        <SettingsToggle
          label="Telegram"
          description={t("admin.telegramGlobal")}
          icon={MessageCircle}
          checked={settings?.telegramGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ telegramGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
        <SettingsToggle
          label="ntfy"
          description={t("admin.ntfyGlobal")}
          icon={Bell}
          checked={settings?.ntfyGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ ntfyGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
        <SettingsToggle
          label={t("admin.integrationWebPush")}
          description={t("admin.webPushGlobal")}
          icon={Globe}
          checked={settings?.webPushGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ webPushGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
        <SettingsToggle
          label="API"
          description={t("admin.apiGlobal")}
          icon={Key}
          checked={settings?.apiGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ apiGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
      </div>
    </div>
  );
}
