"use client";

import { Compass, Send } from "lucide-react";

import { DecisionCard } from "@/components/settings/decision-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

import {
  useDismissServerSetupNotice,
  useServerSetup,
} from "@/lib/queries/use-server-setup";

/**
 * The one notice to an admin about the server itself, dismissed once per
 * admin under `adminNoticesDismissed`. Nothing is forced and nothing
 * redirects. Never on a demo deploy (the server answers `offered: false`).
 *
 * It says one of two things, the first that holds:
 *
 * - the server setup exists and is not finished: it offers the setup;
 * - the push relay is still undecided: it names the question, which waits on
 *   the admin start page, and links there. An upgraded server has its setup
 *   stamped finished, so without this an admin who never opens the admin
 *   pages would never hear of the relay.
 *
 * On the admin start page (`surface="admin"`) only the first shows: the
 * relay question itself stands right under it. The same `DecisionCard` as the
 * relay question: the way forward is the primary answer, "Not now" the
 * secondary one.
 */
export function ServerSetupNotice({
  surface,
}: {
  surface: "admin" | "dashboard";
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  // Admin-only route: never asked for anyone else.
  const { data } = useServerSetup({ enabled: isAdmin });
  const dismiss = useDismissServerSetupNotice();
  if (!isAdmin || !data?.offered || !data.noticePending) return null;

  const decline = {
    label: t("admin.serverSetup.notice.dismiss"),
    slot: "server-setup-notice-dismiss",
    onClick: () => dismiss.mutate(),
  };

  if (data.completedAt === null) {
    return (
      <DecisionCard
        data-slot="server-setup-notice"
        data-notice="setup"
        icon={Compass}
        title={t("admin.serverSetup.notice.title")}
        body={t("admin.serverSetup.notice.body")}
        pending={dismiss.isPending}
        decline={decline}
        accept={{
          label: t("admin.serverSetup.notice.open"),
          slot: "server-setup-notice-open",
          href: "/onboarding/server",
        }}
      />
    );
  }

  const relay = user?.push?.relay;
  if (
    surface !== "dashboard" ||
    relay?.canDecide !== true ||
    relay.operatorDecision !== "undecided"
  ) {
    return null;
  }
  return (
    <DecisionCard
      data-slot="server-setup-notice"
      data-notice="relay"
      icon={Send}
      title={t("admin.pushRelay.question.title")}
      body={t("admin.serverSetup.notice.relayBody")}
      pending={dismiss.isPending}
      decline={decline}
      accept={{
        label: t("admin.serverSetup.notice.relayOpen"),
        slot: "server-setup-notice-open",
        href: "/admin",
      }}
    />
  );
}
