"use client";

/**
 * `<ConnectionsPanel>` — the connected-services half of Settings →
 * Integrations: Withings / WHOOP / Fitbit / Polar / Oura / Garmin / Nightscout.
 *
 * v1.18.0 — extracted out of `integrations-section.tsx` so the section
 * file can host the Connections / Channels / Sources sub-tabs without growing
 * unbounded. This panel owns the OAuth-callback toast handlers (the four
 * providers + Withings redirect back here with `?<provider>=…` params) and the
 * card grid. It renders no page header of its own; the parent supplies it.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { AppleHealthCard } from "@/components/settings/integrations/apple-health-card";
import { DawarichCard } from "@/components/settings/integrations/dawarich-card";
import { FitbitRetirementNotice } from "@/components/settings/integrations/fitbit-retirement-notice";
import { GarminCard } from "@/components/settings/integrations/garmin-card";
import { GoogleHealthCard } from "@/components/settings/integrations/google-health-card";
import { IntegrationFallbackRow } from "@/components/settings/integrations/integration-fallback-row";
import { NightscoutCard } from "@/components/settings/integrations/nightscout-card";
import {
  OAUTH_INTEGRATIONS,
  OAuthIntegrationCard,
} from "@/components/settings/integrations/oauth-integration-card";
import {
  pickStatus,
  useIntegrationStatuses,
  type IntegrationKey,
} from "@/components/settings/integrations/shared";
import { Badge } from "@/components/ui/badge";
import { TagChip } from "@/components/ui/tag-chip";
import { useAuth } from "@/hooks/use-auth";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { dropParams, writeUrlState } from "@/lib/url-state";

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
  already_linked: "settings.withingsOauthError.already_linked",
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
 * v1.32.36 — the error-copy subtree per provider, spelled out rather than
 * interpolated from the provider id. Building the key from the bare `settings`
 * root left the reverse-i18n guard with no anchor deeper than the namespace,
 * which marked every key under `settings.*` reachable and let genuinely dead
 * copy sit in the bundle unnoticed. Written out, each base is a full node path
 * the guard resolves on its own.
 */
const OAUTH_ERROR_KEY_BASE: Record<OAuthOutcomeProvider, string> = {
  polar: "settings.polarOauthError",
  oura: "settings.ouraOauthError",
  whoop: "settings.whoopOauthError",
  fitbit: "settings.fitbitOauthError",
  googleHealth: "settings.googleHealthOauthError",
  strava: "settings.stravaOauthError",
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
  // The provider account is already connected to another record.
  "already_linked",
]);

/**
 * Reason tags only one provider's callback emits, with copy under that
 * provider's subtree alone. Oura's `issuer`: the authorization response named
 * an issuer that is not Oura's (RFC 9207), so the callback refused the code.
 */
const PROVIDER_ONLY_REASONS: Partial<
  Record<OAuthOutcomeProvider, ReadonlySet<string>>
> = {
  oura: new Set(["issuer"]),
  // Fitbit's `retired`: Google has turned the Web API off, so the connect
  // route refuses a new grant.
  fitbit: new Set(["retired"]),
};

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
  const base = OAUTH_ERROR_KEY_BASE[provider];
  return OAUTH_OUTCOME_REASONS.has(reason) ||
    PROVIDER_ONLY_REASONS[provider]?.has(reason)
    ? `${base}.${reason}`
    : `${base}.generic`;
}

/**
 * The keys a bespoke card on this panel renders. Every OTHER configured
 * envelope entry falls through to `IntegrationFallbackRow` — the panel's unit
 * of coverage is the envelope entry, not the card, so a provider can never
 * again be shipped on the wire and rendered nowhere.
 */
const CARD_BACKED_INTEGRATIONS: ReadonlySet<IntegrationKey> = new Set([
  "withings",
  "whoop",
  "fitbit",
  "google-health",
  "polar",
  "oura",
  "strava",
  "nightscout",
  "dawarich",
  "garmin",
]);

export function ConnectionsPanel({
  callbackUrls,
}: {
  /**
   * The per-provider OAuth callback URLs, resolved on the server per request
   * (`getIntegrationCallbackUrls`) and threaded down from the route. A client
   * module cannot derive them: `NEXT_PUBLIC_APP_URL` is inlined at build
   * time and absent from the published image.
   */
  callbackUrls: IntegrationCallbackUrls;
}) {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();
  // Dawarich is part of the environment module, which is opt-in.
  const environmentOn = user?.modules?.environment === true;
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: integrationStatus } = useIntegrationStatuses(isAuthenticated);
  const fitbitStatus = pickStatus(integrationStatus, "fitbit");
  const fitbitRetired = fitbitStatus?.retirement?.ended === true;

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
    writeUrlState(dropParams("withings", "reason"), { afterPaint: true });
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
      showErrorToast(t("settings.withingsOauthFailed"), {
        description: t(reasonKey),
        duration: 10_000,
      });
    }
  }, [withingsOauthOutcome, router, queryClient, t]);

  // v1.17.0 — generic OAuth-callback toast for the OAuth providers.
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
    writeUrlState(dropParams(provider, "reason"), { afterPaint: true });
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
      showErrorToast(t(`settings.${provider}OauthFailed`), {
        description: t(oauthReasonKey(provider, oauthOutcome.reason)),
        duration: 10_000,
      });
    }
  }, [oauthOutcome, router, queryClient, t]);

  const unclaimedIntegrations = (integrationStatus?.integrations ?? [])
    .filter(
      (entry) =>
        // With the environment module off the Dawarich card is not shown, so
        // a connection still stored falls through to the read-only row.
        !(
          CARD_BACKED_INTEGRATIONS.has(entry.integration) &&
          (entry.integration !== "dawarich" || environmentOn)
        ) &&
        (entry.configured || entry.connected),
    )
    .map((entry) => ({
      ...entry,
      failureThreshold: integrationStatus?.threshold,
    }));

  return (
    <div className="space-y-6" data-slot="connections-panel">
      {/* Per-provider anchors so deep-links (onboarding "more sources" chips,
          `/settings/integrations#oura`) scroll straight to the right card. */}
      <div id="withings" className="scroll-mt-28">
        <OAuthIntegrationCard
          config={OAUTH_INTEGRATIONS.withings}
          viewModel={pickStatus(integrationStatus, "withings")}
          callbackUrl={callbackUrls.withings}
        />
      </div>
      <div id="whoop" className="scroll-mt-28">
        <OAuthIntegrationCard
          config={OAUTH_INTEGRATIONS.whoop}
          viewModel={pickStatus(integrationStatus, "whoop")}
          callbackUrl={callbackUrls.whoop}
        />
      </div>
      {/* After the turndown the card is offered only to an account that had
          Fitbit; the server decides (`retirement.offered`). */}
      {fitbitStatus?.retirement?.offered !== false && (
        <div id="fitbit" className="scroll-mt-28">
          <FitbitRetirementNotice retirement={fitbitStatus?.retirement} />
          <OAuthIntegrationCard
            config={OAUTH_INTEGRATIONS.fitbit}
            viewModel={fitbitStatus}
            callbackUrl={callbackUrls.fitbit}
            syncDisabled={fitbitRetired}
            connectDisabled={fitbitRetired}
            titleAccessory={
              <>
                <TagChip>{t("settings.fitbitTag")}</TagChip>
                {fitbitStatus?.retirement ? (
                  <Badge
                    variant="outline"
                    data-testid="fitbit-retirement-badge"
                    className="border-warning/50 text-warning"
                  >
                    {fitbitRetired
                      ? t("settings.fitbitRetirement.badgeEnded")
                      : t("settings.fitbitRetirement.badgeEnding")}
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    data-testid="fitbit-experimental-badge"
                    className="border-warning/50 text-warning"
                  >
                    {t("settings.fitbitExperimentalBadge")}
                  </Badge>
                )}
              </>
            }
          />
        </div>
      )}
      <div id="google-health" className="scroll-mt-28">
        <GoogleHealthCard
          viewModel={pickStatus(integrationStatus, "google-health")}
          callbackUrl={callbackUrls["google-health"]}
        />
      </div>
      <div id="apple-health" className="scroll-mt-28">
        <AppleHealthCard enabled={isAuthenticated} />
      </div>
      <div id="polar" className="scroll-mt-28">
        <OAuthIntegrationCard
          config={OAUTH_INTEGRATIONS.polar}
          viewModel={pickStatus(integrationStatus, "polar")}
          callbackUrl={callbackUrls.polar}
        />
      </div>
      <div id="oura" className="scroll-mt-28">
        <OAuthIntegrationCard
          config={OAUTH_INTEGRATIONS.oura}
          viewModel={pickStatus(integrationStatus, "oura")}
          callbackUrl={callbackUrls.oura}
        />
      </div>
      <div id="strava" className="scroll-mt-28">
        <OAuthIntegrationCard
          config={OAUTH_INTEGRATIONS.strava}
          viewModel={pickStatus(integrationStatus, "strava")}
          callbackUrl={callbackUrls.strava}
        />
      </div>
      <div id="garmin" className="scroll-mt-28">
        <GarminCard viewModel={pickStatus(integrationStatus, "garmin")} />
      </div>
      <div id="nightscout" className="scroll-mt-28">
        <NightscoutCard
          viewModel={pickStatus(integrationStatus, "nightscout")}
        />
      </div>
      {environmentOn ? (
        <div id="dawarich" className="scroll-mt-28">
          <DawarichCard viewModel={pickStatus(integrationStatus, "dawarich")} />
        </div>
      ) : null}
      {/* Every configured envelope entry no card above claims. Normally this
          renders nothing; on an account carrying a dropped-but-still-running
          integration it renders the honest status that provider otherwise has
          nowhere to appear. */}
      {unclaimedIntegrations.map((entry) => (
        <div
          key={entry.integration}
          id={entry.integration}
          className="scroll-mt-28"
        >
          <IntegrationFallbackRow status={entry} />
        </div>
      ))}
    </div>
  );
}
