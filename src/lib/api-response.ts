import { isIP } from "node:net";
import { NextResponse } from "next/server";
import type { ZodError, ZodIssue } from "zod/v4";

export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ data, error: null }, { status });
}

/**
 * A success envelope that also carries `meta`: figures ABOUT the payload
 * (an aggregate across its rows, the window it was cut to) that do not belong
 * inside any one row. `data` keeps the shape the route always had, so a
 * client that never reads `meta` decodes the response unchanged.
 */
export function apiSuccessWithMeta<T>(
  data: T,
  meta: Record<string, unknown>,
  status = 200,
) {
  return NextResponse.json({ data, error: null, meta }, { status });
}

/**
 * Sanitised view of a single Zod issue. We surface `path`, `code`,
 * `message` and — for `unrecognized_keys` only — the bounded `keys`
 * list; `issue.params` may echo the offending user input
 * (e.g. a too-long string, a regex source) and we do not want that
 * round-tripped to mobile callers or persisted into the audit ledger.
 */
export interface SanitisedZodIssue {
  path: string;
  code: string;
  message: string;
  /**
   * Only set for `unrecognized_keys`: the rejected key names, sanitised
   * and bounded by {@link sanitiseKeyName}. A key name is structure, not
   * content, so naming it is what makes the rejection actionable — the
   * caller learns which field it got wrong instead of only that the body
   * had a field too many. It survives `stripValuesFromMessage` for the
   * same reason: it carries no user-typed value.
   */
  keys?: string[];
}

/** Cap on how many rejected key names one issue reports. */
const MAX_REPORTED_KEYS = 10;
/** Cap on the length of a single reported key name. */
const MAX_KEY_NAME_LENGTH = 64;

/**
 * A key name arrives straight from the request body, so it is caller-
 * controlled and unbounded: a client can post a 100 KB key, or one
 * carrying markup, and Zod's own `unrecognized_keys` message echoes it
 * verbatim. That message reaches the client, the wide event and — at the
 * `stripValuesFromMessage` call sites — the audit ledger, so it is bounded
 * and character-restricted here rather than at each of those boundaries.
 * Anything outside `[A-Za-z0-9_.-]` collapses to `_`, which keeps a typo
 * like `measuredAtt` perfectly readable while leaving nothing that could
 * be mistaken for markup or a control sequence downstream.
 */
function sanitiseKeyName(key: string): string {
  return key.slice(0, MAX_KEY_NAME_LENGTH).replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Zod reports every unknown key of one object in a single issue whose
 * `path` is the object itself, so the offending keys live in `issue.keys`
 * and nowhere in `path`. Without this the sanitised issue read
 * `{ path: "", code: "unrecognized_keys" }` and named nothing at all.
 */
function unrecognisedKeys(issue: ZodIssue): string[] | undefined {
  if (issue.code !== "unrecognized_keys") return undefined;
  return issue.keys.slice(0, MAX_REPORTED_KEYS).map(sanitiseKeyName);
}

/**
 * Rebuilt from the sanitised key names rather than passed through from
 * Zod, so the wording stays the one callers already parse while the
 * unbounded verbatim echo does not ship.
 */
function unrecognisedKeysMessage(keys: string[]): string {
  const rendered = keys.map((key) => `"${key}"`).join(", ");
  return keys.length === 1
    ? `Unrecognized key: ${rendered}`
    : `Unrecognized keys: ${rendered}`;
}

/**
 * Variant used when the issues land in an audit-ledger row whose
 * source field is free-text. `invalid_enum_value` and a handful of
 * other Zod codes embed the offending value verbatim in
 * `issue.message`, so a route that JSON-stringifies the sanitised
 * array into `details` can leak user content. Callers opt in via
 * `sanitiseZodIssues(error.issues, { stripValuesFromMessage: true })`.
 */
export interface SanitiseZodIssueOptions {
  /**
   * When true, drop `issue.message` from the returned shape entirely.
   * Only `path`, `code` and (for `unrecognized_keys`) the sanitised
   * `keys` survive — enough for an operator to triage the rejection
   * without persisting user-typed content. Default is
   * `false` so the additive multi-issue envelope keeps its existing
   * client contract.
   */
  stripValuesFromMessage?: boolean;
}

/**
 * v1.4.42 W2 — multi-issue Zod error envelope.
 *
 * Historic pattern was `apiError(parsed.error.issues[0].message, 422)`
 * which dropped every issue past the first. The iOS contract debug
 * loop hit this hard: a single PUT with three wrong fields produced
 * one error, the client fixed it, re-sent, hit the next error, and
 * so on — three round-trips for one stack of mistakes.
 *
 * Shape kept additive with `apiError` so existing clients that only
 * read `error` keep working; new callers branch on `details.issues`.
 *
 * Privacy: only `path`, `code` and `message` are echoed. `issue.params`
 * (which can carry the raw rejected value for some Zod issue codes)
 * stays server-side.
 *
 * v1.4.49 — `stripValuesFromMessage` removes `message` for the
 * auditLog-emission sites whose input fields are free-text. Some Zod
 * codes (e.g. `invalid_enum_value`) embed the offending value in the
 * default message string; a free-text route writing the message into
 * the audit ledger would leak user content. The opt-in is additive —
 * the default behaviour is unchanged so existing clients reading
 * `details.issues[*].message` over the wire keep working.
 *
 * `unrecognized_keys` is rendered rather than passed through. A caller
 * that sends `measuredAtt` for `measuredAt` has to be told which key was
 * refused, and Zod puts that in `issue.keys` while leaving `path` empty —
 * so the key names are lifted onto `keys`, bounded and character-
 * restricted, and the message is rebuilt from them rather than echoing
 * the raw request key back.
 */
export function sanitiseZodIssues(
  issues: readonly ZodIssue[],
): SanitisedZodIssue[];
export function sanitiseZodIssues(
  issues: readonly ZodIssue[],
  options: { stripValuesFromMessage: true },
): Array<Omit<SanitisedZodIssue, "message">>;
export function sanitiseZodIssues(
  issues: readonly ZodIssue[],
  options?: SanitiseZodIssueOptions,
): SanitisedZodIssue[] | Array<Omit<SanitisedZodIssue, "message">> {
  if (options?.stripValuesFromMessage) {
    return issues.map((issue) => {
      const keys = unrecognisedKeys(issue);
      return {
        path: issue.path.join("."),
        code: issue.code,
        ...(keys ? { keys } : {}),
      };
    });
  }
  return issues.map((issue) => {
    const keys = unrecognisedKeys(issue);
    return {
      path: issue.path.join("."),
      code: issue.code,
      message: keys ? unrecognisedKeysMessage(keys) : issue.message,
      ...(keys ? { keys } : {}),
    };
  });
}

/**
 * v1.4.49 — diagnostic shape echoed into a wide-event meta when an iOS
 * (or any other) caller fails Zod validation on a JSON payload. Pairs
 * with the per-route `annotate({ action, meta: { ...payloadDiagnostic,
 * zod_issues, issue_count } })` call. Each field is bounded:
 *
 *   - `received_keys`: top-level keys only; never values
 *   - `received_shape_excerpt`: hard 256-char `JSON.stringify` slice
 *
 * Defensive shape: caller passes the raw parsed body (object | array |
 * primitive | undefined). Non-object input collapses to an empty key
 * list and an empty excerpt — the helper never throws.
 *
 * A redaction layer (PII / token-shape removal) is expected to be
 * applied as a follow-up composable step by a parallel
 * `W-OBSERV-PII-V1449` audit; this helper builds the unredacted shape
 * so the redactor can post-process via a second helper call. Keeping
 * the two concerns separate lets the unit test for this helper stay
 * stable while the redaction policy evolves.
 */
export interface PayloadDiagnostic {
  received_keys: string[];
  received_shape_excerpt: string;
}

export function buildPayloadDiagnostic(body: unknown): PayloadDiagnostic {
  const received_keys =
    body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body as Record<string, unknown>)
      : [];
  let excerpt: string;
  try {
    excerpt = JSON.stringify(body) ?? "";
  } catch {
    excerpt = "";
  }
  return {
    received_keys,
    received_shape_excerpt: excerpt.slice(0, 256),
  };
}

type ErrorMeta = {
  errorCode?: string;
  headers?: Record<string, string>;
} & Record<string, unknown>;

/**
 * Shared builder for every `{ data: null, error, ... }` JSON envelope.
 * Strips `headers` from the meta passthrough (it lands on the
 * NextResponse constructor, not in the JSON body) and omits the `meta`
 * key entirely when no non-header fields remain — so the unchanged
 * `{ data: null, error: <string> }` envelope still serialises byte-
 * identically when the caller passes no extras.
 */
function buildJsonErrorResponse(
  body: Record<string, unknown>,
  status: number,
  meta: ErrorMeta | undefined,
): NextResponse {
  const { headers, ...rest } = meta ?? {};
  const metaKeys = Object.keys(rest);
  return NextResponse.json(
    {
      ...body,
      ...(metaKeys.length > 0 ? { meta: rest } : {}),
    },
    {
      status,
      ...(headers ? { headers } : {}),
    },
  );
}

export function returnAllZodIssues(
  error: ZodError,
  status: number = 422,
  meta?: ErrorMeta,
): NextResponse {
  return buildJsonErrorResponse(
    {
      data: null,
      error: "Validation failed",
      details: { issues: sanitiseZodIssues(error.issues) },
    },
    status,
    meta,
  );
}

/**
 * Like {@link returnAllZodIssues}, but for callers that have already
 * reduced a `ZodError` to a caller-composed, person-safe top-level
 * `error` sentence and a pre-sanitised issue list (e.g. a shared
 * write-path helper that validates outside the route handler, such as
 * `applyProfileUpdate`). The multi-issue envelope (`details.issues`) is
 * unchanged from `returnAllZodIssues` — this exists so the top-level
 * string never has to repeat a raw Zod default message (an enum's
 * `Invalid option: expected one of "A"|"B"|"C"` reaching a person's
 * screen) while the machine-readable detail is still relocated, not
 * dropped. `meta.errorCode` lets the web client resolve a localized
 * sentence via `apiErrors.<errorCode>` (see `localizedApiError`).
 */
export function apiValidationError(
  message: string,
  issues: SanitisedZodIssue[],
  status: number = 422,
  meta?: ErrorMeta,
): NextResponse {
  return buildJsonErrorResponse(
    { data: null, error: message, details: { issues } },
    status,
    meta,
  );
}

/**
 * `meta` is additive — clients that ignore it see the unchanged
 * `{ data: null, error: <string> }` envelope. New callers can pass
 * `{ errorCode: "credentials_rejected" }` so the UI translates the message
 * via `t("settings.testConnection.errors." + errorCode)` instead of
 * displaying the server's English fallback.
 *
 * v1.4.25 W21 Fix-N — the third argument may also carry a `headers`
 * record (e.g. `{ headers: rateLimitHeaders(rl) }`) so 429 responses
 * can attach the `X-RateLimit-*` triple in the same call. The `headers`
 * key is *not* echoed into the JSON body — it is consumed by the
 * NextResponse constructor and stripped from the meta envelope.
 */
export function apiError(message: string, status = 400, meta?: ErrorMeta) {
  return buildJsonErrorResponse({ data: null, error: message }, status, meta);
}

/**
 * Read a request body as text, counting BYTES as they arrive and stopping at
 * `maxBytes`. A body that declares a larger `Content-Length` is refused before
 * a byte is read; one that does not (chunked) is cancelled the moment it
 * passes the cap. `request.text()` has no such bound — it holds whatever the
 * client sends — which mattered little while the proxy's body clone truncated
 * everything at a fixed ceiling, and matters for the upload routes that no
 * longer pass through the proxy.
 */
export async function readBodyText(
  request: Request,
  maxBytes: number,
): Promise<{ text: string; tooLarge?: never } | { tooLarge: true }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { tooLarge: true };
  }
  const body = request.body;
  if (!body) return { text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by the cancel above.
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined) };
}

/**
 * Safely parse JSON body from a request.
 * Returns the parsed body or a 400 error response if parsing fails.
 *
 * `opts.maxBytes` opts a route into a hard body-size cap, enforced WHILE the
 * body is read (`readBodyText`): an over-limit payload returns 413 without the
 * whole body ever being held, and never reaches `JSON.parse`. Single-record
 * routes can pass a tight cap; batch routes that legitimately accept large
 * payloads pass a larger one. When `maxBytes` is omitted the body is bounded
 * only by the proxy's 1 MB clone ceiling (`proxyClientMaxBodySize`), so a
 * route left out of the proxy matcher must pass one.
 */
export async function safeJson<T = unknown>(
  request: Request,
  opts?: { maxBytes?: number },
): Promise<{ data: T; error?: never } | { data?: never; error: Response }> {
  const ct = request.headers.get("content-type");
  if (!ct || !ct.includes("application/json")) {
    return { error: apiError("Content-Type must be application/json", 415) };
  }
  if (opts?.maxBytes !== undefined) {
    let read: Awaited<ReturnType<typeof readBodyText>>;
    try {
      read = await readBodyText(request, opts.maxBytes);
    } catch {
      return { error: apiError("Invalid request body", 400) };
    }
    if (read.tooLarge) {
      return {
        error: apiError(`Request body exceeds ${opts.maxBytes} bytes`, 413),
      };
    }
    try {
      const data = JSON.parse(read.text) as T;
      return { data };
    } catch {
      return { error: apiError("Invalid JSON body", 400) };
    }
  }
  try {
    const data = (await request.json()) as T;
    return { data };
  } catch {
    return { error: apiError("Invalid JSON body", 400) };
  }
}

/**
 * Resolve the real client IP from a request, respecting trusted-proxy
 * configuration. V3 audit: previously took the leftmost XFF entry blindly,
 * letting a client rotate `X-Forwarded-For: 1.2.3.4` per request to defeat
 * IP-based rate-limits.
 *
 * Trust model (`TRUST_PROXY_HOPS` env):
 *   - "0"          → trust no forwarding header at all, XFF or x-real-ip
 *                    (use this if HealthLog is internet-facing without a
 *                    reverse proxy you control); the IP resolves to null
 *   - "1" (default)→ trust exactly one hop (typical Coolify / Caddy /
 *                    Cloudflare-Tunnel single-proxy deployment); read the
 *                    rightmost XFF entry which is the IP your proxy
 *                    observed when the request arrived.
 *   - "N" (>1)     → trust N hops; read the Nth-from-rightmost XFF entry.
 *
 * Cloudflare opt-in (`TRUST_CF_CONNECTING_IP=1`): when the env flag is
 * set, the helper prefers the `cf-connecting-ip` header before walking
 * the XFF chain. Cloudflare strips and re-sets this header on every
 * request that lands on its edge, so it carries the real visitor IP
 * even when XFF/x-real-ip end up as the Coolify proxy's loopback
 * address. The flag is OFF by default: a self-hosted deployment
 * without Cloudflare in front would otherwise trust an attacker-set
 * header on the public internet.
 *
 * Returns the resolved IP or null when no trusted source is available.
 */
/**
 * v1.4.38 — strict IP validation via Node's built-in `net.isIP`. The
 * earlier regex `/^[0-9a-fA-F.:]+$/` matched any structurally-broken
 * input the character set accepted (`:::`, `1.2`, `1.2.3`, `gg:hh::`).
 * The cf-connecting-ip flow trusts the header under the env flag and
 * the trusted-proxy XFF chain forwards the rightmost entry straight
 * to the rate-limiter + audit log; a malformed value would land
 * downstream unchanged. `isIP` returns 4 / 6 for valid v4 / v6 and 0
 * for anything else — invert to a boolean for the helper's surface.
 */
function looksLikeIp(s: string): boolean {
  return isIP(s) !== 0;
}

/**
 * v1.4.37 — Cloudflare puts the visitor IP into `cf-connecting-ip` on
 * every request hitting the edge. The Coolify-fronted HealthLog stack
 * sits behind Cloudflare; without consulting this header, every
 * `getClientIp` caller landed with the Caddy loopback IP and the geo
 * resolver had no signal to backfill the admin sign-in overview from.
 *
 * The header is honoured only when `TRUST_CF_CONNECTING_IP=1`. A
 * self-hosted deployment without Cloudflare in front must NOT trust
 * the header — any attacker can set it on a direct request and the
 * downstream geo resolver would happily report a forged location.
 */
function readCfConnectingIp(request: Request): string | null {
  if (process.env.TRUST_CF_CONNECTING_IP !== "1") return null;
  const candidate = request.headers.get("cf-connecting-ip");
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return looksLikeIp(trimmed) ? trimmed : null;
}

function parseTrustProxyHops(raw: string | undefined): number {
  // Empty is unset. The shipped docker-compose.yml passes
  // `TRUST_PROXY_HOPS: "${TRUST_PROXY_HOPS:-}"`, which is an empty string for
  // every operator who never set it; reading that as invalid threw on every
  // request that asked for the client IP.
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return 1;
  if (!/^\d+$/.test(trimmed)) {
    // Reject explicitly-invalid values so an operator typo doesn't silently
    // switch a real-proxy deployment to "no XFF trust" mode (review
    // finding L-1: TRUST_PROXY_HOPS=garbage degraded to hops=0 silently).
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer, got: ${JSON.stringify(raw)}`,
    );
  }
  return parseInt(trimmed, 10);
}

/**
 * Module-scope flag so the trust-violation warning fires at most once per
 * process. F-6 (mobile security audit, 2026-05-16): every IP-keyed
 * rate-limit caller falls back to a literal `"unknown"` bucket when
 * `getClientIp` returns null, which collapses anonymous traffic into a
 * single shared bucket. A persistent stderr line tells the operator the
 * proxy chain length and the configured `TRUST_PROXY_HOPS` value don't
 * match and the deployment is silently degrading rate-limit precision.
 */
let trustViolationWarned = false;

/**
 * Reset the once-per-process warning flag. Test-only; the production
 * code never calls this.
 */
export function _resetTrustViolationWarningForTests(): void {
  trustViolationWarned = false;
}

function warnTrustViolationOnce(hops: number, chainLength: number): void {
  if (trustViolationWarned) return;
  trustViolationWarned = true;
  console.warn(
    `[getClientIp] TRUST_PROXY_HOPS=${hops} but X-Forwarded-For carried ${chainLength} entr${chainLength === 1 ? "y" : "ies"}; ` +
      `refusing to read XFF for this request. Every anonymous caller will now share the same "unknown" rate-limit bucket — fix TRUST_PROXY_HOPS or the proxy chain.`,
  );
}

/**
 * Once per process: forwarding headers arrived that the configured trust
 * does not let us read, so the client address resolves to nothing. The
 * common cause is `TRUST_PROXY_HOPS=0` behind a proxy that sends only
 * `X-Real-IP` (nginx's usual setup), or `TRUST_PROXY_HOPS` of 2 or more with
 * no `X-Forwarded-For`. Every anonymous caller then shares one rate-limit
 * bucket, so one person mistyping a password can hold the sign-in back for
 * everybody, and the operator had no way to see why.
 */
let unreadProxyHeadersWarned = false;

/** Test-only reset for {@link warnUnreadProxyHeadersOnce}. */
export function _resetUnreadProxyHeadersWarningForTests(): void {
  unreadProxyHeadersWarned = false;
}

function warnUnreadProxyHeadersOnce(hops: number, header: string): void {
  if (unreadProxyHeadersWarned) return;
  unreadProxyHeadersWarned = true;
  console.warn(
    `[getClientIp] requests carry ${header} but TRUST_PROXY_HOPS=${hops} does not allow reading it, so client addresses resolve to nothing and every anonymous caller shares one rate-limit bucket. ` +
      (hops === 0
        ? "If a proxy you control sits in front of HealthLog, set TRUST_PROXY_HOPS=1."
        : "X-Real-IP is only read with TRUST_PROXY_HOPS=1; with more hops, have the proxies send X-Forwarded-For."),
  );
}

/**
 * Tagged return shape so a caller can apply a tighter universal
 * rate-limit when the trust chain is misconfigured. F-6 (mobile security
 * audit, 2026-05-16): callers today fall back to a literal `"unknown"`
 * string, collapsing every anonymous request into one bucket. New
 * callers should branch on `trustViolation === true` and route the
 * request to a tighter global rate-limit instead of the per-IP one.
 *
 * Existing callers using `getClientIp(request) ?? "unknown"` keep
 * working unchanged; this helper is additive.
 *
 * v1.4.37 — also the single resolver for the CF / XFF / x-real-ip
 * ladder. `getClientIp` projects this helper's `.ip` so the rotation-
 * attack guard, the Cloudflare opt-in and the one-shot trust-violation
 * warning live in one place.
 */
export function getClientIpOrTrustWarning(request: Request): {
  ip: string | null;
  trustViolation: boolean;
} {
  // v1.4.37 — Cloudflare's `cf-connecting-ip` takes precedence when
  // the env flag opts in. The header is operator-controlled (Cloudflare
  // re-sets it on every request hitting its edge) so trusting it
  // bypasses the XFF trust-violation accounting entirely — there is no
  // chain to violate.
  const cfIp = readCfConnectingIp(request);
  if (cfIp) return { ip: cfIp, trustViolation: false };

  const hops = parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);

  if (hops > 0) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const chain = forwarded
        .split(",")
        .map((s) => s.trim())
        .filter(looksLikeIp);
      // Review finding M-3: when the chain is shorter than the configured
      // hops count, the operator misconfigured TRUST_PROXY_HOPS or a
      // proxy was bypassed. Falling back to the leftmost (now
      // attacker-controlled) entry would re-introduce the very rotation
      // attack TRUST_PROXY_HOPS was meant to close. Refuse to read XFF.
      if (chain.length >= hops) {
        return { ip: chain[chain.length - hops], trustViolation: false };
      }
      // F-6 (mobile security audit, 2026-05-16): emit a one-shot
      // operator signal when the chain shape doesn't match the
      // configured trust. Without this warning the silent degrade was
      // invisible until rate-limits visibly misfired in production.
      warnTrustViolationOnce(hops, chain.length);
      // Not x-real-ip either. A chain shorter than the configured hops means
      // the request did not come through the proxies the operator declared,
      // so whatever x-real-ip it carries was set by the caller.
      return { ip: null, trustViolation: true };
    }
    // x-real-ip is a forwarding header like XFF and gets the same trust: only
    // when the operator declares a proxy in front, and only as the
    // single-proxy stand-in for a missing XFF. It used to be read on every
    // path, including `TRUST_PROXY_HOPS=0` ("no proxy, trust no header") and
    // the broken-chain path above, so a caller sending a fresh x-real-ip per
    // request got a fresh per-IP rate-limit bucket each time.
    //
    // Exactly one hop, not "one or more". X-Real-IP holds a single address,
    // set by whichever proxy wrote it last; with two or more hops declared,
    // the outer proxy may pass through whatever the caller put there, and
    // the chain the hop count describes is the XFF chain, which is absent.
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (hops === 1) {
      return {
        ip: realIp && looksLikeIp(realIp) ? realIp : null,
        trustViolation: false,
      };
    }
    if (realIp) warnUnreadProxyHeadersOnce(hops, "X-Real-IP");
    return { ip: null, trustViolation: false };
  }
  const unread = request.headers.has("x-forwarded-for")
    ? "X-Forwarded-For"
    : request.headers.has("x-real-ip")
      ? "X-Real-IP"
      : null;
  if (unread) warnUnreadProxyHeadersOnce(hops, unread);
  return { ip: null, trustViolation: false };
}

export function getClientIp(request: Request): string | null {
  return getClientIpOrTrustWarning(request).ip;
}
