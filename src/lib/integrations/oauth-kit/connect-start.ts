/**
 * Starting an OAuth connect: resolve the record's provider app, mint the
 * state, and build the consent URL. One implementation for every way a
 * connect starts, the person's own browser navigation (`GET
 * /api/<provider>/connect`) and a guardian's request for a managed profile
 * (`POST /api/record-settings/integrations/<provider>/connect`).
 *
 * The state names exactly one record, `userId`, and is either HMAC-signed
 * (Oura, Polar, Strava; `src/lib/oauth/signed-state.ts`) or a ten-minute
 * server-side ledger row (Withings, WHOOP, Google Health). It is set twice:
 * as the `state` URL parameter and as an httpOnly cookie, and the callback
 * requires both to agree before anything else.
 */
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { getEvent } from "@/lib/logging/context";
import {
  OAUTH_STATE_TTL_MS,
  mintSignedState,
  oauthStateCookieName,
} from "@/lib/oauth/signed-state";
import { withingsOAuth } from "@/lib/withings/oauth";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import {
  WITHINGS_OAUTH_STATE_COOKIE,
  WITHINGS_OAUTH_STATE_TTL_MS,
  mintWithingsOAuthStateNonce,
} from "@/lib/withings/oauth-state";
import { whoopOAuth } from "@/lib/whoop/oauth";
import { getUserWhoopCredentials } from "@/lib/whoop/credentials";
import {
  WHOOP_OAUTH_STATE_COOKIE,
  WHOOP_OAUTH_STATE_TTL_MS,
  mintWhoopOAuthStateNonce,
} from "@/lib/whoop/oauth-state";
import { googleHealthOAuth } from "@/lib/google-health/oauth";
import { generatePkcePair } from "./pkce";
import { getUserGoogleHealthCredentials } from "@/lib/google-health/credentials";
import {
  GOOGLE_HEALTH_OAUTH_STATE_COOKIE,
  GOOGLE_HEALTH_OAUTH_STATE_TTL_MS,
  mintGoogleHealthOAuthStateNonce,
} from "@/lib/google-health/oauth-state";
import { ouraOAuth } from "@/lib/oura/oauth";
import { getOuraClientCredentials } from "@/lib/oura/credentials";
import { polarOAuth } from "@/lib/polar/oauth";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import { stravaOAuth } from "@/lib/strava/oauth";
import { getStravaClientCredentials } from "@/lib/strava/credentials";
import type { OAuthKitProvider } from "./token";

export interface ConnectStateCookie {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
}

export type ConnectStartResult =
  | {
      readonly ok: true;
      readonly authorizationUrl: string;
      readonly cookie: ConnectStateCookie;
    }
  | {
      readonly ok: false;
      /** `nocreds`: no provider app; `connect`: the state could not be stored. */
      readonly reason: "nocreds" | "connect";
    };

export interface ConnectStartOptions {
  /** WHOOP only: a validated native return scheme, carried on the ledger row. */
  readonly returnScheme?: string | null;
}

/** Can the record resolve a provider app (its own or the deployment's)? */
export async function recordHasClientApp(
  provider: OAuthKitProvider,
  userId: string,
): Promise<boolean> {
  switch (provider) {
    case "withings":
      return (await getUserWithingsCredentials(userId)) !== null;
    case "whoop":
      return (await getUserWhoopCredentials(userId)) !== null;
    case "google-health":
      return (await getUserGoogleHealthCredentials(userId)) !== null;
    case "oura":
      return (await getOuraClientCredentials(userId)) !== null;
    case "polar":
      return (await getPolarClientCredentials(userId)) !== null;
    case "strava":
      return (await getStravaClientCredentials(userId)) !== null;
  }
}

function signedStart(
  provider: "oura" | "polar" | "strava",
  userId: string,
  url: (state: string) => string,
): ConnectStartResult {
  const state = mintSignedState(provider, userId);
  return {
    ok: true,
    authorizationUrl: url(state),
    cookie: {
      name: oauthStateCookieName(provider),
      value: state,
      maxAgeSeconds: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    },
  };
}

async function ledgerStart(
  write: () => Promise<unknown>,
  cookie: ConnectStateCookie,
  url: () => string,
): Promise<ConnectStartResult> {
  try {
    await write();
  } catch (err) {
    getEvent()?.setError(err);
    return { ok: false, reason: "connect" };
  }
  return { ok: true, authorizationUrl: url(), cookie };
}

/** Mint the state for `userId` and build the provider's consent URL. */
export async function startOAuthConnect(
  provider: OAuthKitProvider,
  userId: string,
  opts: ConnectStartOptions = {},
): Promise<ConnectStartResult> {
  switch (provider) {
    case "withings": {
      const creds = await getUserWithingsCredentials(userId);
      if (!creds) return { ok: false, reason: "nocreds" };
      const nonce = mintWithingsOAuthStateNonce();
      return ledgerStart(
        () =>
          prisma.withingsOAuthState.create({
            data: {
              nonce,
              userId,
              expiresAt: new Date(Date.now() + WITHINGS_OAUTH_STATE_TTL_MS),
            },
          }),
        {
          name: WITHINGS_OAUTH_STATE_COOKIE,
          value: nonce,
          maxAgeSeconds: Math.floor(WITHINGS_OAUTH_STATE_TTL_MS / 1000),
        },
        () => withingsOAuth.authorizationUrl(nonce, creds),
      );
    }
    case "whoop": {
      const creds = await getUserWhoopCredentials(userId);
      if (!creds) return { ok: false, reason: "nocreds" };
      const nonce = mintWhoopOAuthStateNonce();
      return ledgerStart(
        () =>
          prisma.whoopOAuthState.create({
            data: {
              nonce,
              userId,
              expiresAt: new Date(Date.now() + WHOOP_OAUTH_STATE_TTL_MS),
              returnScheme: opts.returnScheme ?? null,
            },
          }),
        {
          name: WHOOP_OAUTH_STATE_COOKIE,
          value: nonce,
          maxAgeSeconds: Math.floor(WHOOP_OAUTH_STATE_TTL_MS / 1000),
        },
        () => whoopOAuth.authorizationUrl(nonce, creds),
      );
    }
    case "google-health": {
      const creds = await getUserGoogleHealthCredentials(userId);
      if (!creds) return { ok: false, reason: "nocreds" };
      const nonce = mintGoogleHealthOAuthStateNonce();
      const { verifier, challenge } = generatePkcePair();
      return ledgerStart(
        () =>
          prisma.googleHealthOAuthState.create({
            data: {
              nonce,
              userId,
              codeVerifier: verifier,
              expiresAt: new Date(
                Date.now() + GOOGLE_HEALTH_OAUTH_STATE_TTL_MS,
              ),
            },
          }),
        {
          name: GOOGLE_HEALTH_OAUTH_STATE_COOKIE,
          value: nonce,
          maxAgeSeconds: Math.floor(GOOGLE_HEALTH_OAUTH_STATE_TTL_MS / 1000),
        },
        () => googleHealthOAuth.authorizationUrl(nonce, creds, challenge),
      );
    }
    case "oura": {
      const creds = await getOuraClientCredentials(userId);
      if (!creds) return { ok: false, reason: "nocreds" };
      return signedStart("oura", userId, (s) =>
        ouraOAuth.authorizationUrl(s, creds),
      );
    }
    case "polar": {
      const creds = await getPolarClientCredentials(userId);
      if (!creds) return { ok: false, reason: "nocreds" };
      return signedStart("polar", userId, (s) =>
        polarOAuth.authorizationUrl(s, creds),
      );
    }
    case "strava": {
      const creds = await getStravaClientCredentials(userId);
      if (!creds) return { ok: false, reason: "nocreds" };
      return signedStart("strava", userId, (s) =>
        stravaOAuth.authorizationUrl(s, creds),
      );
    }
  }
}

/** Set the state cookie a started connect needs on its response. */
export function setConnectStateCookie(
  response: NextResponse,
  cookie: ConnectStateCookie,
): NextResponse {
  response.cookies.set(cookie.name, cookie.value, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    sameSite: "lax",
    maxAge: cookie.maxAgeSeconds,
    path: "/",
  });
  return response;
}
