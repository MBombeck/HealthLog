"use client";

// v1.17.0 (F4) — shared OAuth integration card for Polar / Oura.
// v1.17.1 — these are now per-user BYO-key integrations (like WHOOP / Fitbit):
// the card renders an optional "your OAuth app credentials" form (driven by the
// `credentials` prop) above the connect button. Credentials resolve DB-first
// then env on the server, so a user who pastes their own client id/secret uses
// their own app while existing env-configured deploys keep working unchanged.
// Mirrors the Nightscout card's self-contained status pattern.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Unlink,
  type LucideIcon,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { IntegrationStatusPill } from "@/components/settings/integration-status-pill";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { useTranslations } from "@/lib/i18n/context";
import type {
  MetricFreshnessEntry,
  SyncHealth,
} from "@/lib/integrations/sync-verdict";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { MetricFreshnessDisclosure } from "./metric-freshness-disclosure";
import {
  readSyncOutcome,
  useSyncOutcomeMessage,
  type SyncOutcomeState,
} from "./sync-outcome";
import {
  IntegrationErrorMessage,
  pillFailurePropsFor,
  pillStateForVerdict,
  type IntegrationState,
} from "./shared";
import {
  CallbackMismatchNotice,
  IntegrationCardDescription,
  IntegrationRedirectGuide,
  type IntegrationDocsProvider,
} from "./setup-guide-link";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";

export interface OAuthProviderStatus {
  connected: boolean;
  configured: boolean;
  available: boolean;
  /** Whether the user has stored their own BYO client id/secret pair. */
  hasOwnCredentials?: boolean;
  /**
   * The raw ledger state, carried for shape parity with the envelope. The
   * card paints from `syncHealth.verdict`, never from this — which is why
   * v1.38.19's `unknown` member needs no arm here.
   */
  state?: IntegrationState;
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  legacyLastSyncedAt?: string | null;
  consecutiveFailuresByKind?: {
    transient: number;
    reauth_required: number;
    persistent: number;
  } | null;
  failureThreshold?: number;
  /** The server-resolved liveness verdict; the pill is a projection of it. */
  syncHealth?: SyncHealth;
  metricFreshness?: MetricFreshnessEntry[];
}

export interface OAuthProviderCardProps {
  /** Lower-case provider key, used for routes + query keys + testids. */
  provider: "polar" | "oura" | "strava";
  /** The provider's own query key, invalidated after connect / sync / save. */
  statusQueryKey: readonly unknown[];
  /** i18n key prefix (e.g. `settings.polar`). */
  i18nPrefix: string;
  /** Distinct card glyph, kept in the same size/treatment as the other cards. */
  icon: LucideIcon;
  /** Where this provider's synced data surfaces (e.g. `/insights/sleep`). */
  dataHref: string;
  /** When set, render a per-user BYO OAuth-credentials form above the connect
   * button. The endpoint is the PUT target (e.g. `/api/polar/credentials`). */
  credentials?: boolean;
  /**
   * The card's status, sourced off the consolidated
   * `/api/integrations/status` envelope. The card used to fall back to its own
   * `/api/<provider>/status` round-trip when this was absent; that fallback is
   * gone. Every mount passes a view-model, the per-provider response carries no
   * `syncHealth` so the fallback would have painted a wrong verdict, and during
   * envelope load it fired three redundant requests for a caller that does not
   * exist.
   */
  viewModel?: OAuthProviderStatus;
  /** Server-resolved OAuth callback URL; see `getIntegrationCallbackUrls`. */
  callbackUrl: IntegrationCallbackUrls[OAuthProviderCardProps["provider"]];
}

export function OAuthProviderCard({
  provider,
  statusQueryKey,
  i18nPrefix,
  icon,
  dataHref,
  credentials = false,
  viewModel,
  callbackUrl,
}: OAuthProviderCardProps) {
  const { t } = useTranslations();
  const describeSyncOutcome = useSyncOutcomeMessage();
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncOutcomeState | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );

  const status = viewModel;

  // Sync now. Same shape as the WHOOP card's incremental arm, minus the
  // full-history dialog — none of these providers has a full-sync arm to call.
  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await apiFetchRaw(`/api/${provider}/sync`, {
        method: "POST",
      });
      const json = await res.json();
      const result = res.ok ? readSyncOutcome(json) : null;
      if (result) {
        // The tone comes off what the run wrote, not off `res.ok`.
        setSyncResult({
          outcome: result.outcome,
          message: describeSyncOutcome(
            result,
            t(`${i18nPrefix}SyncResult`, { count: result.imported }),
          ),
        });
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: statusQueryKey });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncResult({
          outcome: "failed",
          message: json?.error || t(`${i18nPrefix}SyncFailed`),
        });
      }
    } catch {
      setSyncResult({
        outcome: "failed",
        message: t(`${i18nPrefix}SyncFailed`),
      });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);
    try {
      const res = await apiFetchRaw(`/api/${provider}/credentials`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });
      if (res.ok) {
        setCredsMsg(t(`${i18nPrefix}CredentialsSaved`));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: statusQueryKey });
        // The card may read off the consolidated envelope — invalidate it too
        // so the saved-credentials state repaints regardless of the source.
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost(`/api/${provider}/disconnect`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusQueryKey });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  const pillState = pillStateForVerdict(status?.syncHealth?.verdict);
  // The pill says what; this line says why. `warning` joins the set now that a
  // transient failure no longer paints red — the detail moved here from a
  // colour that told the user to reconnect against something reconnecting
  // cannot fix.
  const errorMessage =
    (pillState === "error" ||
      pillState === "parked" ||
      pillState === "warning") &&
    status?.lastError
      ? status.lastError
      : null;
  const serverUnavailable = status && !status.available;

  function handleConnect() {
    setMsg(null);
    void invalidateKeys(queryClient, measurementDependentKeys);
    window.location.href = `/api/${provider}/connect`;
  }

  return (
    <SettingsCard data-testid={`${provider}-card`}>
      <SettingsCardHeader
        icon={icon}
        title={t(`${i18nPrefix}`)}
        description={
          <IntegrationCardDescription
            i18nPrefix={i18nPrefix}
            provider={provider as IntegrationDocsProvider}
          />
        }
        status={
          <IntegrationStatusPill
            state={pillState}
            lastSyncAt={
              pillState === "stale" || pillState === "stalled"
                ? (status?.syncHealth?.since ?? null)
                : (status?.legacyLastSyncedAt ?? status?.lastSuccessAt ?? null)
            }
            {...pillFailurePropsFor(status)}
          />
        }
      />

      <div className="space-y-4">
        {errorMessage && (
          <div data-testid={`${provider}-error`}>
            <IntegrationErrorMessage message={errorMessage} />
          </div>
        )}

        {/* Parked-integration resume CTA. Surfaces only when the row state
            is `parked` (>24h of persistent failures). For an env-based OAuth
            provider there are no stored BYO credentials to re-validate — the
            grant itself has to be re-issued, so "reconnect" re-initiates the
            existing connect flow (`/api/<provider>/connect`); a successful
            callback clears the park. Markup matches the WHOOP card byte for
            byte. */}
        {pillState === "parked" && (
          <div
            data-testid={`${provider}-parked-banner`}
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 text-xs break-words">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleConnect}
              disabled={serverUnavailable}
              data-testid={`${provider}-resume-button`}
              className="min-h-11"
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}

        {status?.connected && (
          <MetricFreshnessDisclosure
            entries={status.metricFreshness}
            idPrefix={provider}
          />
        )}

        {credentials && (
          <div className="space-y-3" data-testid={`${provider}-credentials`}>
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t(`${i18nPrefix}Credentials`)}
            </h3>
            {!status?.hasOwnCredentials && (
              <IntegrationRedirectGuide
                provider={provider}
                providerLabel={t(i18nPrefix)}
                callbackUrl={callbackUrl}
              />
            )}
            <form onSubmit={handleSaveCredentials} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${provider}-clientid`}>
                    {t(`${i18nPrefix}ClientId`)}
                  </Label>
                  <Input
                    id={`${provider}-clientid`}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder={
                      status?.hasOwnCredentials
                        ? t(`${i18nPrefix}CredentialsSavedPlaceholder`)
                        : t(`${i18nPrefix}ClientId`)
                    }
                    maxLength={200}
                    autoComplete="off"
                    inputMode="text"
                    spellCheck={false}
                    autoCapitalize="none"
                    enterKeyHint="next"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${provider}-secret`}>
                    {t(`${i18nPrefix}ClientSecret`)}
                  </Label>
                  <PasswordInput
                    id={`${provider}-secret`}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder={
                      status?.hasOwnCredentials
                        ? t(`${i18nPrefix}CredentialsSavedPlaceholder`)
                        : t(`${i18nPrefix}ClientSecret`)
                    }
                    maxLength={200}
                    autoComplete="off"
                    inputMode="text"
                    spellCheck={false}
                    autoCapitalize="none"
                    enterKeyHint="done"
                  />
                </div>
              </div>
              <SettingsCardActions>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  className="min-h-11 w-full sm:w-auto"
                  disabled={
                    credsSaving || !clientId.trim() || !clientSecret.trim()
                  }
                >
                  {credsSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {t(`${i18nPrefix}SaveCredentials`)}
                </Button>
              </SettingsCardActions>
              {credsMsg && (
                <p
                  role="alert"
                  className={`text-sm ${credsMsgType === "success" ? "text-success" : "text-destructive"}`}
                >
                  {credsMsg}
                </p>
              )}
            </form>
          </div>
        )}

        {serverUnavailable && (
          <p
            className="text-muted-foreground text-xs"
            data-testid={`${provider}-unavailable`}
          >
            {t(`${i18nPrefix}Unavailable`)}
          </p>
        )}

        {status?.connected ? (
          <>
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={handleSync}
                disabled={syncing}
                data-testid={`${provider}-sync`}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t(`${i18nPrefix}Sync`)}
              </Button>
              <TestConnectionButton
                endpoint={`/api/${provider}/test`}
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive min-h-11"
                    data-testid={`${provider}-disconnect`}
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    {t(`${i18nPrefix}Disconnect`)}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t(`${i18nPrefix}DisconnectTitle`)}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(`${i18nPrefix}DisconnectDescription`)}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t(`${i18nPrefix}Disconnect`)}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncResult && (
              <WrittenOutcomeLine
                outcome={syncResult.outcome}
                message={syncResult.message}
                testId={`${provider}-sync-result`}
              />
            )}
            {/* connect→data loop: a discreet link to where this provider's
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href={dataHref}
              data-testid={`${provider}-data-link`}
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t(`${i18nPrefix}ViewData`)}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : (
          <SettingsCardActions>
            <Button
              type="button"
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              disabled={serverUnavailable}
              onClick={handleConnect}
              data-testid={`${provider}-connect`}
            >
              <Link2 className="h-3.5 w-3.5" />
              {t(`${i18nPrefix}Connect`)}
            </Button>
          </SettingsCardActions>
        )}

        {msg && (
          <p role="alert" className="text-destructive text-sm">
            {msg}
          </p>
        )}
      </div>
      <CallbackMismatchNotice
        provider={t(i18nPrefix)}
        callbackUrl={callbackUrl}
      />
    </SettingsCard>
  );
}
