"use client";

/**
 * `<IntegrationsSection>`: Settings → Integrations as two lists.
 *
 * Data sources (where data comes from) and delivery channels (where reminders
 * go), each showing only what is set up: one row per integration with its
 * status chip, as the server resolves it (`GET /api/integrations/overview`).
 * A row opens the integration's sheet, which holds everything the old card
 * held: the setup forms, credentials, sync, test, details, disconnect. "Add"
 * in the page header opens the list of what is not set up yet.
 *
 * The open sheet lives in the query string (`?integration=<key>`, `?add=1`),
 * so the header button, a reload and a shared link all reach it. The anchors
 * older links carry (`#oura`, `#telegram`, a SYNC_STALLED notice's
 * `#<source>`) open that integration's sheet.
 */

import { useEffect, useRef } from "react";
import { Link2, Send, type LucideIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { FitbitRemovalNotice } from "@/components/settings/integrations/fitbit-removal-notice";
import {
  IntegrationAddSheet,
  addableItems,
} from "@/components/settings/integrations/integration-add-sheet";
import { IntegrationListCard } from "@/components/settings/integrations/integration-list";
import { overviewKeyFromHash } from "@/components/settings/integrations/integration-registry";
import { IntegrationSheet } from "@/components/settings/integrations/integration-sheet";
import { openIntegrationsAdd } from "@/components/settings/integrations/integrations-add-button";
import { useOAuthReturnToasts } from "@/components/settings/integrations/oauth-return";
import { useIntegrationOverview } from "@/lib/queries/use-integration-overview";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import type { IntegrationOverviewItem } from "@/lib/integrations/overview";
import { queryKeys } from "@/lib/query-keys";
import { useUrlSearch, writeUrlState } from "@/lib/url-state";

export {
  parseOAuthOutcome,
  oauthReasonKey,
} from "@/components/settings/integrations/oauth-return";

function openIntegration(key: string | null) {
  writeUrlState((params) => {
    params.delete("add");
    if (key) params.set("integration", key);
    else params.delete("integration");
  });
}

export function IntegrationsSection({
  callbackUrls,
}: {
  /** Server-resolved per-provider OAuth callback URLs, read per request. */
  callbackUrls: IntegrationCallbackUrls;
}) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const overview = useIntegrationOverview(isAuthenticated);
  useOAuthReturnToasts();

  const search = useUrlSearch();
  const openKey = search.get("integration");
  const addOpen = search.get("add") === "1";
  const items = overview.data?.items;
  const openItem = items?.find((item) => item.key === openKey) ?? null;

  // An anchor from an older link opens that integration's sheet, once.
  const hashHandled = useRef(false);
  useEffect(() => {
    if (hashHandled.current || !items) return;
    hashHandled.current = true;
    const key = overviewKeyFromHash(window.location.hash, items);
    if (key) openIntegration(key);
  }, [items]);

  function closeSheet() {
    openIntegration(null);
    // A channel saved in the sheet writes outside the status envelope.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.integrationsOverview(),
    });
  }

  const all = items ?? [];
  const pick = (item: IntegrationOverviewItem) => openIntegration(item.key);
  const sources = all.filter((i) => i.group === "source" && i.setUp);
  const channels = all.filter((i) => i.group === "channel" && i.setUp);
  const canAdd = addableItems(all).length > 0;

  const emptyLine = (title: string) => (
    <EmptyState
      variant="plain"
      size="compact"
      title={title}
      action={
        canAdd ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => openIntegrationsAdd(true)}
          >
            {t("common.add")}
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <div className="space-y-6" data-tour-id="integrations-hero">
      {overview.data?.fitbitRemovalNotice === true ? (
        <FitbitRemovalNotice />
      ) : null}

      {overview.isError ? (
        <QueryErrorCard
          error={overview.error}
          onRetry={() => void overview.refetch()}
        />
      ) : !items ? (
        <>
          <ListSkeleton
            icon={Link2}
            title={t("settings.integrationList.sources")}
          />
          <ListSkeleton
            icon={Send}
            title={t("settings.integrationList.channels")}
          />
        </>
      ) : (
        <>
          <IntegrationListCard
            icon={Link2}
            title={t("settings.integrationList.sources")}
            anchor="sources"
            items={sources}
            onOpen={pick}
            empty={emptyLine(t("settings.integrationList.noSources"))}
          />
          <IntegrationListCard
            icon={Send}
            title={t("settings.integrationList.channels")}
            anchor="channels"
            items={channels}
            onOpen={pick}
            empty={emptyLine(t("settings.integrationList.noChannels"))}
          />
        </>
      )}

      {openItem ? (
        <IntegrationSheet
          key={openItem.key}
          item={openItem}
          open
          onOpenChange={(open) => {
            if (!open) closeSheet();
          }}
          callbackUrls={callbackUrls}
        />
      ) : null}
      <IntegrationAddSheet
        items={all}
        open={addOpen}
        onOpenChange={(open) => openIntegrationsAdd(open)}
        onPick={pick}
      />
    </div>
  );
}

function ListSkeleton({ icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <SettingsCard aria-busy="true">
      <SettingsCardHeader icon={icon} title={title} />
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </SettingsCard>
  );
}
