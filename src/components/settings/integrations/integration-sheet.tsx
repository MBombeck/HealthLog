"use client";

/**
 * One integration as a sheet: what the list row opens, and what an entry in
 * the "Add" sheet opens.
 *
 * Top: the facts as rows (status, reason, last sync, what it brings), all from
 * the server overview. Below: the integration's own controller, the same
 * component that used to be its card, rendered flat into the sheet, so every
 * setup form, credential field, sync and test keeps working exactly as
 * before. The controller's action pair lands at the foot of the body and its
 * rare actions (Disconnect among them) in the ⋯ menu beside the title.
 */
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCw, Send } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { EmailCard } from "@/components/settings/email-card";
import { HealthConnectRemoteCard } from "@/components/settings/import-panel/health-connect-remote-card";
import { NtfyCard } from "@/components/settings/ntfy-card";
import { NutrientIntakeCard } from "@/components/settings/nutrient-intake-card";
import {
  IntegrationSheetSlotsContext,
  SheetCardContext,
  useIntegrationSheetSlots,
} from "@/components/settings/sheet-surface";
import { TelegramCard } from "@/components/settings/telegram-card";
import { runConnectionTest } from "@/components/settings/test-connection-button";
import { WebPushCard } from "@/components/settings/web-push-card";
import { WebhookCard } from "@/components/settings/webhook-card";
import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { StatusChip } from "@/components/ui/status-chip";
import { useAuth } from "@/hooks/use-auth";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { CONFIRMS_INLINE } from "@/lib/api/mutation-feedback";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { translateCode } from "@/lib/i18n/translate-code";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import {
  CHANNEL_KEY_TYPE,
  type IntegrationOverviewItem,
  type OverviewChannelKey,
} from "@/lib/integrations/overview";
import { queryKeys } from "@/lib/query-keys";

import { AppleHealthCard } from "./apple-health-card";
import { DawarichCard } from "./dawarich-card";
import { DocumentSourcesCard } from "./document-sources-card";
import { GarminCard } from "./garmin-card";
import { GoogleHealthCard } from "./google-health-card";
import { IntegrationCard } from "./integration-card";
import { IntegrationFallbackRow } from "./integration-fallback-row";
import { formatHealthInstant } from "./integration-health-copy";
import {
  INTEGRATION_BRINGS_KEY,
  INTEGRATION_ICON,
  INTEGRATION_NAME_KEY,
  INTEGRATION_REASON_KEY,
} from "./integration-registry";
import { NightscoutCard } from "./nightscout-card";
import {
  OAUTH_INTEGRATIONS,
  OAuthIntegrationCard,
} from "./oauth-integration-card";
import { pickStatus, useIntegrationStatuses } from "./shared";

export function IntegrationSheet({
  item,
  open,
  onOpenChange,
  callbackUrls,
}: {
  item: IntegrationOverviewItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callbackUrls: IntegrationCallbackUrls;
}) {
  const { t } = useTranslations();
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLSpanElement | null>(null);
  const name = t(INTEGRATION_NAME_KEY[item.key]);

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={name}
      headerAction={<span ref={setMenuEl} className="contents" />}
      contentWidth="lg"
    >
      <div
        className="flex flex-col gap-4"
        data-slot="integration-sheet"
        data-integration={item.key}
      >
        <IntegrationFacts item={item} />
        <IntegrationSheetSlotsContext.Provider
          value={{ actions: actionsEl, menu: menuEl }}
        >
          <SheetCardContext.Provider value="hide-header">
            <IntegrationController item={item} callbackUrls={callbackUrls} />
          </SheetCardContext.Provider>
        </IntegrationSheetSlotsContext.Provider>
        {/* The card's actions land here through a portal; the rule above
            them shows only once there is one. */}
        <div className="border-t pt-4 has-[>[data-slot=integration-sheet-actions]:empty]:hidden">
          <SettingsCardActions
            ref={setActionsEl}
            data-slot="integration-sheet-actions"
          />
        </div>
      </div>
    </ResponsiveSheet>
  );
}

/** The facts as rows: status, reason, last sync, what it brings. */
function IntegrationFacts({ item }: { item: IntegrationOverviewItem }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const channel = item.group === "channel";
  const showReason =
    item.reason !== null &&
    item.reason !== "data_arriving" &&
    item.reason !== "first_sync_pending";
  return (
    <dl className="-mt-1 divide-y border-b" data-slot="integration-facts">
      {item.status ? (
        <FactRow label={t("settings.integrationList.facts.status")}>
          <StatusChip tone={item.status} />
        </FactRow>
      ) : null}
      {showReason && item.reason ? (
        <FactRow label={t("settings.integrationList.facts.reason")}>
          {t(INTEGRATION_REASON_KEY[item.reason])}
        </FactRow>
      ) : null}
      {item.setUp ? (
        <FactRow
          label={
            channel
              ? t("settings.integrationList.facts.lastDelivery")
              : t("settings.integrationList.facts.lastSync")
          }
        >
          {item.lastAt
            ? formatHealthInstant(item.lastAt, t, fmt)
            : t("settings.integrationList.never")}
        </FactRow>
      ) : null}
      {item.group === "channel" && item.setUp ? (
        <ChannelFailureRow channelKey={item.key as OverviewChannelKey} />
      ) : null}
      {item.setupNote === "own_credentials" ? (
        <FactRow label={t("settings.integrationList.facts.setup")}>
          {t("settings.integrationList.ownCredentials")}
        </FactRow>
      ) : null}
      {/* Not set up yet, the card's own first line says what it brings. */}
      {item.setUp ? (
        <FactRow
          label={
            channel
              ? t("settings.integrationList.facts.delivers")
              : t("settings.integrationList.facts.brings")
          }
        >
          {t(INTEGRATION_BRINGS_KEY[item.key])}
        </FactRow>
      ) : null}
    </dl>
  );
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-13 items-center justify-between gap-4 py-2">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-muted-foreground min-w-0 text-right text-sm">
        {children}
      </dd>
    </div>
  );
}

interface ChannelStatusRow {
  id: string;
  type: string;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}

function useChannelStatusRow(channelKey: OverviewChannelKey) {
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.notificationsStatus(),
    queryFn: async () => {
      const body = await apiGet<{ channels: ChannelStatusRow[] }>(
        "/api/notifications/status",
      );
      return body.channels;
    },
    enabled: isAuthenticated,
  });
  const rows = Array.isArray(query.data) ? query.data : [];
  return {
    query,
    row: rows.find((row) => row.type === CHANNEL_KEY_TYPE[channelKey]) ?? null,
  };
}

/** The latest failed send of a channel, as the dispatcher recorded it. */
function ChannelFailureRow({ channelKey }: { channelKey: OverviewChannelKey }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { query, row } = useChannelStatusRow(channelKey);
  if (query.isError) {
    return (
      <QueryErrorRow
        inset
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!row?.lastFailureAt) return null;
  return (
    <FactRow label={t("settings.integrationList.facts.lastFailure")}>
      {row.lastFailureReason
        ? t("settings.integrationList.facts.lastFailureWith", {
            when: formatHealthInstant(row.lastFailureAt, t, fmt),
            reason: row.lastFailureReason,
          })
        : formatHealthInstant(row.lastFailureAt, t, fmt)}
    </FactRow>
  );
}

const CHANNEL_TEST_ENDPOINT: Partial<Record<OverviewChannelKey, string>> = {
  apns: "/api/notifications/apns/test",
};

/**
 * A channel's own pair: switch it back on after the dispatcher switched it
 * off, and, for the iPhone app's channel (which has no card), send a test.
 */
function ChannelSheetActions({
  channelKey,
  autoDisabled,
}: {
  channelKey: OverviewChannelKey;
  /** The server's reason says the dispatcher switched the channel off. */
  autoDisabled: boolean;
}) {
  const { t } = useTranslations();
  const slots = useIntegrationSheetSlots()?.actions ?? null;
  const queryClient = useQueryClient();
  const { row } = useChannelStatusRow(channelKey);
  const testEndpoint = CHANNEL_TEST_ENDPOINT[channelKey];

  const reEnable = useMutation({
    // Confirms in place: the chip turns back to "Active".
    meta: CONFIRMS_INLINE,
    mutationFn: (channelId: string) =>
      apiPost("/api/notifications/status", { channelId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.notificationsStatus(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsOverview(),
      });
    },
  });
  const test = useMutation({
    mutationFn: (endpoint: string) => runConnectionTest(endpoint),
    onSuccess: (result) => {
      if (result.kind === "ok") {
        toastWrittenOutcome(
          "success",
          t("settings.testConnection.ok", { latency: result.latency }),
        );
      } else {
        showErrorToast(
          translateCode(
            t,
            "settings.testConnection.errors",
            result.errorCode,
            "settings.testConnection.errors.generic",
          ),
        );
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsOverview(),
      });
    },
  });

  if (!row || !slots) return null;
  if (!autoDisabled && !testEndpoint) return null;

  return createPortal(
    <>
      {testEndpoint ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => test.mutate(testEndpoint)}
          disabled={test.isPending || autoDisabled}
          data-testid={`send-test-${row.type}`}
        >
          {test.isPending ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Send className="size-3.5" aria-hidden="true" />
          )}
          {t("settings.notificationStatus.sendTest")}
        </Button>
      ) : null}
      {autoDisabled ? (
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => reEnable.mutate(row.id)}
          disabled={reEnable.isPending}
          data-testid={`re-enable-${row.type}`}
        >
          {reEnable.isPending ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <RotateCw className="size-3.5" aria-hidden="true" />
          )}
          {t("settings.notificationStatus.reEnable")}
        </Button>
      ) : null}
    </>,
    slots,
  );
}

/** The integration's own controller, the component that was its card. */
function IntegrationController({
  item,
  callbackUrls,
}: {
  item: IntegrationOverviewItem;
  callbackUrls: IntegrationCallbackUrls;
}) {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();
  const sourceWithEnvelope =
    item.group === "source" &&
    item.key !== "apple-health" &&
    item.key !== "document-sources";
  const { data: envelope } = useIntegrationStatuses(
    isAuthenticated && sourceWithEnvelope,
  );
  switch (item.key) {
    case "withings":
    case "whoop":
    case "polar":
    case "oura":
    case "strava":
      return (
        <OAuthIntegrationCard
          config={OAUTH_INTEGRATIONS[item.key]}
          viewModel={pickStatus(envelope, item.key)}
          callbackUrl={callbackUrls[item.key]}
        />
      );
    case "google-health":
      return (
        <GoogleHealthCard
          viewModel={pickStatus(envelope, "google-health")}
          callbackUrl={callbackUrls["google-health"]}
        />
      );
    case "garmin":
      return <GarminCard viewModel={pickStatus(envelope, "garmin")} />;
    case "nightscout":
      return <NightscoutCard viewModel={pickStatus(envelope, "nightscout")} />;
    case "dawarich": {
      const viewModel = pickStatus(envelope, "dawarich");
      // With the environment module off the card's forms have nowhere to
      // write, so a stored connection shows its status read-only.
      if (user?.modules?.environment !== true) {
        return viewModel ? <IntegrationFallbackRow status={viewModel} /> : null;
      }
      return <DawarichCard viewModel={viewModel} />;
    }
    case "health-connect-remote": {
      const viewModel = pickStatus(envelope, "health-connect-remote");
      return (
        <>
          {viewModel?.configured ? (
            <IntegrationCard
              provider="health-connect-remote"
              providerName={t("settings.healthConnectFolder.name")}
              icon={INTEGRATION_ICON["health-connect-remote"]}
              connected={viewModel.connected === true}
              health={viewModel.health ?? null}
              testId="integration-card-health-connect-remote"
            />
          ) : null}
          <HealthConnectRemoteCard />
        </>
      );
    }
    case "apple-health":
      return (
        <>
          <AppleHealthCard enabled={isAuthenticated} />
          <SheetCardContext.Provider value="subheading">
            <NutrientIntakeCard />
          </SheetCardContext.Provider>
        </>
      );
    case "document-sources":
      return <DocumentSourcesCard />;
    case "telegram":
      return (
        <ChannelBody item={item}>
          <TelegramCard isAuthenticated={isAuthenticated} />
        </ChannelBody>
      );
    case "ntfy":
      return (
        <ChannelBody item={item}>
          <NtfyCard isAuthenticated={isAuthenticated} />
        </ChannelBody>
      );
    case "web-push":
      return (
        <ChannelBody item={item}>
          <WebPushCard />
        </ChannelBody>
      );
    case "webhook":
      return (
        <ChannelBody item={item}>
          <WebhookCard isAuthenticated={isAuthenticated} />
        </ChannelBody>
      );
    case "email":
      return (
        <ChannelBody item={item}>
          <EmailCard isAuthenticated={isAuthenticated} />
        </ChannelBody>
      );
    case "apns":
      return <ChannelBody item={item}>{null}</ChannelBody>;
  }
}

/** A channel's card, with its re-enable / test pair in the sheet's action row. */
function ChannelBody({
  item,
  children,
}: {
  item: IntegrationOverviewItem;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <ChannelSheetActions
        channelKey={item.key as OverviewChannelKey}
        autoDisabled={item.reason === "auto_disabled"}
      />
    </>
  );
}
