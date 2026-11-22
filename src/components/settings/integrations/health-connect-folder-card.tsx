"use client";

// The Health Connect export fetched from a WebDAV or Nextcloud folder, as one
// more connection beside the others. It is set up and changed on the folder
// card right below it (Settings → Integrations); this one shows the shared
// health, so a fetch that keeps failing (a revoked app password) is seen where
// every other connection's trouble is seen. Shown only while a folder is set
// up.

import { CloudDownload, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { HealthConnectRemoteCard } from "@/components/settings/import-panel/health-connect-remote-card";
import { useTranslations } from "@/lib/i18n/context";

import { IntegrationCard } from "./integration-card";
import type { IntegrationStatusViewModel } from "./shared";

/** Where the folder is managed. */
export const HEALTH_CONNECT_FOLDER_HREF =
  "/settings/integrations#import-health-connect-remote";

export function HealthConnectFolderCard({
  viewModel,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  const { t } = useTranslations();
  const router = useRouter();
  const open = () => router.push(HEALTH_CONNECT_FOLDER_HREF);
  return (
    <IntegrationCard
      provider="health-connect-remote"
      providerName={t("settings.healthConnectFolder.name")}
      icon={CloudDownload}
      description={t("settings.healthConnectFolder.description")}
      connected={viewModel?.connected === true}
      health={viewModel?.health ?? null}
      primary={{ onReconnect: open, onResume: open }}
      menu={[
        {
          id: "manage",
          label: t("settings.healthConnectFolder.manage"),
          icon: Settings2,
          href: HEALTH_CONNECT_FOLDER_HREF,
        },
      ]}
      testId="integration-card-health-connect-remote"
    />
  );
}

/**
 * The folder as it sits under Integrations: a connection like the others, so
 * it is set up here, with the form always present and, once a folder is set
 * up, its health in the shared card above it.
 */
export function HealthConnectFolder({
  viewModel,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  return (
    <div id="health-connect-remote" className="scroll-mt-28 space-y-4">
      {viewModel?.configured ? (
        <HealthConnectFolderCard viewModel={viewModel} />
      ) : null}
      <HealthConnectRemoteCard />
    </div>
  );
}
