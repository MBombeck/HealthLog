/**
 * The one OAuth client every provider integration speaks through: the
 * authorization URL, the code exchange, the refresh, and (Strava) the
 * deauthorization, with the token endpoint's answer classified the same way
 * for every provider.
 *
 * A provider declares what differs (`OAuthClientConfig`): its endpoints and
 * scope, how its client authenticates (credentials in the form, or HTTP Basic
 * with or without the client id beside it), the fields its grants add, how
 * it classifies an answer and names the upstream refusal, the error type it
 * throws, and where the token sits in the body. Everything else is here once:
 * the form post, the external-call line on the wide event, the refusal
 * becoming the provider's own classified error, and a 2xx without a token
 * object (a captive portal, a gateway 200, a 204) becoming a transient
 * `empty_token_body` failure instead of a null the caller dereferences.
 *
 * The token lifecycle (when to refresh, under which lock, writing the grant
 * back) is `token.ts`; this module is the wire.
 *
 * `__tests__/oauth-wire-parity.test.ts` pins what every provider puts on the
 * wire and makes of each answer against the hand-written clients this
 * replaced.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import {
  classifyHttpStatus,
  type IntegrationClassification,
} from "@/lib/integrations/http-status-classifier";

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** A provider's verdict on one token-endpoint answer. */
export interface TokenVerdict {
  classification: IntegrationClassification;
  /** The status that drove it: HTTP, or a provider's in-body status. */
  status: number | undefined;
  reason: string;
}

/** What the provider's error type is built from. */
export interface TokenFailure extends TokenVerdict {
  verb: string;
  upstreamError: string | undefined;
}

type FormFields = Readonly<Record<string, string>>;

export interface OAuthClientConfig {
  /** The service name on the wide event's external-call line. */
  service: string;
  authorizeUrl: string;
  tokenUrl: string;
  /**
   * A second token endpoint asked after the first refused (Oura's legacy
   * one). Never asked first: an authorization code works once.
   */
  legacyTokenUrl?: {
    url: string;
    /** HTTP statuses of the first answer that send the request on. */
    retryOn: ReadonlySet<number>;
  };
  redirectUri: () => string;
  /** Query parameters of the authorization URL after the client and redirect. */
  authorizeParams: () => FormFields;
  /** S256 PKCE: the authorization URL carries the challenge, the exchange the verifier. */
  pkce?: boolean;
  /**
   * How the client authenticates at the token endpoint: its id and secret in
   * the form, or HTTP Basic, with the id also in the form for the grants
   * named.
   */
  clientAuth:
    | { kind: "form" }
    | { kind: "basic"; idInForm: { exchange: boolean; refresh: boolean } };
  /** Send `Accept: application/json` with the token request. */
  acceptJson?: boolean;
  /** Whether the exchange repeats the redirect URI (RFC 6749 4.1.3). Default true. */
  exchangeRedirectUri?: boolean;
  /** Fields a grant adds to the form (Withings' `action`, WHOOP's `scope`). */
  extraFields?: { exchange?: FormFields; refresh?: FormFields };
  /** Whether the provider issues refresh tokens at all. */
  refresh: boolean;
  /** Classify one answer. Default: the HTTP status alone. */
  classify?: (httpStatus: number, body: unknown) => TokenVerdict;
  /** The provider's own name for a refusal, read from the body. */
  upstreamError?: (body: unknown) => string | undefined;
  /** The verb a failure is filed under, when it differs from the call's. */
  failureVerb?: { exchange?: string; refresh?: string };
  /** Build the provider's error type. */
  error: (failure: TokenFailure) => Error;
  /** The token object inside the answer. Default: the body itself. */
  tokenOf?: (body: unknown) => unknown;
  /** Best-effort deauthorization at the provider (Strava). */
  deauthorizeUrl?: string;
}

export interface OAuthClient<Token> {
  readonly redirectUri: () => string;
  /** The browser redirect to the consent screen; `state` is the CSRF nonce. */
  authorizationUrl(
    state: string,
    credentials: OAuthClientCredentials,
    codeChallenge?: string,
  ): string;
  /**
   * Exchange an authorization code. `codeVerifier` is the PKCE verifier;
   * `useLegacyEndpoint` is false when the code is known to come from the
   * current authorization server, so a refusal is final.
   */
  exchange(
    code: string,
    credentials: OAuthClientCredentials,
    options?: { codeVerifier?: string; useLegacyEndpoint?: boolean },
  ): Promise<Token>;
  /** Refresh an access token. Throws for a provider without refresh tokens. */
  refresh(
    refreshToken: string,
    credentials: OAuthClientCredentials,
  ): Promise<Token>;
  /** Tell the provider the grant is gone. Never throws on a refusal. */
  deauthorize(accessToken: string): Promise<void>;
}

const EXCHANGE_VERB = "exchangeCode";
const REFRESH_VERB = "refreshAccessToken";

/** HTTP Basic credentials for the confidential client (RFC 6749 2.3.1). */
export function basicAuthorization(
  credentials: OAuthClientCredentials,
): string {
  const raw = `${credentials.clientId}:${credentials.clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/** The RFC 6749 `error` code of a refusal body, when it has one. */
export function oauthErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

function defaultVerdict(httpStatus: number): TokenVerdict {
  const verdict = classifyHttpStatus(httpStatus);
  return {
    classification: verdict.classification,
    status: verdict.httpStatus,
    reason: verdict.reason,
  };
}

interface Answer {
  httpStatus: number;
  body: unknown;
  verdict: TokenVerdict;
}

export function defineOAuthClient<Token>(
  config: OAuthClientConfig,
): OAuthClient<Token> {
  const classify =
    config.classify ?? ((httpStatus: number) => defaultVerdict(httpStatus));
  const upstreamError = config.upstreamError ?? oauthErrorCode;
  const tokenOf = config.tokenOf ?? ((body: unknown) => body);

  async function post(
    url: string,
    form: Record<string, string>,
    credentials: OAuthClientCredentials,
    eventMethod: string,
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (config.acceptJson) headers.Accept = "application/json";
    if (config.clientAuth.kind === "basic") {
      headers.Authorization = basicAuthorization(credentials);
    }
    const start = performance.now();
    const res = await safeFetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    });
    const body: unknown = await res.json().catch(() => null);
    const verdict = classify(res.status, body);
    getEvent()?.addExternalCall({
      service: config.service,
      method: eventMethod,
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
      error: verdict.classification === "success" ? undefined : verdict.reason,
    });
    return { httpStatus: res.status, body, verdict };
  }

  function settle(answer: Answer, verb: string): Token {
    const { verdict, body } = answer;
    if (verdict.classification !== "success") {
      throw config.error({
        ...verdict,
        verb,
        upstreamError: upstreamError(body),
      });
    }
    const token = tokenOf(body);
    if (token === null || typeof token !== "object") {
      throw config.error({
        classification: "transient",
        status: answer.httpStatus,
        reason: "empty_token_body",
        verb,
        upstreamError: undefined,
      });
    }
    return token as Token;
  }

  async function request(
    grant: "exchange" | "refresh",
    form: Record<string, string>,
    credentials: OAuthClientCredentials,
    mayUseLegacy: boolean,
  ): Promise<Token> {
    const eventMethod = grant === "exchange" ? EXCHANGE_VERB : REFRESH_VERB;
    const verb = config.failureVerb?.[grant] ?? eventMethod;
    const first = await post(config.tokenUrl, form, credentials, eventMethod);
    const legacy = config.legacyTokenUrl;
    if (legacy && mayUseLegacy && legacy.retryOn.has(first.httpStatus)) {
      const second = await post(
        legacy.url,
        form,
        credentials,
        `${eventMethod}.legacy`,
      );
      if (second.httpStatus >= 200 && second.httpStatus < 300) {
        return settle(second, verb);
      }
      // Neither endpoint took it; the first answer describes the grant for
      // every current client, so that is the one reported.
    }
    return settle(first, verb);
  }

  function clientFields(
    grant: "exchange" | "refresh",
    credentials: OAuthClientCredentials,
  ): Record<string, string> {
    if (config.clientAuth.kind === "form") {
      return {
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      };
    }
    return config.clientAuth.idInForm[grant]
      ? { client_id: credentials.clientId }
      : {};
  }

  return {
    redirectUri: config.redirectUri,

    authorizationUrl(state, credentials, codeChallenge) {
      if (config.pkce && !codeChallenge) {
        throw new Error(
          `${config.service}: the authorization needs a PKCE challenge`,
        );
      }
      const params = new URLSearchParams({
        response_type: "code",
        client_id: credentials.clientId,
        redirect_uri: config.redirectUri(),
        ...config.authorizeParams(),
        ...(config.pkce && codeChallenge
          ? { code_challenge: codeChallenge, code_challenge_method: "S256" }
          : {}),
        state,
      });
      return `${config.authorizeUrl}?${params}`;
    },

    exchange(code, credentials, options = {}) {
      if (config.pkce && !options.codeVerifier) {
        throw new Error(
          `${config.service}: the exchange needs the PKCE verifier`,
        );
      }
      return request(
        "exchange",
        {
          ...config.extraFields?.exchange,
          grant_type: "authorization_code",
          code,
          ...clientFields("exchange", credentials),
          ...(config.exchangeRedirectUri === false
            ? {}
            : { redirect_uri: config.redirectUri() }),
          ...(options.codeVerifier
            ? { code_verifier: options.codeVerifier }
            : {}),
        },
        credentials,
        options.useLegacyEndpoint ?? true,
      );
    },

    refresh(refreshToken, credentials) {
      if (!config.refresh) {
        return Promise.reject(
          new Error(`${config.service} issues no refresh tokens`),
        );
      }
      return request(
        "refresh",
        {
          ...config.extraFields?.refresh,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          ...clientFields("refresh", credentials),
        },
        credentials,
        true,
      );
    },

    async deauthorize(accessToken) {
      if (!config.deauthorizeUrl) return;
      const start = performance.now();
      const res = await safeFetch(config.deauthorizeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      getEvent()?.addExternalCall({
        service: config.service,
        method: "deauthorize",
        duration_ms: Math.round(performance.now() - start),
        status: res.status,
        error: res.ok ? undefined : `http_${res.status}`,
      });
    },
  };
}
