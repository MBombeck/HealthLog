import { NextResponse } from "next/server";

export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ data, error: null }, { status });
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
  meta?: {
    errorCode?: string;
    headers?: Record<string, string>;
  } & Record<string, unknown>,
) {
  const { headers, ...rest } = meta ?? {};
  const metaKeys = Object.keys(rest);
  return NextResponse.json(
    {
      data: null,
      error: message,
      ...(metaKeys.length > 0 ? { meta: rest } : {}),
    },
    {
      status,
      ...(headers ? { headers } : {}),
    },
  );
}

/**
 * Safely parse JSON body from a request.
 * Returns the parsed body or a 400 error response if parsing fails.
 */
export async function safeJson<T = unknown>(
  request: Request,
): Promise<{ data: T; error?: never } | { data?: never; error: Response }> {
  const ct = request.headers.get("content-type");
  if (!ct || !ct.includes("application/json")) {
    return { error: apiError("Content-Type must be application/json", 415) };
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
 * Returns the resolved IP or null when no trusted source is available.
 */
function looksLikeIp(s: string): boolean {
  return /^[0-9a-fA-F.:]+$/.test(s) && s.length >= 3 && s.length <= 45;
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

export function getClientIp(request: Request): string | null {
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
        return chain[chain.length - hops];
      }
      // F-6 (mobile security audit, 2026-05-16): emit a one-shot
      // operator signal when the chain shape doesn't match the
      // configured trust. Without this warning the silent degrade was
      // invisible until rate-limits visibly misfired in production.
      warnTrustViolationOnce(hops, chain.length);
    }
  }
  const realIp = request.headers.get("x-real-ip");
  return realIp && looksLikeIp(realIp) ? realIp : null;
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
 */
export function getClientIpOrTrustWarning(request: Request): {
  ip: string | null;
  trustViolation: boolean;
} {
  const hops = parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);

  if (hops > 0) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const chain = forwarded
        .split(",")
        .map((s) => s.trim())
        .filter(looksLikeIp);
      if (chain.length >= hops) {
        return { ip: chain[chain.length - hops], trustViolation: false };
      }
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
