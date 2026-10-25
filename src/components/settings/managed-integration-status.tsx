"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Droplet, ExternalLink, Link2, Plug, Unplug } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  IntegrationCard,
  type IntegrationMenuAction,
} from "@/components/settings/integrations/integration-card";
import { Button } from "@/components/ui/button";
import { OAUTH_INTEGRATIONS } from "@/components/settings/integrations/oauth-integration-card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SectionHeading } from "@/components/ui/section-heading";
import { ApiError, apiGet, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { ConnectionHealth } from "@/lib/integrations/connection-health";
import {
  isManagedOAuthProvider,
  type ManagedOAuthProvider,
} from "@/lib/integrations/oauth-kit/managed-provider";
import { loadDocument } from "@/lib/navigation/load-document";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import { assertRecordSettingsResponseForRecord } from "@/lib/record-settings/response";
import { accountLabel } from "@/lib/sharing/account-access-view";

type ManagedIntegrationKey = keyof typeof INTEGRATION_DISPLAY_NAMES;

interface ManagedIntegrationStatusResponse {
  recordId: string;
  integrations: Array<{
    integration: ManagedIntegrationKey;
    /** The server-resolved state; null while the provider is not connected. */
    health: ConnectionHealth | null;
  }>;
}

const INTEGRATION_DISPLAY_NAMES = {
  withings: "Withings",
  whoop: "WHOOP",
  fitbit: "Fitbit",
  nightscout: "Nightscout",
  polar: "Polar",
  oura: "Oura",
  "google-health": "Google Health",
  strava: "Strava",
} as const;

/** Where the guardian boundary is explained, connected services included. */
const SHARING_DOCS_HREF =
  "https://docs.healthlog.dev/guides/managed-profiles/#connected-services";

function iconFor(key: ManagedIntegrationKey) {
  if (key === "nightscout") return Droplet;
  return OAUTH_INTEGRATIONS[key]?.icon ?? Plug;
}

/**
 * The managed record's connections, on the same card every integration in
 * Settings renders, from the same server-resolved `health`.
 *
 * A guardian connects and disconnects the record's OAuth providers here. The
 * connect starts with a fetch (`POST /api/record-settings/integrations/
 * <provider>/connect`, which carries the record-session headers a navigation
 * cannot) and then sends the browser to the provider; tokens and data land on
 * the managed record. Every card says whose record it connects for. Syncing,
 * testing and provider credentials stay out: the record syncs on its own
 * schedule once connected.
 */
export function ManagedIntegrationStatus() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const activeRecord = user?.accountAccess?.active ?? null;
  const recordId = activeRecord?.accountId ?? null;
  const statusQuery = useQuery({
    queryKey: queryKeys.recordSettingsIntegrations(recordId ?? ""),
    queryFn: async () => {
      const response = await apiGet<ManagedIntegrationStatusResponse>(
        "/api/record-settings/integrations",
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      return response;
    },
    enabled: activeRecord?.recordKind === "managed" && recordId !== null,
  });

  // Named the way the switcher and the banner name it: a profile created
  // without a display name still has a name to connect for.
  const recordName = activeRecord ? accountLabel(activeRecord) : "";

  const invalidateStatus = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.recordSettingsIntegrations(recordId ?? ""),
    });

  const connect = useMutation({
    mutationFn: async (provider: ManagedOAuthProvider) =>
      apiPost<{ authorizationUrl: string }>(
        `/api/record-settings/integrations/${provider}/connect`,
      ),
    onSuccess: (started) => loadDocument(started.authorizationUrl),
    onError: (failure, provider) =>
      showErrorToast(
        failure instanceof ApiError && failure.status === 409
          ? t("settings.sharedRecord.integrationNoClientApp", {
              name: recordName,
              provider: INTEGRATION_DISPLAY_NAMES[provider],
            })
          : t("settings.sharedRecord.integrationConnectFailed", {
              provider: INTEGRATION_DISPLAY_NAMES[provider],
            }),
        { cause: failure },
      ),
  });

  const disconnect = useMutation({
    mutationFn: async (provider: ManagedOAuthProvider) =>
      apiPost(`/api/record-settings/integrations/${provider}/disconnect`),
    onSuccess: (_result, provider) => {
      void invalidateStatus();
      // A record-settings write; the capability answer reads the record's
      // connections, so it is evicted with the rest of the AI inputs.
      void invalidateKeys(queryClient, aiInputDependentKeys);
      toastWrittenOutcome(
        "success",
        t("settings.integrationDisconnected", {
          provider: INTEGRATION_DISPLAY_NAMES[provider],
        }),
      );
    },
    onError: (failure, provider) =>
      showErrorToast(
        t("settings.integrationDisconnectFailed", {
          provider: INTEGRATION_DISPLAY_NAMES[provider],
        }),
        { cause: failure },
      ),
  });

  if (statusQuery.isError) {
    return (
      <QueryErrorCard
        error={statusQuery.error}
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }

  const loading = statusQuery.isLoading || !statusQuery.data;
  const entries =
    statusQuery.data?.integrations ??
    (Object.keys(INTEGRATION_DISPLAY_NAMES) as ManagedIntegrationKey[]).map(
      (integration) => ({ integration, health: null }),
    );

  /** What a guardian can do with one OAuth provider of the record. */
  function managedControls(provider: ManagedOAuthProvider) {
    const providerName = INTEGRATION_DISPLAY_NAMES[provider];
    const pending =
      (connect.isPending && connect.variables === provider) ||
      (disconnect.isPending && disconnect.variables === provider);
    const forRecord = (
      <p
        className="text-muted-foreground text-xs"
        data-slot="managed-integration-for"
      >
        {t("settings.sharedRecord.integrationConnectsFor", {
          name: recordName,
        })}
      </p>
    );
    const menu: IntegrationMenuAction[] = [
      {
        id: "disconnect",
        label: t("settings.sharedRecord.integrationDisconnect"),
        icon: Unplug,
        destructive: true,
        disabled: pending,
        onSelect: () => disconnect.mutate(provider),
        confirm: {
          title: t("settings.sharedRecord.integrationDisconnectTitle", {
            provider: providerName,
            name: recordName,
          }),
          body: t("settings.sharedRecord.integrationDisconnectBody", {
            name: recordName,
          }),
          confirmLabel: t("settings.sharedRecord.integrationDisconnect"),
        },
      },
    ];
    return {
      children: forRecord,
      menu,
      primary: {
        onReconnect: () => connect.mutate(provider),
        pending,
      },
      connectAction: (
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => connect.mutate(provider)}
          disabled={pending}
          aria-busy={pending || undefined}
          data-testid={`managed-integration-${provider}-connect`}
        >
          <Link2 className="size-3.5" aria-hidden="true" />
          {t("settings.sharedRecord.integrationConnectFor", {
            name: recordName,
          })}
        </Button>
      ),
    };
  }

  return (
    <section
      className="space-y-4"
      aria-labelledby={loading ? undefined : "managed-integration-status-title"}
      aria-busy={loading || undefined}
      aria-live={loading ? "polite" : undefined}
      data-record-id={recordId ?? undefined}
      data-record-settings-family="integrations"
    >
      <SectionHeading
        icon={Plug}
        id="managed-integration-status-title"
        title={t("settings.sections.integrations.title")}
        subtitle={t("settings.sharedRecord.integrationStatusDescription")}
      />
      <p className="text-sm" data-slot="managed-integration-target">
        {t("settings.sharedRecord.integrationStatusDetail", {
          name: recordName,
        })}{" "}
        <a
          href={SHARING_DOCS_HREF}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary inline-flex items-center gap-1 underline-offset-2 hover:underline"
        >
          {t("settings.sharedRecord.integrationStatusDocs")}
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </p>
      <ul className="space-y-4" aria-label={recordName || undefined}>
        {entries.map((entry) => (
          <li key={entry.integration}>
            <IntegrationCard
              provider={entry.integration}
              providerName={INTEGRATION_DISPLAY_NAMES[entry.integration]}
              icon={iconFor(entry.integration)}
              loading={loading}
              connected={entry.health !== null}
              health={entry.health}
              testId={`managed-integration-${entry.integration}`}
              {...(isManagedOAuthProvider(entry.integration)
                ? managedControls(entry.integration)
                : {})}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
