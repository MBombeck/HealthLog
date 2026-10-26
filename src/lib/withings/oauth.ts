/**
 * The Withings OAuth client: consent URL, code exchange and refresh, over the
 * shared factory (`integrations/oauth-kit/client.ts`).
 *
 * Withings answers HTTP 200 with the real status inside the body
 * (`{ status, body, error }`), so its answers are classified by
 * `classifyWithingsResponse`, the token sits under `body`, and every token
 * request names `action=requesttoken`. A failure is filed under the verbs
 * `token` and `refresh`.
 */
import {
  defineOAuthClient,
  type OAuthClientCredentials,
} from "@/lib/integrations/oauth-kit/client";
import { derivedRedirectUri } from "@/lib/integrations/oauth-kit/redirect-uri";

import {
  WithingsApiError,
  classifyWithingsResponse,
  type WithingsBodyLike,
} from "./response-classifier";

export type WithingsCredentials = OAuthClientCredentials;

/**
 * The scope set HealthLog requests:
 *
 *   - `user.metrics`  : every meastype the Measure, Heart-list and Sleep
 *                       endpoints expose (weight, BP, pulse, SpO2, body
 *                       composition, temperature, VO2 max, ...)
 *   - `user.activity` : steps, active energy, distance, floors.
 *
 * A connection granted `user.metrics` only (or with no stored scope) is shown
 * a reconnect banner on the integrations card.
 */
export const WITHINGS_OAUTH_SCOPE = "user.metrics,user.activity" as const;

/**
 * The persisted scope string as a set. A legacy NULL is the empty set, so the
 * reconnect-banner condition reads true.
 */
export function parseWithingsScope(scope: string | null): Set<string> {
  if (!scope) return new Set();
  return new Set(
    scope
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Whether the grant holds `user.activity`, which Activity and Sleep need. */
export function hasActivityScope(scope: string | null): boolean {
  return parseWithingsScope(scope).has("user.activity");
}

export interface WithingsTokenResponse {
  userid: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function withingsError(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

export const withingsOAuth = defineOAuthClient<WithingsTokenResponse>({
  service: "withings",
  authorizeUrl: "https://account.withings.com/oauth2_user/authorize2",
  tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
  redirectUri: () =>
    derivedRedirectUri("WITHINGS_REDIRECT_URI", "/api/withings/callback"),
  authorizeParams: () => ({ scope: WITHINGS_OAUTH_SCOPE }),
  clientAuth: { kind: "form" },
  extraFields: {
    exchange: { action: "requesttoken" },
    refresh: { action: "requesttoken" },
  },
  refresh: true,
  classify: (httpStatus, body) => {
    const verdict = classifyWithingsResponse(
      httpStatus,
      body as WithingsBodyLike | null,
    );
    return {
      classification: verdict.classification,
      status: verdict.withingsStatus,
      reason: verdict.reason,
    };
  },
  upstreamError: withingsError,
  failureVerb: { exchange: "token", refresh: "refresh" },
  error: (failure) =>
    new WithingsApiError({
      verb: failure.verb,
      classification: failure.classification,
      withingsStatus: failure.status,
      reason: failure.reason,
      upstreamError: failure.upstreamError,
    }),
  tokenOf: (body) =>
    body !== null && typeof body === "object"
      ? (body as { body?: unknown }).body
      : null,
});
