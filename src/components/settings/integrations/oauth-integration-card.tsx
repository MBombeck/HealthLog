"use client";

/**
 * The controller behind every OAuth integration card: Withings, WHOOP,
 * Google Health, Polar, Oura and Strava.
 *
 * It owns the requests (connect, resume, sync, test, disconnect, the BYO
 * credentials form) and hands `<IntegrationCard>` what the person can do. The
 * card decides nothing about health: it renders the server's `health` field.
 * What used to be per-provider banners (the Withings plan note, the Oura scope
 * note, the Withings activity-scope reconnect, the Google Health re-consent,
 * the paused pill with its resume button) is now the sentence plus the one
 * primary button that `health.action` names.
 */

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  Activity,
  ArrowRight,
  BookOpen,
  CircleDot,
  ExternalLink,
  History,
  KeyRound,
  Link2,
  Plug,
  RefreshCw,
  Unlink,
  Watch,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import { loadDocument } from "@/lib/navigation/load-document";
import { WITHINGS_API_PLANS_URL } from "@/lib/withings/plan-features";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

import { CredentialsForm } from "./credentials-form";
import {
  ActionResultLines,
  useConnectionTest,
  useStandardSync,
  type ProviderSync,
} from "./integration-actions";
import {
  IntegrationCard,
  type IntegrationMenuAction,
} from "./integration-card";
import { HistoryEndsNote } from "./history-ends-note";
import { MetricFreshnessList } from "./metric-freshness-list";
import {
  CallbackMismatchNotice,
  IntegrationCardDescription,
  IntegrationSetupGuideLink,
  IntegrationRedirectGuide,
  integrationDocsHref,
  type IntegrationDocsProvider,
} from "./setup-guide-link";
import { failureStreakFor, type IntegrationStatusViewModel } from "./shared";
import { InlineAction } from "@/components/ui/inline-action";

export type OAuthIntegrationKey =
  "withings" | "whoop" | "google-health" | "polar" | "oura" | "strava";

export interface OAuthIntegrationConfig {
  /** Connection key; also the `/api/<key>/…` route segment. */
  provider: OAuthIntegrationKey;
  /** i18n base, e.g. `settings.withings`. */
  i18nPrefix: string;
  icon: LucideIcon;
  docs: IntegrationDocsProvider;
  /** Where this provider's data surfaces. */
  dataHref: string;
  /** The sync route takes `{ fullSync }` and the menu offers the full reload. */
  fullSync: boolean;
  /** A full sync reports with its own sentence (`…FullSyncResult`). */
  fullSyncResult?: boolean;
  /**
   * `required`: the person must store their own client id/secret before
   * connecting (`configured`). `optional`: a shared app may exist on the
   * server (`available`), and the person's own pair is an alternative.
   */
  credentials: "required" | "optional";
  /** The provider ships a secret-specific saved placeholder. */
  secretPlaceholder: boolean;
  /** Show the callback-URL guide before credentials are stored. */
  redirectGuide: boolean;
  /**
   * POST endpoint that clears a pause. Null: the grant itself has to be
   * re-issued, so "Resume" re-runs connect, as it always did for these.
   */
  resumeEndpoint: string | null;
  testEndpoint: string;
  statusQueryKey: () => readonly unknown[];
}

export const OAUTH_INTEGRATIONS: Record<
  OAuthIntegrationKey,
  OAuthIntegrationConfig
> = {
  withings: {
    provider: "withings",
    i18nPrefix: "settings.withings",
    icon: Link2,
    docs: "withings",
    dataHref: "/measurements",
    fullSync: true,
    fullSyncResult: true,
    credentials: "required",
    secretPlaceholder: true,
    redirectGuide: true,
    resumeEndpoint: "/api/integrations/withings/resume",
    testEndpoint: "/api/integrations/withings/test",
    statusQueryKey: queryKeys.withings,
  },
  whoop: {
    provider: "whoop",
    i18nPrefix: "settings.whoop",
    icon: Activity,
    docs: "whoop",
    dataHref: "/insights/recovery",
    fullSync: true,
    credentials: "required",
    secretPlaceholder: true,
    redirectGuide: true,
    resumeEndpoint: "/api/integrations/whoop/resume",
    testEndpoint: "/api/integrations/whoop/test",
    statusQueryKey: queryKeys.whoop,
  },
  "google-health": {
    provider: "google-health",
    i18nPrefix: "settings.googleHealth",
    icon: Watch,
    docs: "google-health",
    dataHref: "/insights/steps",
    fullSync: true,
    credentials: "required",
    secretPlaceholder: true,
    redirectGuide: false,
    resumeEndpoint: "/api/integrations/google-health/resume",
    testEndpoint: "/api/integrations/google-health/test",
    statusQueryKey: queryKeys.googleHealth,
  },
  polar: {
    provider: "polar",
    i18nPrefix: "settings.polar",
    icon: Watch,
    docs: "polar",
    dataHref: "/insights/sleep",
    fullSync: false,
    credentials: "optional",
    secretPlaceholder: false,
    redirectGuide: true,
    resumeEndpoint: null,
    testEndpoint: "/api/polar/test",
    statusQueryKey: queryKeys.polar,
  },
  oura: {
    provider: "oura",
    i18nPrefix: "settings.oura",
    icon: CircleDot,
    docs: "oura",
    dataHref: "/insights/sleep",
    fullSync: false,
    credentials: "optional",
    secretPlaceholder: false,
    redirectGuide: true,
    resumeEndpoint: null,
    testEndpoint: "/api/oura/test",
    statusQueryKey: queryKeys.oura,
  },
  strava: {
    provider: "strava",
    i18nPrefix: "settings.strava",
    icon: Activity,
    docs: "strava",
    dataHref: "/insights/workouts",
    fullSync: false,
    credentials: "optional",
    secretPlaceholder: false,
    redirectGuide: true,
    resumeEndpoint: null,
    testEndpoint: "/api/strava/test",
    statusQueryKey: queryKeys.strava,
  },
};

/** The standard controller: a provider whose sync answers in one response. */
export function OAuthIntegrationCard(props: {
  config: OAuthIntegrationConfig;
  viewModel: IntegrationStatusViewModel | undefined;
  callbackUrl: IntegrationCallbackUrls[OAuthIntegrationKey];
  icon?: LucideIcon;
  titleAccessory?: ReactNode;
}) {
  const { config } = props;
  const sync = useStandardSync({
    provider: config.provider,
    i18nPrefix: config.i18nPrefix,
    acceptsFullSync: config.fullSync,
    fullSyncResult: config.fullSyncResult,
    statusQueryKey: config.statusQueryKey(),
  });
  return <OAuthIntegrationCardView {...props} sync={sync} />;
}

/**
 * The view half, so a provider with its own sync choreography (Google Health
 * polls for completion) can hand in its own `sync` and keep everything else.
 */
export function OAuthIntegrationCardView({
  config,
  viewModel,
  callbackUrl,
  icon,
  titleAccessory,
  sync,
  syncLabel,
  fullSyncDisabled,
  syncResults,
  details,
}: {
  config: OAuthIntegrationConfig;
  viewModel: IntegrationStatusViewModel | undefined;
  callbackUrl: IntegrationCallbackUrls[OAuthIntegrationKey];
  icon?: LucideIcon;
  titleAccessory?: ReactNode;
  sync: ProviderSync;
  /** Overrides the sync item's label (Google Health's "check status"). */
  syncLabel?: string;
  fullSyncDisabled?: boolean;
  /** Replaces the standard sync result line. */
  syncResults?: ReactNode;
  /** Provider extras for the details section. */
  details?: ReactNode;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { provider, i18nPrefix } = config;
  const statusQueryKey = config.statusQueryKey();
  const test = useConnectionTest(config.testEndpoint);
  const [editingCredentials, setEditingCredentials] = useState(false);

  const providerName = t(i18nPrefix);
  const providerArg = { provider: providerName };
  const connected = viewModel?.connected ?? false;
  const configured =
    config.credentials === "required"
      ? (viewModel?.configured ?? false)
      : (viewModel?.available ?? false);
  const ownCredentials =
    config.credentials === "required"
      ? (viewModel?.configured ?? false)
      : (viewModel?.hasOwnCredentials ?? false);

  function invalidateStatus() {
    queryClient.invalidateQueries({ queryKey: statusQueryKey });
    queryClient.invalidateQueries({
      queryKey: queryKeys.integrationsStatus(),
    });
  }

  function connect() {
    void invalidateKeys(queryClient, measurementDependentKeys);
    loadDocument(`/api/${provider}/connect`);
  }

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost(`/api/${provider}/disconnect`);
    },
    onSuccess: () => {
      invalidateStatus();
      toastWrittenOutcome(
        "success",
        t("settings.integrationDisconnected", providerArg),
      );
    },
    // The dialog has closed; a refused disconnect must still say so.
    onError: (failure) =>
      showErrorToast(t("settings.integrationDisconnectFailed", providerArg), {
        cause: failure,
      }),
  });

  const resume = useMutation({
    mutationFn: async () => {
      if (!config.resumeEndpoint) return null;
      return apiPost<{ resumed: boolean; wasParked: boolean }>(
        config.resumeEndpoint,
      );
    },
    onSuccess: invalidateStatus,
  });

  const credentialsForm = (
    <CredentialsForm
      provider={provider}
      i18nPrefix={i18nPrefix}
      saved={ownCredentials}
      secretPlaceholder={config.secretPlaceholder}
      statusQueryKey={statusQueryKey}
    />
  );

  const description = <IntegrationCardDescription i18nPrefix={i18nPrefix} />;

  if (!connected) {
    return (
      <IntegrationCard
        provider={provider}
        providerName={providerName}
        icon={icon ?? config.icon}
        titleAccessory={titleAccessory}
        description={description}
        loading={viewModel === undefined}
        connected={false}
        health={null}
        setup={
          <div className="space-y-3">
            <IntegrationSetupGuideLink provider={config.docs} />
            {config.redirectGuide && !ownCredentials ? (
              <IntegrationRedirectGuide
                provider={config.docs}
                providerLabel={providerName}
                callbackUrl={callbackUrl}
              />
            ) : null}
            {credentialsForm}
            {!configured ? (
              <p
                className="text-muted-foreground text-xs"
                data-testid={
                  config.credentials === "required"
                    ? "integration-unavailable"
                    : `${provider}-unavailable`
                }
              >
                {config.credentials === "required"
                  ? t(`${i18nPrefix}NoCredentials`)
                  : t("settings.integrationCard.notConfigured", providerArg)}
              </p>
            ) : null}
            <CallbackMismatchNotice
              provider={providerName}
              callbackUrl={callbackUrl}
            />
          </div>
        }
        connectAction={
          <Button
            type="button"
            size="sm"
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
            disabled={!configured}
            onClick={connect}
            data-slot="integration-primary-action"
            data-action="connect"
            data-testid={`${provider}-connect`}
          >
            <Link2 className="size-3.5" aria-hidden="true" />
            {t(`${i18nPrefix}Connect`)}
          </Button>
        }
      />
    );
  }

  const busy = sync.syncing;
  const menu: IntegrationMenuAction[] = [
    {
      id: "sync",
      label: syncLabel ?? t(`${i18nPrefix}Sync`),
      icon: RefreshCw,
      disabled: busy,
      onSelect: () => sync.run(false),
    },
    ...(config.fullSync
      ? [
          {
            id: "full-sync",
            label: t(`${i18nPrefix}FullSync`),
            icon: History,
            disabled: busy || fullSyncDisabled,
            onSelect: () => sync.run(true),
            confirm: {
              title: t(`${i18nPrefix}FullSyncTitle`),
              body: t(`${i18nPrefix}FullSyncDescription`),
              confirmLabel: t(`${i18nPrefix}Synchronize`),
            },
          } satisfies IntegrationMenuAction,
        ]
      : []),
    {
      id: "test",
      label: t("settings.testConnection.test"),
      icon: Plug,
      disabled: test.testing,
      onSelect: test.run,
    },
    {
      id: "view-data",
      label: t(`${i18nPrefix}ViewData`),
      icon: ArrowRight,
      href: config.dataHref,
    },
    {
      id: "credentials",
      label: t("settings.integrationCard.menu.credentials"),
      icon: KeyRound,
      onSelect: () => setEditingCredentials((open) => !open),
    },
    {
      id: "setup-guide",
      label: t("settings.integrationSetupGuide"),
      icon: BookOpen,
      href: integrationDocsHref(config.docs),
      external: true,
    },
    {
      id: "disconnect",
      label: t(`${i18nPrefix}Disconnect`),
      icon: Unlink,
      destructive: true,
      onSelect: () => disconnect.mutate(),
      confirm: {
        title: t(`${i18nPrefix}DisconnectTitle`),
        body: t(`${i18nPrefix}DisconnectDescription`),
        confirmLabel: t(`${i18nPrefix}Disconnect`),
      },
    },
  ];

  const streak = failureStreakFor(viewModel);
  // Withings' paid API plan withholds some readings; the page that explains
  // the plans stays one tap away in the details.
  const planLimited =
    provider === "withings" &&
    (viewModel?.health?.unavailable.some((u) => u.cause === "plan") ?? false);

  return (
    <IntegrationCard
      provider={provider}
      providerName={providerName}
      icon={icon ?? config.icon}
      titleAccessory={titleAccessory}
      connected
      health={viewModel?.health ?? null}
      historyLoading={viewModel?.backfillCompleted === false}
      primary={{
        onReconnect: connect,
        onResume: config.resumeEndpoint ? () => resume.mutate() : connect,
        pending: resume.isPending,
        disabled: config.credentials === "optional" && !configured,
      }}
      menu={menu}
      diagnosticsExtra={
        streak
          ? [
              t("settings.integrationCard.details.failureStreak", {
                count: streak.count,
                threshold: streak.threshold,
              }),
            ]
          : undefined
      }
      details={
        details || planLimited || viewModel?.metricFreshness?.length ? (
          <>
            {planLimited ? (
              <InlineAction asChild size="sm">
                <a
                  href={WITHINGS_API_PLANS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="withings-plan-link"
                >
                  {t("settings.integrations.withings.plan.link")}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </InlineAction>
            ) : null}
            {details}
            <MetricFreshnessList entries={viewModel?.metricFreshness} />
          </>
        ) : undefined
      }
    >
      <HistoryEndsNote provider={provider} entries={viewModel?.backfillEnded} />
      {syncResults ?? (
        <ActionResultLines provider={provider} sync={sync} test={test} />
      )}
      {syncResults ? (
        <ActionResultLines provider={provider} test={test} />
      ) : null}
      {resume.isError ? (
        <p
          role="alert"
          className="text-destructive text-sm"
          data-testid={`${provider}-resume-error`}
        >
          {t("settings.integrationPill.resumeError")}
        </p>
      ) : null}
      {resume.isSuccess && resume.data?.wasParked ? (
        <p
          role="status"
          className="text-success text-xs"
          data-testid={`${provider}-resume-success`}
        >
          {t("settings.integrationPill.resumeSuccess")}
        </p>
      ) : null}
      {editingCredentials ? credentialsForm : null}
      <CallbackMismatchNotice
        provider={providerName}
        callbackUrl={callbackUrl}
      />
    </IntegrationCard>
  );
}
