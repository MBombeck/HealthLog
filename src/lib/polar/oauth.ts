/**
 * The Polar AccessLink OAuth client: consent URL and code exchange, over the
 * shared factory (`integrations/oauth-kit/client.ts`).
 *
 * The token endpoint takes HTTP Basic client authentication. Polar access
 * tokens do not expire and there is no refresh token; a revoked grant shows
 * as a refused read. The token answer carries `x_user_id`, Polar's member id,
 * which user registration and direct user lookups still need.
 */
import {
  defineOAuthClient,
  type OAuthClientCredentials,
} from "@/lib/integrations/oauth-kit/client";
import { derivedRedirectUri } from "@/lib/integrations/oauth-kit/redirect-uri";

import { PolarApiError } from "./response-classifier";

export type PolarCredentials = OAuthClientCredentials;

/**
 * `accesslink.read_all` grants every read collection so the person consents
 * once. Space-separated on the wire.
 */
export const POLAR_OAUTH_SCOPE = "accesslink.read_all" as const;

/**
 * The env-configured shared OAuth credentials: the fallback the per-user
 * resolver (`getPolarClientCredentials`) drops to when a user has not stored
 * their own AccessLink app. Null when unconfigured, so the connect route can
 * say the integration is not set up.
 */
export function getPolarCredentials(): PolarCredentials | null {
  const clientId = process.env.POLAR_CLIENT_ID;
  const clientSecret = process.env.POLAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export interface PolarTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  x_user_id: number;
}

export const polarOAuth = defineOAuthClient<PolarTokenResponse>({
  service: "polar",
  authorizeUrl: "https://flow.polar.com/oauth2/authorization",
  tokenUrl: "https://polarremote.com/v2/oauth2/token",
  redirectUri: () =>
    derivedRedirectUri("POLAR_REDIRECT_URI", "/api/polar/callback"),
  authorizeParams: () => ({ scope: POLAR_OAUTH_SCOPE }),
  clientAuth: { kind: "basic", idInForm: { exchange: false, refresh: false } },
  acceptJson: true,
  refresh: false,
  error: (failure) =>
    new PolarApiError({
      verb: failure.verb,
      classification: failure.classification,
      httpStatus: failure.status,
      reason: failure.reason,
      upstreamError: failure.upstreamError,
    }),
});
