"use client";

import { Compass } from "lucide-react";

import { DecisionCard } from "@/components/settings/decision-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

import {
  useDismissServerSetupNotice,
  useServerSetup,
} from "@/lib/queries/use-server-setup";

/**
 * The one notice to an admin about the server itself, on the admin start
 * page, dismissed once per admin under `adminNoticesDismissed`: the server
 * setup exists and is not finished, so it offers the setup. Nothing is
 * forced and nothing redirects. Never on a demo deploy (the server answers
 * `offered: false`). The relay question stands right under it on that page.
 *
 * The dashboard asks the same question in its ask card (the digest's
 * `asks`, kind `server_setup` or `push_relay`), with the same answers and
 * the same "Not now".
 */
export function ServerSetupNotice() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  // Admin-only route: never asked for anyone else.
  const { data } = useServerSetup({ enabled: isAdmin });
  const dismiss = useDismissServerSetupNotice();
  if (!isAdmin || !data?.offered || !data.noticePending) return null;
  if (data.completedAt !== null) return null;

  return (
    <DecisionCard
      data-slot="server-setup-notice"
      data-notice="setup"
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
