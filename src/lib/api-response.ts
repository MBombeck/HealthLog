import { isIP } from "node:net";
import { NextResponse } from "next/server";
import type { ZodError, ZodIssue } from "zod/v4";

export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ data, error: null }, { status });
}

/**
 * Sanitised view of a single Zod issue. We surface `path`, `code` and
 * `message` only — `issue.params` may echo the offending user input
 * (e.g. a too-long string, a regex source) and we do not want that
 * round-tripped to mobile callers or persisted into the audit ledger.
 */
export interface SanitisedZodIssue {
  path: string;
  code: string;
  message: string;
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
   * Only `path` + `code` survive — enough for an operator to triage
   * the rejection without persisting user-typed content. Default is
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
    return issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
    }));
  }
  return issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
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
export function apiError(
  message: string,
  status = 400,
  meta?: ErrorMeta,
) {
  return buildJsonErrorResponse({ data: null, error: message }, status, meta);
}

/**
 * Safely parse JSON body from a request.
 * Returns the parsed body or a 400 error response if parsing fails.
 *
 * `opts.maxBytes` opts a route into a hard body-size cap. The check
 * runs against the raw text rather than the parsed object, so a
 * gigabyte payload never reaches `JSON.parse` and never lands in
 * heap. Single-record routes can pass a tight cap (a few KB); batch
 * routes that legitimately accept large payloads can pass a larger
 * one (a few hundred KB). When `maxBytes` is omitted the route
 * inherits the Next.js runtime default — pre-existing behaviour, no
 * regression risk for callers that haven't adopted the parameter.
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
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return { error: apiError("Invalid request body", 400) };
    }
    if (raw.length > opts.maxBytes) {
      return {
        error: apiError(
          `Request body exceeds ${opts.maxBytes} bytes`,
          413,
        ),
      };
    }
    try {
      const data = JSON.parse(raw) as T;
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
 *   - "0"          → ignore XFF entirely, fall back to x-real-ip / null
 *                    (use this if HealthLog is internet-facing without a
 *                    reverse proxy you control)
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
  if (raw === undefined) return 1;
  const trimmed = raw.trim();
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
      const realIp = request.headers.get("x-real-ip");
      return {
        ip: realIp && looksLikeIp(realIp) ? realIp : null,
        trustViolation: true,
      };
    }
  }
  const realIp = request.headers.get("x-real-ip");
  return {
    ip: realIp && looksLikeIp(realIp) ? realIp : null,
    trustViolation: false,
  };
}

export function getClientIp(request: Request): string | null {
  return getClientIpOrTrustWarning(request).ip;
}
