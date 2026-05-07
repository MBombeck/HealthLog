import { NextResponse } from "next/server";

export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ data, error: null }, { status });
}

export function apiError(message: string, status = 400) {
  return NextResponse.json({ data: null, error: message }, { status });
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
    }
  }
  const realIp = request.headers.get("x-real-ip");
  return realIp && looksLikeIp(realIp) ? realIp : null;
}
