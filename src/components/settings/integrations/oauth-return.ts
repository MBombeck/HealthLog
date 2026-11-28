"use client";

/**
 * The OAuth return to Settings → Integrations: Withings, WHOOP, Google Health,
 * Polar, Oura and Strava redirect back with `?<provider>=connected` or
 * `?<provider>=error&reason=<tag>`. This module reads that outcome and says
 * how it went.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

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
 * per-card status query; WHOOP reads off the consolidated envelope — both
 * are invalidated on a successful return so the card repaints either way.
 */
// Google Health's callback redirects with
// `?googleHealth=connected|error&reason=<tag>`, and the i18n toast keys resolve under the same camelCase
// prefix (`settings.googleHealthOauth*`).
const OAUTH_OUTCOME_PROVIDERS = [
  "polar",
  "oura",
  "whoop",
  "googleHealth",
  // Strava redirects with `?strava=connected|error&reason=…`.
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
  googleHealth: queryKeys.googleHealth,
  strava: queryKeys.strava,
};

/**
 * The error-copy subtree per provider, spelled out rather than
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
  googleHealth: "settings.googleHealthOauthError",
  strava: "settings.stravaOauthError",
};

/**
 * Reason tags the four OAuth callbacks emit. Known tags resolve to a specific
 * message; anything else falls back to the provider's `generic` copy. Union of
 * the Polar/Oura set (`rate_limited`) and the WHOOP set (`expired`).
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
 * The OAuth callbacks redirect back to Settings → Integrations with a one-shot
 * outcome param. Read it once, say how it went in a toast, refresh the
 * statuses, and scrub the params so a reload does not replay the toast.
 */
export function useOAuthReturnToasts() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Withings keeps its own reason set (`?withings=connected|error&reason=…`).
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
  }, [withingsOauthOutcome, queryClient, t]);

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
      // Polar/Oura own a per-card status query; WHOOP reads off the
      // consolidated envelope: invalidate both so either repaints.
      queryClient.invalidateQueries({
        queryKey: OAUTH_OUTCOME_KEYS[provider](),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    } else {
      showErrorToast(t(`settings.${provider}OauthFailed`), {
        description: t(oauthReasonKey(provider, oauthOutcome.reason)),
        duration: 10_000,
      });
    }
  }, [oauthOutcome, queryClient, t]);
}
