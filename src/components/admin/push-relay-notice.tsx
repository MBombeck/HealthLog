"use client";

import Link from "next/link";
import { Send } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  useDismissPushRelayNotice,
  usePushRelayStatus,
} from "./use-push-relay";

/**
 * The one-time notice on the admin start page that the push relay exists:
 * what it is, what it sees, where to read more. Shown until this admin
 * dismisses it, never again after that, and never while the relay is
 * switched off for the whole server (`PUSH_RELAY_MODE=off`).
 */
export function PushRelayNotice() {
  const { t } = useTranslations();
  const { data: status } = usePushRelayStatus();
  const dismiss = useDismissPushRelayNotice();
  if (!status?.noticePending) return null;
  return (
    <SettingsCard data-slot="push-relay-notice">
      <SettingsCardHeader
        icon={Send}
        title={t("admin.pushRelay.notice.title")}
      />
      <p className="text-sm">{t("admin.pushRelay.notice.body")}</p>
      {/* Open and dismiss weigh the same: the notice informs, it does not
          steer the admin towards either answer. */}
      <SettingsCardActions align="start">
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/services">{t("admin.pushRelay.notice.open")}</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={status.docsUrl} target="_blank" rel="noreferrer">
            {t("admin.pushRelay.docs")}
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          {t("admin.pushRelay.notice.dismiss")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
