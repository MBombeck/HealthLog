"use client";

/**
 * `<ConnectionsPanel>` — the connected-services half of Settings →
 * Integrations: Withings / WHOOP / Fitbit / Polar / Oura / Nightscout.
 *
 * v1.18.0 (S3) — extracted out of `integrations-section.tsx` so the section
 * file can host the Connections / Channels / Sources sub-tabs without growing
 * unbounded. This panel owns the OAuth-callback toast handlers (the four
 * providers + Withings redirect back here with `?<provider>=…` params) and the
 * card grid. It renders no page header of its own; the parent supplies it.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AppleHealthCard } from "@/components/settings/integrations/apple-health-card";
import { FitbitCard } from "@/components/settings/integrations/fitbit-card";
import { GarminInfoNote } from "@/components/settings/integrations/garmin-info-note";
import { GoogleHealthCard } from "@/components/settings/integrations/google-health-card";
import { NightscoutCard } from "@/components/settings/integrations/nightscout-card";
import type { OAuthProviderStatus } from "@/components/settings/integrations/oauth-provider-card";
import { OuraCard } from "@/components/settings/integrations/oura-card";
import { PolarCard } from "@/components/settings/integrations/polar-card";
import { StravaCard } from "@/components/settings/integrations/strava-card";
import {
  pickStatus,
  useIntegrationStatuses,
  type IntegrationStatusViewModel,
} from "@/components/settings/integrations/shared";
import { WhoopCard } from "@/components/settings/integrations/whoop-card";
import { WithingsCard } from "@/components/settings/integrations/withings-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * The Withings OAuth callback (`/api/withings/callback`) redirects back
 * here with `?withings=connected` or `?withings=error&reason=<tag>`.
 * Map every reason tag the callback emits onto a human-readable i18n
 * key (what went wrong + what to do next). Unknown tags fall back to
 * the generic entry so a future callback branch never strands the user
 * with silent params.
 */
const WITHINGS_OAUTH_ERROR_KEYS: Record<string, string> = {
  csrf1: "settings.withingsOauthError.csrf1",
  replay: "settings.withingsOauthError.replay",
  state: "settings.withingsOauthError.state",
  expired: "settings.withingsOauthError.expired",
  cross_user: "settings.withingsOauthError.cross_user",
  nocode: "settings.withingsOauthError.nocode",
  nocreds: "settings.withingsOauthError.nocreds",
  token: "settings.withingsOauthError.token",
};

type WithingsOauthOutcome =
  { kind: "connected" } | { kind: "error"; reason: string };

/**
 * The OAuth providers whose callbacks redirect back to the settings page with a
 * `?<provider>=connected|error&reason=<tag>` outcome param. Polar/Oura own a
 * per-card status query; WHOOP/Fitbit read off the consolidated envelope — both
 * are invalidated on a successful return so the card repaints either way.
 */
// v1.27.0 — `googleHealth` joins the outcome set. Its callback redirects with
// `?googleHealth=connected|error&reason=<tag>` (the fitbit→googleHealth
// identifier rename), and the i18n toast keys resolve under the same camelCase
// prefix (`settings.googleHealthOauth*`).
const OAUTH_OUTCOME_PROVIDERS = [
  "polar",
  "oura",
  "whoop",
  "fitbit",
  "googleHealth",
  // v1.28.x — Strava callback redirects with `?strava=connected|error&reason=…`.
  "strava",
] as const;
type OAuthOutcomeProvider = (typeof OAUTH_OUTCOME_PROVIDERS)[number];

const OAUTH_OUTCOME_KEYS: Record<
  OAuthOutcomeProvider,
  () => readonly unknown[]
> = {
  polar: queryKeys.polar,
  oura: queryKeys.oura,
  whoop: queryKeys.whoop,
  fitbit: queryKeys.fitbit,
  googleHealth: queryKeys.googleHealth,
  strava: queryKeys.strava,
};

/**
 * Reason tags the four OAuth callbacks emit. Known tags resolve to a specific
 * message; anything else falls back to the provider's `generic` copy. Union of
 * the Polar/Oura set (`rate_limited`) and the WHOOP/Fitbit set (`expired`).
 */
const OAUTH_OUTCOME_REASONS = new Set([
  "csrf1",
  "state",
  "cross_user",
  "nocode",
  "nocreds",
  "token",
  "rate_limited",
  "expired",
]);

type OAuthOutcome =
  | { provider: OAuthOutcomeProvider; kind: "connected" }
  | { provider: OAuthOutcomeProvider; kind: "error"; reason: string };

/**
 * Parse the OAuth-return outcome from a URL query string. Reads the first
 * provider whose `?<provider>=connected|error` param is present, in
 * `OAUTH_OUTCOME_PROVIDERS` order. Pure + exported so the four-provider
 * coverage is unit-testable without a browser.
 */
export function parseOAuthOutcome(search: string): OAuthOutcome | null {
  const params = new URLSearchParams(search);
  for (const provider of OAUTH_OUTCOME_PROVIDERS) {
    const v = params.get(provider);
    if (v === "connected") return { provider, kind: "connected" };
    if (v === "error") {
      return {
        provider,
        kind: "error",
        reason: params.get("reason") ?? "unknown",
      };
    }
  }
  return null;
}

/**
 * Resolve the i18n key for an error reason tag. Known tags map to the
 * provider-specific message; anything else falls back to `generic`.
 */
export function oauthReasonKey(
  provider: OAuthOutcomeProvider,
  reason: string,
): string {
  return OAUTH_OUTCOME_REASONS.has(reason)
    ? `settings.${provider}OauthError.${reason}`
    : `settings.${provider}OauthError.generic`;
}

/**
 * Adapt the consolidated-envelope view-model into the OAuth card's status
 * shape. Returns `undefined` when the envelope hasn't loaded so the card
 * renders its loading/disconnected default rather than a half-populated state.
 */
function toOAuthStatus(
  vm: IntegrationStatusViewModel | undefined,
): OAuthProviderStatus | undefined {
  if (!vm) return undefined;
  return {
    connected: vm.connected ?? false,
    configured: vm.configured ?? false,
    available: vm.available ?? false,
    hasOwnCredentials: vm.hasOwnCredentials,
    state: vm.state,
    lastSuccessAt: vm.lastSuccessAt,
    lastAttemptAt: vm.lastAttemptAt,
    lastError: vm.lastError,
  };
}

export function ConnectionsPanel() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: integrationStatus } = useIntegrationStatuses(isAuthenticated);

  // OAuth callback handler — reads `?withings=connected|error&reason=…`
  // from the URL (lazy initialiser, same shape as the Codex handler in
  // `ai-section.tsx`) and surfaces the outcome as a toast. Pre-fix the
  // callback set these params and nothing ever read them: a user came
  // back from Withings onto a silently unchanged settings page.
  const [withingsOauthOutcome] = useState<WithingsOauthOutcome | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("withings");
    if (status === "connected") return { kind: "connected" };
    if (status === "error") {
      return { kind: "error", reason: params.get("reason") ?? "unknown" };
    }
    return null;
  });

  useEffect(() => {
    if (!withingsOauthOutcome) return;
    // Scrub the one-shot params so a reload / bookmark doesn't replay
    // the toast.
    const url = new URL(window.location.href);
    url.searchParams.delete("withings");
    url.searchParams.delete("reason");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
    if (withingsOauthOutcome.kind === "connected") {
      toast.success(t("settings.withingsOauthConnected"));
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    } else {
      const reasonKey =
        WITHINGS_OAUTH_ERROR_KEYS[withingsOauthOutcome.reason] ??
        "settings.withingsOauthError.generic";
      toast.error(t("settings.withingsOauthFailed"), {
        description: t(reasonKey),
        duration: 10_000,
      });
    }
  }, [withingsOauthOutcome, router, queryClient, t]);

  // v1.17.0 (F4) — generic OAuth-callback toast for the OAuth providers.
  // The Polar / Oura / WHOOP / Fitbit callbacks redirect back with
  // `?<provider>=connected` or `?<provider>=error&reason=<tag>`; surface the
  // outcome as a toast and scrub the one-shot params so a reload doesn't replay
  // it. Pre-v1.17.1 only Polar/Oura were read here — a user returning from a
  // WHOOP or Fitbit round-trip landed on a silently unchanged settings page,
  // the same gap the Withings handler was written to close.
  const [oauthOutcome] = useState<OAuthOutcome | null>(() => {
    if (typeof window === "undefined") return null;
    return parseOAuthOutcome(window.location.search);
  });

  useEffect(() => {
    if (!oauthOutcome) return;
    const { provider } = oauthOutcome;
    const url = new URL(window.location.href);
    url.searchParams.delete(provider);
    url.searchParams.delete("reason");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
    if (oauthOutcome.kind === "connected") {
      toast.success(t(`settings.${provider}OauthConnected`));
      // Polar/Oura own a per-card status query; WHOOP/Fitbit read off the
      // consolidated envelope — invalidate both so the card repaints either way.
      queryClient.invalidateQueries({
        queryKey: OAUTH_OUTCOME_KEYS[provider](),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    } else {
      // Known reason tags resolve to a specific message; anything else falls
      // back to the generic copy (matching the Withings handler).
      toast.error(t(`settings.${provider}OauthFailed`), {
        description: t(oauthReasonKey(provider, oauthOutcome.reason)),
        duration: 10_000,
      });
    }
  }, [oauthOutcome, router, queryClient, t]);

  const withingsViewModel = pickStatus(integrationStatus, "withings");
  const whoopViewModel = pickStatus(integrationStatus, "whoop");
  const fitbitViewModel = pickStatus(integrationStatus, "fitbit");
  // v1.27.0 — Google Health reads off the same consolidated envelope; the
  // ledger integration key is the hyphenated `google-health`.
  const googleHealthViewModel = pickStatus(integrationStatus, "google-health");
  // v1.17.1 — Polar/Oura now read off the same consolidated envelope; the cards
  // no longer fire their own /api/<provider>/status round-trip.
  const polarViewModel = toOAuthStatus(pickStatus(integrationStatus, "polar"));
  const ouraViewModel = toOAuthStatus(pickStatus(integrationStatus, "oura"));
  // v1.28.x — Strava reads off the same consolidated envelope.
  const stravaViewModel = toOAuthStatus(
    pickStatus(integrationStatus, "strava"),
  );

  return (
    <div className="space-y-6" data-slot="connections-panel">
      {/* Per-provider anchors so deep-links (onboarding "more sources" chips,
          `/settings/integrations#oura`) scroll straight to the right card. */}
      <div id="withings" className="scroll-mt-28">
        <WithingsCard viewModel={withingsViewModel} />
      </div>
      <div id="whoop" className="scroll-mt-28">
        <WhoopCard viewModel={whoopViewModel} />
      </div>
      <div id="fitbit" className="scroll-mt-28">
        <FitbitCard viewModel={fitbitViewModel} />
      </div>
      <div id="google-health" className="scroll-mt-28">
        <GoogleHealthCard viewModel={googleHealthViewModel} />
      </div>
      <div id="apple-health" className="scroll-mt-28">
        <AppleHealthCard enabled={isAuthenticated} />
      </div>
      <div id="polar" className="scroll-mt-28">
        <PolarCard enabled={isAuthenticated} viewModel={polarViewModel} />
      </div>
      <div id="oura" className="scroll-mt-28">
        <OuraCard enabled={isAuthenticated} viewModel={ouraViewModel} />
      </div>
      <div id="strava" className="scroll-mt-28">
        <StravaCard enabled={isAuthenticated} viewModel={stravaViewModel} />
      </div>
      <div id="nightscout" className="scroll-mt-28">
        <NightscoutCard enabled={isAuthenticated} />
      </div>
      {/* Garmin: no direct connector (business-partner-only). A quiet
          non-connector note pointing to the Apple Health / Health Connect
          path — not an OAuthProviderCard (nothing to connect). */}
      <div id="garmin" className="scroll-mt-28">
        <GarminInfoNote />
      </div>
    </div>
  );
}
