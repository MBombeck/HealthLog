"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { NotificationStatusCard } from "@/components/settings/notification-status-card";
import { NtfyCard } from "@/components/settings/ntfy-card";
import { TelegramCard } from "@/components/settings/telegram-card";
import { WebPushCard } from "@/components/settings/web-push-card";

interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
  moodLogGlobal: boolean;
}

export function NotificationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data: globalServices } = useQuery({
    queryKey: ["settings", "global-services"],
    queryFn: async () => {
      const res = await fetch("/api/settings/global-services");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as GlobalServiceAvailability;
    },
    enabled: isAuthenticated,
  });

  const showTelegram = globalServices?.telegramGlobal ?? true;
  const showNtfy = globalServices?.ntfyGlobal ?? true;
  const showWebPush = globalServices?.webPushGlobal ?? true;

  return (
    <section
      aria-labelledby="settings-section-notifications-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-notifications-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.notifications.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.notifications.description")}
        </p>
      </header>

      <NotificationStatusCard />

      {showTelegram && (
        <div id="telegram">
          <TelegramCard isAuthenticated={isAuthenticated} />
        </div>
      )}
      {showNtfy && (
        <div id="ntfy">
          <NtfyCard isAuthenticated={isAuthenticated} />
        </div>
      )}
      {showWebPush && (
        <div id="web-push">
          <WebPushCard />
        </div>
      )}
    </section>
  );
}
