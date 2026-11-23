"use client";

import Link from "next/link";
import { Compass } from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

import {
  useDismissServerSetupNotice,
  useServerSetup,
} from "@/lib/queries/use-server-setup";

/**
 * 1.49 — once per admin on the start page: the server setup exists and is not
 * finished. Nothing is forced and nothing redirects; the notice offers the
 * setup and is dismissed under `adminNoticesDismissed`. Never on a demo
 * deploy (the server answers `offered: false` there).
 */
export function ServerSetupNotice() {
  const { t } = useTranslations();
  const { data } = useServerSetup();
  const dismiss = useDismissServerSetupNotice();
  if (!data?.offered || !data.noticePending) return null;
  return (
    <SettingsCard data-slot="server-setup-notice">
      <SettingsCardHeader
        icon={Compass}
        title={t("admin.serverSetup.notice.title")}
      />
      <p className="text-sm">{t("admin.serverSetup.notice.body")}</p>
      <SettingsCardActions align="start">
        <Button asChild variant="outline" size="sm">
          <Link href="/onboarding/server" data-slot="server-setup-notice-open">
            {t("admin.serverSetup.notice.open")}
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
          data-slot="server-setup-notice-dismiss"
        >
          {t("admin.serverSetup.notice.dismiss")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
