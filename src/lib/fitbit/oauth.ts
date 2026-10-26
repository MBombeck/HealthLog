/**
 * The Fitbit Web API OAuth client: consent URL, code exchange and refresh,
 * over the shared factory (`integrations/oauth-kit/client.ts`).
 *
 * S256 PKCE with the confidential client's secret by HTTP Basic beside it.
 * Refresh tokens rotate (one-time use): every answer carries a new refresh
 * token that replaces the stored one. A refusal names itself in
 * `errors[0].errorType`, or in an RFC 6749 `error`.
 */
import {
  defineOAuthClient,
  oauthErrorCode,
  type OAuthClientCredentials,
} from "@/lib/integrations/oauth-kit/client";
import { checkedRedirectUri } from "@/lib/integrations/oauth-kit/redirect-uri";

import { FitbitApiError } from "./response-classifier";

export type FitbitCredentials = OAuthClientCredentials;

/**
 * The classic scopes HealthLog requests, space-separated on the wire. Each is
 * self-serve grantable; `temperature` is left out on purpose (the classic
 * skin-temperature reading is a delta, not an absolute value).
 */
export const FITBIT_OAUTH_SCOPE = [
  "activity",
  "cardio_fitness",
  "heartrate",
  "oxygen_saturation",
  "profile",
  "respiratory_rate",
  "sleep",
  "weight",
].join(" ");

export interface FitbitTokenResponse {
  access_token: string;
  /**
   * Rotates on every answer and must replace the stored one. Optional only to
   * guard a malformed answer.
   */
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  user_id?: string;
}

function fitbitErrorType(body: unknown): string | undefined {
  if (body !== null && typeof body === "object") {
    const first = (body as { errors?: Array<{ errorType?: unknown }> })
      .errors?.[0];
    if (typeof first?.errorType === "string") return first.errorType;
  }
  return oauthErrorCode(body);
}

export const fitbitOAuth = defineOAuthClient<FitbitTokenResponse>({
  service: "fitbit",
  authorizeUrl: "https://www.fitbit.com/oauth2/authorize",
  tokenUrl: "https://api.fitbit.com/oauth2/token",
  redirectUri: () =>
    checkedRedirectUri("Fitbit", "FITBIT_REDIRECT_URI", "/api/fitbit/callback"),
  authorizeParams: () => ({ scope: FITBIT_OAUTH_SCOPE }),
  pkce: true,
  clientAuth: { kind: "basic", idInForm: { exchange: true, refresh: false } },
  refresh: true,
  upstreamError: fitbitErrorType,
  error: (failure) =>
    new FitbitApiError({
      verb: failure.verb,
      classification: failure.classification,
      httpStatus: failure.status,
      reason: failure.reason,
      upstreamError: failure.upstreamError,
    }),
});
