"use client";

import { Compass } from "lucide-react";

import { DecisionCard } from "@/components/settings/decision-card";
import { useTranslations } from "@/lib/i18n/context";

import {
  useDismissServerSetupNotice,
  useServerSetup,
} from "@/lib/queries/use-server-setup";

/**
 * 1.49 — once per admin on the start page: the server setup exists and is not
 * finished. Nothing is forced and nothing redirects; the notice offers the
 * setup and is dismissed under `adminNoticesDismissed`. Never on a demo
 * deploy (the server answers `offered: false` there). The same
 * `DecisionCard` as the relay question: the setup is the primary answer,
 * "Not now" the secondary one.
 */
export function ServerSetupNotice() {
  const { t } = useTranslations();
  const { data } = useServerSetup();
  const dismiss = useDismissServerSetupNotice();
  if (!data?.offered || !data.noticePending) return null;
  return (
    <DecisionCard
      data-slot="server-setup-notice"
      icon={Compass}
      title={t("admin.serverSetup.notice.title")}
      body={t("admin.serverSetup.notice.body")}
      pending={dismiss.isPending}
      decline={{
        label: t("admin.serverSetup.notice.dismiss"),
        slot: "server-setup-notice-dismiss",
        onClick: () => dismiss.mutate(),
      }}
      accept={{
        label: t("admin.serverSetup.notice.open"),
        slot: "server-setup-notice-open",
        href: "/onboarding/server",
      }}
    />
  );
}
