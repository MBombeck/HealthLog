/**
 * Garmin Personal API transport: the key-for-token exchange, the bearer GET,
 * and the date-range rules of each resource.
 *
 * The Personal API is pull-only and read-only. A person creates a key in
 * Garmin Connect (Settings, Personal API) and pastes it here. Every data call
 * needs a short-lived JWT the key buys at
 * `POST /personalapitoken-service/personal-api/personal-api-key/token`
 * (`Authorization: ApiKey <key>`, the body is the bare JWT). A token lives 24
 * hours, or less once the key itself is about to expire, and there is no
 * refresh token: a new one is simply bought again with the key.
 *
 * Tokens are cached in this process only, per account and per key (a changed
 * key never reuses the old key's token). A data call refused with 401 buys one
 * fresh token and retries once; a second refusal, or a refusal at the
 * exchange itself, means the key was revoked or has expired, and surfaces as
 * `reauth_required` so the card asks for a new one.
 *
 * Egress goes through `safeFetch` to two fixed hosts (global and China), so
 * there is no user-supplied host to pin. Answers are read with a byte cap.
 */
import { createHash } from "node:crypto";

import { getEvent } from "@/lib/logging/context";
import { shiftDateKey } from "@/lib/tz/format";
import { readBodyCapped } from "@/lib/http/read-capped";
import { safeFetch } from "@/lib/safe-fetch";
import { retryAfterMsOf } from "@/lib/integrations/oauth-kit/retry-after";
import {
  classifyHttpStatus,
  IntegrationApiError,
  type IntegrationClassification,
} from "@/lib/integrations/http-status-classifier";

export const GARMIN_HOSTS = {
  global: "https://personal.connectapi.garmin.com",
  china: "https://personal.connectapi.garmin.cn",
} as const;

export type GarminRegion = keyof typeof GARMIN_HOSTS;

export const GARMIN_REGIONS = Object.keys(GARMIN_HOSTS) as GarminRegion[];

export function isGarminRegion(value: unknown): value is GarminRegion {
  return value === "global" || value === "china";
}

export const GARMIN_TOKEN_PATH =
  "/personalapitoken-service/personal-api/personal-api-key/token";

export const GARMIN_PATHS = {
  dailySummaries: "/usersummary-service/v2/dailysummaries",
  sleepSummaries: "/sleep-service/sleep/dailySleepSummariesByDate",
  hrvDaily: "/hrv-service/hrv/daily",
  weightRange: "/weight-service/weight/range",
  activities: "/activitylist-service/activities/search/activities",
  cycleSummary: "/periodichealth-service/menstrualcycle/summary",
} as const;

/**
 * The widest request each resource accepts, in calendar days counting both
 * ends. Daily summaries, sleep and the body-battery report carry documented
 * maxima (365, 31, 31); HRV and weigh-ins document none, so they take the
 * sleep figure rather than find the limit by being refused. Activities are
 * paged and filtered by start date, so their window is only a slice size.
 */
export const GARMIN_RANGE_DAYS = {
  dailySummaries: 365,
  sleepSummaries: 31,
  hrvDaily: 31,
  weightRange: 31,
  activities: 90,
} as const;

/** Page size of the activity search (Garmin's own default is 99). */
export const GARMIN_ACTIVITY_PAGE = 99;

/** Ceiling on one answer. A year of daily summaries is about a megabyte. */
export const GARMIN_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** A regular token lives 24 h; anything markedly shorter is capped by the key. */
const KEY_CAPPED_BELOW_MS = 23 * 60 * 60 * 1000;
/** Replace a token an hour before it expires, never before half its life. */
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
/** Used only when a token carries no readable `exp`. */
const FALLBACK_LIFETIME_MS = 23 * 60 * 60 * 1000;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export class GarminApiError extends IntegrationApiError {
  /** How long Garmin asked to be left alone (a 429's `Retry-After`). */
  readonly retryAfterMs: number | undefined;
  /** The key itself was refused: revoked, deleted or expired. */
  readonly keyRefused: boolean;

  constructor(opts: {
    verb: string;
    classification: IntegrationClassification;
    httpStatus: number | undefined;
    reason: string;
    retryAfterMs?: number;
    keyRefused?: boolean;
  }) {
    const { retryAfterMs, keyRefused, ...rest } = opts;
    super({ vendor: "Garmin", ...rest });
    this.name = "GarminApiError";
    this.retryAfterMs = retryAfterMs;
    this.keyRefused = keyRefused ?? false;
  }
}

/** True for a refusal that a new key, not a retry, resolves. */
export function isGarminKeyRefusal(err: unknown): boolean {
  return err instanceof GarminApiError && err.keyRefused;
}

/** True for Garmin's rate limit. */
export function isGarminRateLimit(err: unknown): err is GarminApiError {
  return err instanceof GarminApiError && err.httpStatus === 429;
}

/** The token text: the bare JWT, or one wrapped in JSON or quotes. */
export function extractGarminToken(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return trimmed.replace(/^"|"$/g, "");
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate = json.access_token ?? json.accessToken ?? json.token;
    return typeof candidate === "string" ? candidate.trim() : "";
  } catch {
    return "";
  }
}

/** A JWT's `exp` claim in epoch ms, read without verifying the signature. */
export function garminTokenExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

export interface GarminToken {
  value: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Epoch ms after which a new token is bought. */
  refreshAt: number;
  /**
   * The key's own expiry, when the token gave it away: a token Garmin caps
   * at the key's end lives markedly less than the regular day.
   */
  keyExpiresAt: number | null;
}

function refreshTime(now: number, expiresAt: number): number {
  const lifetime = expiresAt - now;
  if (lifetime <= 0) return now;
  return now + Math.max(lifetime - REFRESH_WINDOW_MS, lifetime / 2);
}

export interface GarminTransport {
  fetch?: typeof safeFetch;
  now?: () => number;
}

/**
 * Buy a token with the key. Throws a `GarminApiError` whose `keyRefused` is
 * set when Garmin turned the key down (401 for a key it never issued, 404 for
 * a deleted one, 403 for good measure).
 */
export async function exchangeGarminKey(
  apiKey: string,
  region: GarminRegion,
  transport: GarminTransport = {},
): Promise<GarminToken> {
  const doFetch = transport.fetch ?? safeFetch;
  const now = transport.now ?? Date.now;
  const start = performance.now();
  const res = await doFetch(`${GARMIN_HOSTS[region]}${GARMIN_TOKEN_PATH}`, {
    method: "POST",
    headers: { Accept: "*/*", Authorization: `ApiKey ${apiKey}` },
  });
  const status = res.status;
  getEvent()?.addExternalCall({
    service: "garmin",
    method: "token",
    duration_ms: Math.round(performance.now() - start),
    status,
    error: status === 200 ? undefined : `http_${status}`,
  });
  if (status === 401 || status === 403 || status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new GarminApiError({
      verb: "token",
      classification: "reauth_required",
      httpStatus: status,
      reason: "key_refused",
      keyRefused: true,
    });
  }
  if (status !== 200) {
    await res.body?.cancel().catch(() => {});
    const verdict = classifyHttpStatus(status);
    throw new GarminApiError({
      verb: "token",
      classification: verdict.classification,
      httpStatus: status,
      reason: verdict.reason,
      ...(status === 429 || status === 503
        ? { retryAfterMs: retryAfterMsOf(res) }
        : {}),
    });
  }
  const read = await readBodyCapped(res, 64 * 1024);
  const value = read.ok ? extractGarminToken(read.text) : "";
  if (!JWT_SHAPE.test(value)) {
    // A maintenance page served with 200, say. Never cached, never echoed.
    throw new GarminApiError({
      verb: "token",
      classification: "transient",
      httpStatus: status,
      reason: "token_not_jwt",
    });
  }
  const issuedAt = now();
  const exp = garminTokenExpiry(value);
  const expiresAt = exp ?? issuedAt + FALLBACK_LIFETIME_MS;
  return {
    value,
    expiresAt,
    refreshAt: refreshTime(issuedAt, expiresAt),
    keyExpiresAt:
      exp !== undefined && exp - issuedAt < KEY_CAPPED_BELOW_MS ? exp : null,
  };
}

interface CachedToken extends GarminToken {
  fingerprint: string;
}

/** Process-local token cache, per account. Never persisted. */
const tokenCache = new Map<string, CachedToken>();

/** Forget cached tokens (one account's, or all). Disconnect and tests call it. */
export function clearGarminTokenCache(userId?: string): void {
  if (userId === undefined) tokenCache.clear();
  else tokenCache.delete(userId);
}

function keyFingerprint(apiKey: string, region: GarminRegion): string {
  return createHash("sha256").update(`${region}\n${apiKey}`).digest("hex");
}

export type GarminQuery = Record<
  string,
  string | number | boolean | undefined | null
>;

/**
 * One account's session against the Personal API. Holds the key only for as
 * long as the session object lives, buys tokens through the shared cache, and
 * remembers what a token said about the key's expiry so the caller can
 * persist it.
 */
export class GarminSession {
  private readonly userId: string;
  private readonly apiKey: string;
  private readonly region: GarminRegion;
  private readonly transport: GarminTransport;
  private readonly fingerprint: string;
  /** The key's expiry, once a token revealed it. */
  learnedKeyExpiresAt: number | null = null;
  /** Number of key exchanges this session made (for the record and tests). */
  exchanges = 0;

  constructor(opts: {
    userId: string;
    apiKey: string;
    region: GarminRegion;
    transport?: GarminTransport;
  }) {
    this.userId = opts.userId;
    this.apiKey = opts.apiKey;
    this.region = opts.region;
    this.transport = opts.transport ?? {};
    this.fingerprint = keyFingerprint(opts.apiKey, opts.region);
  }

  private now(): number {
    return (this.transport.now ?? Date.now)();
  }

  /** A usable token: the cached one while fresh, else a new one. */
  async token(force = false): Promise<string> {
    const cached = tokenCache.get(this.userId);
    if (
      !force &&
      cached &&
      cached.fingerprint === this.fingerprint &&
      this.now() < cached.refreshAt
    ) {
      return cached.value;
    }
    const fresh = await exchangeGarminKey(
      this.apiKey,
      this.region,
      this.transport,
    );
    this.exchanges += 1;
    if (fresh.keyExpiresAt !== null) {
      this.learnedKeyExpiresAt = fresh.keyExpiresAt;
    }
    tokenCache.set(this.userId, { ...fresh, fingerprint: this.fingerprint });
    return fresh.value;
  }

  /**
   * GET a resource. Returns the parsed body, or null for an empty answer
   * (204, or no body). A 401 buys one new token and retries; a second 401
   * is the key's end.
   */
  async get<T>(
    verb: string,
    path: string,
    query: GarminQuery = {},
  ): Promise<T | null> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${GARMIN_HOSTS[this.region]}${path}${qs ? `?${qs}` : ""}`;

    let token = await this.token();
    let res = await this.call(verb, url, token);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      token = await this.token(true);
      res = await this.call(verb, url, token);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        tokenCache.delete(this.userId);
        throw new GarminApiError({
          verb,
          classification: "reauth_required",
          httpStatus: 401,
          reason: "key_refused",
          keyRefused: true,
        });
      }
    }
    if (res.status === 204) return null;
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      const verdict = classifyHttpStatus(res.status);
      throw new GarminApiError({
        verb,
        // A 403 on a data call with a token the exchange just accepted is a
        // resource the account cannot read, not a dead key.
        classification:
          res.status === 403 ? "persistent" : verdict.classification,
        httpStatus: res.status,
        reason: verdict.reason,
        ...(res.status === 429 || res.status === 503
          ? { retryAfterMs: retryAfterMsOf(res, this.now()) }
          : {}),
      });
    }
    const read = await readBodyCapped(res, GARMIN_MAX_BODY_BYTES);
    if (!read.ok) {
      throw new GarminApiError({
        verb,
        classification: "transient",
        httpStatus: res.status,
        reason: "body_too_large",
      });
    }
    if (read.text.trim() === "") return null;
    try {
      return JSON.parse(read.text) as T;
    } catch {
      throw new GarminApiError({
        verb,
        classification: "transient",
        httpStatus: res.status,
        reason: "body_not_json",
      });
    }
  }

  private async call(
    verb: string,
    url: string,
    token: string,
  ): Promise<Response> {
    const doFetch = this.transport.fetch ?? safeFetch;
    const start = performance.now();
    const res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    getEvent()?.addExternalCall({
      service: "garmin",
      method: verb,
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
      error: res.ok ? undefined : `http_${res.status}`,
    });
    return res;
  }
}

// ── date windows ────────────────────────────────────────────────────

/** `day` moved by `delta` calendar days (pure key arithmetic). */
export function shiftGarminDay(day: string, delta: number): string {
  return shiftDateKey(day, delta);
}

/**
 * Split `[startDate, endDate]` (both inclusive) into windows of at most
 * `maxDays` calendar days, newest first. An inverted range yields nothing.
 */
export function chunkGarminRange(
  startDate: string,
  endDate: string,
  maxDays: number,
): Array<{ startDate: string; endDate: string }> {
  if (maxDays < 1) throw new Error("maxDays must be at least 1");
  const out: Array<{ startDate: string; endDate: string }> = [];
  let end = endDate;
  while (end >= startDate) {
    const candidate = shiftGarminDay(end, -(maxDays - 1));
    const start = candidate < startDate ? startDate : candidate;
    out.push({ startDate: start, endDate: end });
    end = shiftGarminDay(start, -1);
  }
  return out;
}
