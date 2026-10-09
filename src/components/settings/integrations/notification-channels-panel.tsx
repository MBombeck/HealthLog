"use client";

/**
 * `<NotificationChannelsPanel>` — the delivery-provider half of Settings →
 * Integrations.
 *
 * v1.18.0 (S3) — the notification CHANNELS (Telegram / ntfy / Web Push /
 * Webhook / Email, plus the live per-channel status surface) moved out of
 * Settings → Notifications and into Integrations. Channels are delivery
 * providers — the same conceptual family as Withings / WHOOP / a connected
 * device — not notification preferences. The reminder-TYPE content (which
 * events fire) stays under Settings → Reminders / Notifications.
 *
 * Renders inside the Integrations "Channels" sub-tab. Owns no page header of
 * its own; the parent section supplies it.
 */

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { NotificationStatusCard } from "@/components/settings/notification-status-card";
import { NtfyCard } from "@/components/settings/ntfy-card";
import { TelegramCard } from "@/components/settings/telegram-card";
import { WebPushCard } from "@/components/settings/web-push-card";
import { WebhookCard } from "@/components/settings/webhook-card";
import { EmailCard } from "@/components/settings/email-card";
import { apiGet } from "@/lib/api/api-fetch";

interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
}

export function NotificationChannelsPanel() {
  const { isAuthenticated } = useAuth();

  const { data: globalServices } = useQuery({
    queryKey: queryKeys.settingsGlobalServices(),
    queryFn: async () => {
      return apiGet<GlobalServiceAvailability>("/api/settings/global-services");
    },
    enabled: isAuthenticated,
  });

  const showTelegram = globalServices?.telegramGlobal ?? true;
  const showNtfy = globalServices?.ntfyGlobal ?? true;
  const showWebPush = globalServices?.webPushGlobal ?? true;

  return (
    <div className="space-y-6" data-slot="notification-channels-panel">
      <NotificationStatusCard />

      {/* v1.4.27 MB3 — `scroll-mt-28` keeps each channel card's anchor
          target below the safe-area sticky page header when the user lands
          on `/settings/integrations#telegram` or similar. */}
      {showTelegram && (
        <div id="telegram" className="scroll-mt-28">
          <TelegramCard isAuthenticated={isAuthenticated} />
        </div>
      )}
      {showNtfy && (
        <div id="ntfy" className="scroll-mt-28">
          <NtfyCard isAuthenticated={isAuthenticated} />
        </div>
      )}
      {showWebPush && (
        <div id="web-push" className="scroll-mt-28">
          <WebPushCard />
        </div>
      )}
      {/* v1.17.1 — generic outbound webhook (Discord / Slack / Gotify /
          Home Assistant / n8n in one channel). */}
      <div id="webhook" className="scroll-mt-28">
        <WebhookCard isAuthenticated={isAuthenticated} />
      </div>
      {/* v1.17.1 — SMTP / email. The card hides itself when the operator
          hasn't configured SMTP_* env, so it never shows a dead toggle. */}
      <div id="email" className="scroll-mt-28">
        <EmailCard isAuthenticated={isAuthenticated} />
      </div>
    </div>
  );
}
