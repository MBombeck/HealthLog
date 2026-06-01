"use client";

import { Bell, Globe, Key, MessageCircle, Smile } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsToggle, useAdminSettings, useUpdateSettings } from "./_shared";

export function ServicesSection() {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Globe className="text-primary h-5 w-5" />
        <div className="text-lg font-semibold">{t("admin.servicesGlobal")}</div>
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
          label="moodLog"
          description={t("admin.moodLogGlobal")}
          icon={Smile}
          checked={settings?.moodLogGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ moodLogGlobal: checked })
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
