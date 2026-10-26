/**
 * The Oura OAuth client: consent URL, code exchange and refresh, over the
 * shared factory (`integrations/oauth-kit/client.ts`).
 *
 * Standard authorization code with refresh tokens; Oura rotates the refresh
 * token on every use, and the sync refreshes after a refused read. The client
 * id and secret ride in the form (client_secret_post).
 *
 * Two token endpoints. Apps created in the current developer portal get their
 * codes from the authorization server on moi.ouraring.com (the callback
 * carries `iss=https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous`), and the
 * documented `api.ouraring.com/oauth/token` answers those codes with
 * `400 invalid_request`. The live endpoint is always asked first; the legacy
 * one only after the live one refused with 400, 401 or 404, which may mean
 * "unknown here" for an older app. A code from the current server goes to the
 * live endpoint only: an authorization code works once (RFC 6749 4.1.2), so a
 * second attempt elsewhere could never succeed. A refused refresh does not
 * consume the token, so its retry is safe. Server errors and rate limits are
 * never retried elsewhere: they say nothing about the grant.
 */
import {
  defineOAuthClient,
  type OAuthClientCredentials,
} from "@/lib/integrations/oauth-kit/client";
import { derivedRedirectUri } from "@/lib/integrations/oauth-kit/redirect-uri";

import { OuraApiError } from "./response-classifier";
import { OURA_OAUTH_SCOPE } from "./scope";

export type OuraCredentials = OAuthClientCredentials;

/** Oura's live token endpoint. */
export const OURA_OAUTH_TOKEN_URL =
  "https://moi.ouraring.com/oauth/v2/ext/oauth-token";

/** The documented endpoint, kept only as the fallback for older apps. */
export const OURA_OAUTH_LEGACY_TOKEN_URL =
  "https://api.ouraring.com/oauth/token";

/** The origin of Oura's current authorization server. */
const OURA_MOI_ORIGIN = "https://moi.ouraring.com";

/**
 * Authorization-server origins an `iss` callback parameter may name
 * (RFC 9207). Anything else is a mix-up and refused.
 */
const OURA_ISSUER_ORIGINS = new Set([
  OURA_MOI_ORIGIN,
  "https://cloud.ouraring.com",
  "https://api.ouraring.com",
]);

/**
 * Check the `iss` the authorization server sent with the callback. Absent is
 * fine (older apps never send one); present, it must name one of Oura's own
 * authorization servers.
 */
export function isAcceptedOuraIssuer(iss: string | null): boolean {
  if (iss === null) return true;
  try {
    const url = new URL(iss);
    return url.protocol === "https:" && OURA_ISSUER_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

/** True when the code was issued by the current authorization server. */
function issuedByMoi(iss: string | null | undefined): boolean {
  if (!iss) return false;
  try {
    return new URL(iss).origin === OURA_MOI_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Env-configured shared OAuth credentials: the fallback app used when a user
 * has not registered their own client id and secret. The per-user resolver
 * `getOuraClientCredentials` (database first) is the primary path.
 */
export function getOuraCredentials(): OuraCredentials | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export const ouraOAuth = defineOAuthClient<OuraTokenResponse>({
  service: "oura",
  authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
  tokenUrl: OURA_OAUTH_TOKEN_URL,
  legacyTokenUrl: {
    url: OURA_OAUTH_LEGACY_TOKEN_URL,
    retryOn: new Set([400, 401, 404]),
  },
  redirectUri: () =>
    derivedRedirectUri("OURA_REDIRECT_URI", "/api/oura/callback"),
  // The scopes come from `./scope`, which maps every collection HealthLog
  // reads to the scope Oura enforces for it. A grant from before a scope was
  // added keeps the old set until the person reconnects once.
  authorizeParams: () => ({ scope: OURA_OAUTH_SCOPE }),
  clientAuth: { kind: "form" },
  acceptJson: true,
  refresh: true,
  error: (failure) =>
    new OuraApiError({
      verb: failure.verb,
      classification: failure.classification,
      httpStatus: failure.status,
      reason: failure.reason,
      upstreamError: failure.upstreamError,
    }),
});

/**
 * Exchange an authorization code. `iss` is the callback's issuer parameter: a
 * code from the current authorization server goes to the live endpoint only.
 */
export function exchangeOuraCode(
  code: string,
  credentials: OuraCredentials,
  iss?: string | null,
): Promise<OuraTokenResponse> {
  return ouraOAuth.exchange(code, credentials, {
    useLegacyEndpoint: !issuedByMoi(iss),
  });
}
