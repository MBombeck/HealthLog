/**
 * The WHOOP OAuth client: consent URL, code exchange and refresh, over the
 * shared factory (`integrations/oauth-kit/client.ts`).
 *
 * Token TTL is 3600 s and refresh tokens rotate: each refresh invalidates the
 * prior access and refresh token, so the token lifecycle persists both. The
 * `offline` scope is what returns a refresh token at all, and WHOOP wants it
 * re-sent on the refresh.
 */
import {
  defineOAuthClient,
  type OAuthClientCredentials,
} from "@/lib/integrations/oauth-kit/client";
import { derivedRedirectUri } from "@/lib/integrations/oauth-kit/redirect-uri";

import { WhoopApiError } from "./response-classifier";

export type WhoopCredentials = OAuthClientCredentials;

/**
 * Space-separated on the wire. `offline` is mandatory for a refresh token;
 * the rest are the read-only collection scopes, all requested so the person
 * grants once.
 */
export const WHOOP_OAUTH_SCOPE =
  "offline read:recovery read:sleep read:workout read:cycles read:profile read:body_measurement" as const;

export interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export const whoopOAuth = defineOAuthClient<WhoopTokenResponse>({
  service: "whoop",
  authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
  tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
  redirectUri: () =>
    derivedRedirectUri("WHOOP_REDIRECT_URI", "/api/whoop/callback"),
  authorizeParams: () => ({ scope: WHOOP_OAUTH_SCOPE }),
  clientAuth: { kind: "form" },
  extraFields: { refresh: { scope: "offline" } },
  refresh: true,
  error: (failure) =>
    new WhoopApiError({
      verb: failure.verb,
      classification: failure.classification,
      httpStatus: failure.status,
      reason: failure.reason,
      upstreamError: failure.upstreamError,
    }),
});
