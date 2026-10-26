/**
 * The Google Health OAuth client: consent URL, code exchange and refresh,
 * over the shared factory (`integrations/oauth-kit/client.ts`).
 *
 *   - Access tokens live an hour. Refresh tokens do not rotate: a routine
 *     refresh returns a new access token without a refresh token, and the
 *     token lifecycle keeps the stored one. They expire after six months of
 *     disuse, or after seven days while the consent screen is in "Testing".
 *   - A revoked or expired refresh token answers `invalid_grant` (a 400 or a
 *     401); it is lifted onto `reauth_required` so the connection asks for a
 *     reconnect instead of failing hard.
 *   - S256 PKCE, and the confidential client's secret by HTTP Basic beside it
 *     (RFC 6749 2.3.1), with the client id in the form as well.
 *   - `access_type=offline` and `prompt=consent` are what reliably return a
 *     refresh token, a new one on every re-consent.
 */
import {
  defineOAuthClient,
  oauthErrorCode,
  type OAuthClientCredentials,
} from "@/lib/integrations/oauth-kit/client";
import { checkedRedirectUri } from "@/lib/integrations/oauth-kit/redirect-uri";
import { classifyHttpStatus } from "@/lib/integrations/http-status-classifier";

import { GoogleHealthApiError } from "./response-classifier";

export type GoogleHealthCredentials = OAuthClientCredentials;

/**
 * The four core Restricted read scopes. Every one is Restricted, so the
 * operator's OAuth client needs Google verification and a yearly CASA
 * assessment before it leaves "Testing" (staying in Testing with at most 100
 * test users avoids CASA at the cost of a 7-day refresh-token expiry).
 */
export const GOOGLE_HEALTH_CORE_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
] as const;

/**
 * The scope list HealthLog requests: the four core bundles. ECG and IRN come
 * with their reader, never before (Google penalises requesting a Restricted
 * scope the app never consumes).
 */
export function resolveGoogleHealthScopes(): string[] {
  return [...GOOGLE_HEALTH_CORE_SCOPES];
}

/** The space-separated scope string sent on the authorize request. */
export function getGoogleHealthScopeString(): string {
  return resolveGoogleHealthScopes().join(" ");
}

export interface GoogleHealthTokenResponse {
  access_token: string;
  /**
   * Present on the code exchange and whenever Google issues a new refresh
   * token; absent on a routine refresh, because Google does not rotate.
   */
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export const googleHealthOAuth = defineOAuthClient<GoogleHealthTokenResponse>({
  service: "google-health",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  redirectUri: () =>
    checkedRedirectUri(
      "Google Health",
      "GOOGLE_HEALTH_REDIRECT_URI",
      "/api/google-health/callback",
    ),
  authorizeParams: () => ({
    scope: getGoogleHealthScopeString(),
    access_type: "offline",
    prompt: "consent",
  }),
  pkce: true,
  clientAuth: { kind: "basic", idInForm: { exchange: true, refresh: true } },
  refresh: true,
  classify: (httpStatus, body) => {
    const verdict = classifyHttpStatus(httpStatus);
    return {
      classification:
        oauthErrorCode(body) === "invalid_grant"
          ? "reauth_required"
          : verdict.classification,
      status: verdict.httpStatus,
      reason: verdict.reason,
    };
  },
  error: (failure) =>
    new GoogleHealthApiError({
      verb: failure.verb,
      classification: failure.classification,
      httpStatus: failure.status,
      reason: failure.reason,
      upstreamError: failure.upstreamError,
    }),
});
