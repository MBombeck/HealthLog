/**
 * The Strava OAuth client: consent URL, code exchange, refresh and
 * deauthorization, over the shared factory
 * (`integrations/oauth-kit/client.ts`).
 *
 * Strava rotates its refresh token on every refresh; the token lifecycle
 * persists both. Its token endpoint does not answer in RFC 6749 form: a
 * refusal is the API's generic `Fault`, reduced by `stravaFaultSummary` so the
 * classifier can tell a dead refresh token (`RefreshToken.refresh_token:…`)
 * from a misconfigured app. The exchange carries no `redirect_uri`.
 */
import {
  defineOAuthClient,
  type OAuthClientCredentials,
} from "@/lib/integrations/oauth-kit/client";
import { derivedRedirectUri } from "@/lib/integrations/oauth-kit/redirect-uri";

import { StravaApiError, stravaFaultSummary } from "./response-classifier";

export type StravaCredentials = OAuthClientCredentials;

/**
 * `activity:read_all` reads every activity including those marked "only me"
 * (`activity:read` omits private ones). Comma-separated on the wire.
 */
export const STRAVA_OAUTH_SCOPE = "activity:read_all" as const;

/** Strava's `SummaryAthlete`: only the numeric id is kept (the account pin). */
export interface StravaAthlete {
  id?: number | null;
}

export interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  athlete?: StravaAthlete | null;
}

export const stravaOAuth = defineOAuthClient<StravaTokenResponse>({
  service: "strava",
  authorizeUrl: "https://www.strava.com/oauth/authorize",
  tokenUrl: "https://www.strava.com/oauth/token",
  deauthorizeUrl: "https://www.strava.com/oauth/deauthorize",
  redirectUri: () =>
    derivedRedirectUri("STRAVA_REDIRECT_URI", "/api/strava/callback"),
  authorizeParams: () => ({
    approval_prompt: "auto",
    scope: STRAVA_OAUTH_SCOPE,
  }),
  clientAuth: { kind: "form" },
  acceptJson: true,
  exchangeRedirectUri: false,
  refresh: true,
  upstreamError: stravaFaultSummary,
  error: (failure) =>
    new StravaApiError({
      verb: failure.verb,
      classification: failure.classification,
      httpStatus: failure.status,
      reason: failure.reason,
      upstreamError: failure.upstreamError,
    }),
});

/**
 * Env-configured shared OAuth credentials — the FALLBACK app used when a user
 * has not registered their own BYO Strava client id/secret. The per-user
 * resolver `getStravaClientCredentials` (DB-first) is the primary path and
 * calls this only when no per-user pair is stored.
 */
export function getStravaCredentials(): StravaCredentials | null {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
