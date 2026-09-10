/**
 * Authorization endpoint (OAuth 2.1 authorization-code flow + PKCE S256).
 *
 * This is the consent gate of the bridge AS. It is backed by HealthLog's
 * existing Postgres session (passkey / password login) — there is NO parallel
 * user store (ADR-006). The flow:
 *
 *   GET  — validate the request; if the caller has no session, prompt them to
 *          sign in (returning here); if they do, render a per-client CONSENT
 *          screen naming the client + the exact scope. NO code is ever issued on
 *          a GET (confused-deputy mitigation: a third party cannot silently
 *          obtain a grant — an authenticated human must click "Allow").
 *   POST — the consent decision. Requires a session, re-validates every
 *          parameter, and on "Allow" mints a single-use, short-lived,
 *          self-describing authorization code bound to this user + client +
 *          redirect URI + PKCE challenge + scope + audience, then 302s back.
 *
 * Mandatory gates, every request: PKCE `S256` (a missing / non-S256 challenge is
 * rejected), audience binding (`resource` MUST equal the canonical `/mcp` URI —
 * RFC 8707), and an exact redirect-URI match against the resolved client (with
 * port-agnostic loopback tolerance). Errors are returned directly (never
 * redirected to an unvalidated URI) so the endpoint is not an open redirector.
 */
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { auditLog } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import {
  audienceMatches,
  AUTH_CODE_TTL_SECONDS,
  isMcpOriginConfigured,
  resolveBaseOrigin,
  SCOPE_HEALTH_READ,
  SCOPE_HEALTH_WRITE,
} from "@/lib/mcp/oauth/config";
import { redirectUriAllowed, resolveClient } from "@/lib/mcp/oauth/clients";
import { isValidChallenge } from "@/lib/mcp/oauth/pkce";
import { signArtifact } from "@/lib/mcp/oauth/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTHORIZE_LIMIT = 60;
const AUTHORIZE_WINDOW_MS = 15 * 60 * 1000;

const baseParams = {
  response_type: z.string(),
  client_id: z.string().min(1).max(4096),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().min(1).max(256).optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().max(256).optional(),
  state: z.string().max(2048).optional(),
  resource: z.string().max(2048).optional(),
};

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badRequest(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400 },
  );
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HealthLog — Authorize access</title></head><body>${body}</body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

/**
 * The scopes this surface grants for a request. `health:read` is always
 * granted (the floor). `health:write` is granted ONLY when explicitly
 * requested (RFC 8707 / incremental consent, SEP-835) — it admits the
 * confirmed `/mcp` write tools and is surfaced plainly on the consent screen.
 * `offline_access` enables refresh continuity. Nothing else is ever granted.
 */
function grantScope(requested: string | undefined): string {
  const wants = new Set(
    (requested ?? SCOPE_HEALTH_READ).split(/\s+/).filter(Boolean),
  );
  const granted = [SCOPE_HEALTH_READ];
  if (wants.has(SCOPE_HEALTH_WRITE)) granted.push(SCOPE_HEALTH_WRITE);
  if (wants.has("offline_access")) granted.push("offline_access");
  return granted.join(" ");
}

interface ValidatedRequest {
  clientId: string;
  clientName: string;
  /** The VERIFIED client origin shown on the consent screen (L1). */
  clientOrigin: string;
  /** Registration provenance — drives the trust label on consent (L1). */
  clientSource: "cimd" | "dcr";
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  resource: string;
}

/**
 * The gate a request failed, pinned to a stable enum so the
 * `mcp.oauth.authorize.invalid` annotation stays dashboard-friendly. The
 * swallowed-reason gap (a bare `invalid` event) is exactly why the prod CIMD
 * failure was undiagnosable.
 */
type ValidateFailure =
  | "invalid_params"
  | "client_unresolved"
  | "redirect_mismatch"
  | "bad_response_type"
  | "pkce_required"
  | "audience_mismatch";

type ValidateMeta = {
  reason: ValidateFailure;
  /** For `client_unresolved`: the `resolveClient` reason. */
  clientReason?: string;
  /** For `client_unresolved`: a short, non-secret transport diagnostic. */
  detail?: string;
};

/** Shared validation for GET + POST. Returns a ready error Response on failure. */
async function validate(
  params: Record<string, string | undefined>,
  requestUrl: string,
): Promise<
  | { ok: true; v: ValidatedRequest }
  | { ok: false; res: Response; meta: ValidateMeta }
> {
  const parsed = z.object(baseParams).safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      res: badRequest("invalid_request", "Missing or malformed parameters"),
      meta: { reason: "invalid_params" },
    };
  }
  const p = parsed.data;

  // 1. Client must resolve (CIMD URL or stateless DCR id). Unknown → cannot
  //    safely redirect anywhere, so error directly.
  const resolved = await resolveClient(p.client_id);
  if (!resolved.ok) {
    return {
      ok: false,
      res: badRequest("invalid_client", "Unknown or unresolvable client"),
      meta: {
        reason: "client_unresolved",
        clientReason: resolved.reason,
        ...(resolved.detail ? { detail: resolved.detail } : {}),
      },
    };
  }

  // 2. Redirect URI MUST match the registration before we trust it.
  if (!redirectUriAllowed(p.redirect_uri, resolved.client.redirectUris)) {
    return {
      ok: false,
      res: badRequest(
        "invalid_request",
        "redirect_uri does not match the registered client",
      ),
      meta: { reason: "redirect_mismatch" },
    };
  }

  // 3. response_type — code only.
  if (p.response_type !== "code") {
    return {
      ok: false,
      res: badRequest(
        "unsupported_response_type",
        "Only response_type=code is supported",
      ),
      meta: { reason: "bad_response_type" },
    };
  }

  // 4. PKCE S256 is MANDATORY.
  if (
    p.code_challenge_method !== "S256" ||
    !isValidChallenge(p.code_challenge)
  ) {
    return {
      ok: false,
      res: badRequest(
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required",
      ),
      meta: { reason: "pkce_required" },
    };
  }

  // 5. Audience binding (RFC 8707) — resource MUST equal the canonical /mcp URI.
  if (!audienceMatches(p.resource, requestUrl)) {
    return {
      ok: false,
      res: badRequest(
        "invalid_target",
        "resource must equal this server's MCP endpoint",
      ),
      meta: { reason: "audience_mismatch" },
    };
  }

  // L1 — the VERIFIED origin. For CIMD the `client_id` IS the document URL, so
  // its host is cryptographically tied to the fetched-and-matched document; for
  // DCR there is no verified origin (anyone can self-register), so the consent
  // screen labels it unverified rather than trusting the self-asserted name.
  const clientOrigin =
    resolved.client.source === "cimd"
      ? (() => {
          try {
            return new URL(p.client_id).host;
          } catch {
            return p.client_id;
          }
        })()
      : "";

  return {
    ok: true,
    v: {
      clientId: p.client_id,
      clientName: resolved.client.clientName,
      clientOrigin,
      clientSource: resolved.client.source,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge as string,
      scope: grantScope(p.scope),
      state: p.state,
      resource: p.resource as string,
    },
  };
}

/**
 * L3 — same-origin assertion for the consent POST. A non-browser caller sends
 * neither `Origin` nor `Sec-Fetch-Site`, so their absence is allowed; a present
 * `Origin` that is not our own origin, or a `Sec-Fetch-Site` that is not
 * `same-origin`, is refused. Mirrors the `/mcp` DNS-rebinding posture.
 */
function consentOriginAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== resolveBaseOrigin(request.url)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return true;
}

function redirectBack(
  redirectUri: string,
  query: Record<string, string>,
): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

/** Whether the surface is available (M1 origin pinned + M4 kill-switch off). */
async function surfaceAvailable(): Promise<boolean> {
  return isMcpOriginConfigured() && (await isApiGloballyEnabled());
}

export async function GET(request: NextRequest): Promise<Response> {
  return withBackgroundEvent("mcp.oauth.authorize", async () => {
    if (!(await surfaceAvailable())) {
      return Response.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    }
    const rl = await checkAuthSurfaceRateLimit(
      request,
      "mcp:oauth:authorize",
      AUTHORIZE_LIMIT,
      AUTHORIZE_WINDOW_MS,
    );
    if (!rl.allowed) {
      return Response.json(
        { error: "temporarily_unavailable" },
        {
          status: 429,
          headers: rateLimitHeaders(rl),
        },
      );
    }

    const url = new URL(request.url);
    const params = Object.fromEntries(url.searchParams.entries());
    const result = await validate(params, request.url);
    if (!result.ok) {
      annotate({
        action: { name: "mcp.oauth.authorize.invalid" },
        meta: result.meta,
      });
      return result.res;
    }
    const { v } = result;

    const session = await getSession();
    if (!session) {
      // No identity yet — send the human to sign in, returning to this exact
      // request. NO grant is issued without an authenticated decision.
      const next = url.pathname + url.search;
      const loginHref = `/auth/login?next=${encodeURIComponent(next)}`;
      annotate({ action: { name: "mcp.oauth.authorize.login_required" } });
      return html(
        `<main><h1>Sign in to HealthLog</h1><p>To connect <strong>${htmlEscape(v.clientName)}</strong> you must sign in first.</p><p><a href="${htmlEscape(loginHref)}">Sign in and continue</a></p></main>`,
      );
    }

    annotate({ action: { name: "mcp.oauth.authorize.consent_shown" } });
    // Consent screen — a plain POST form (no inline script/style, CSP-safe).
    const hidden = (name: string, value: string) =>
      `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`;
    // L1 — show the VERIFIED origin (or an explicit "unverified" label for DCR)
    // next to the self-asserted name so the user authorizes who, not just what.
    const provenance =
      v.clientSource === "cimd"
        ? `<p>Verified origin: <code>${htmlEscape(v.clientOrigin)}</code></p>`
        : `<p><strong>Unverified application</strong> (dynamically registered — the name above is self-reported and not verified).</p>`;
    // Plain-language access summary. When write is granted, say so explicitly —
    // the app will be able to READ and LOG/WRITE health data, not just read.
    const writeGranted = v.scope.split(/\s+/).includes(SCOPE_HEALTH_WRITE);
    const accessSummary = writeGranted
      ? `<p><strong>This grants read AND write access:</strong> the application will be able to read your own health records <strong>and log new measurements and mood entries</strong> to your account on your behalf. It cannot delete or change existing entries, edit medications, or reach admin functions.</p>`
      : `<p>Scope: <code>${htmlEscape(v.scope)}</code> — read-only access to your own health records.</p>`;
    return html(
      `<main>
        <h1>Authorize access</h1>
        <p><strong>${htmlEscape(v.clientName)}</strong> is requesting access to your HealthLog data.</p>
        ${provenance}
        <p>Scope: <code>${htmlEscape(v.scope)}</code></p>
        ${accessSummary}
        <form method="POST" action="/api/mcp/oauth/authorize">
          ${hidden("response_type", "code")}
          ${hidden("client_id", v.clientId)}
          ${hidden("redirect_uri", v.redirectUri)}
          ${hidden("code_challenge", v.codeChallenge)}
          ${hidden("code_challenge_method", "S256")}
          ${hidden("scope", v.scope)}
          ${hidden("resource", v.resource)}
          ${v.state !== undefined ? hidden("state", v.state) : ""}
          <button type="submit" name="decision" value="allow">Allow</button>
          <button type="submit" name="decision" value="deny">Deny</button>
        </form>
      </main>`,
    );
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  return withBackgroundEvent("mcp.oauth.authorize", async () => {
    if (!(await surfaceAvailable())) {
      return Response.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    }

    // L3 — defence-in-depth same-origin assertion on the consent decision. The
    // session cookie is already SameSite=Lax (a cross-site POST carries none),
    // but reject an explicit cross-origin Origin / Sec-Fetch-Site outright so a
    // forged "allow" cannot ride a present session.
    if (!consentOriginAllowed(request)) {
      annotate({ action: { name: "mcp.oauth.authorize.cross_origin" } });
      return Response.json(
        { error: "access_denied", error_description: "Cross-origin POST" },
        { status: 403 },
      );
    }

    const rl = await checkAuthSurfaceRateLimit(
      request,
      "mcp:oauth:authorize",
      AUTHORIZE_LIMIT,
      AUTHORIZE_WINDOW_MS,
    );
    if (!rl.allowed) {
      return Response.json(
        { error: "temporarily_unavailable" },
        {
          status: 429,
          headers: rateLimitHeaders(rl),
        },
      );
    }

    // The consent decision MUST come from an authenticated human.
    const session = await getSession();
    if (!session) {
      annotate({
        action: { name: "mcp.oauth.authorize.decision_unauthenticated" },
      });
      return Response.json(
        { error: "access_denied", error_description: "Sign in required" },
        { status: 401 },
      );
    }

    const form = await request.formData();
    const params: Record<string, string | undefined> = {};
    for (const key of [
      "response_type",
      "client_id",
      "redirect_uri",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "state",
      "resource",
      "decision",
    ]) {
      const value = form.get(key);
      params[key] = typeof value === "string" ? value : undefined;
    }

    const result = await validate(params, request.url);
    if (!result.ok) {
      annotate({
        action: { name: "mcp.oauth.authorize.invalid" },
        meta: result.meta,
      });
      return result.res;
    }
    const { v } = result;

    // RFC 9207 — the authorization-server issuer identifier. Echoed on EVERY
    // authorization response (success AND error) so the client can pin the
    // response to this AS and reject a code from a substituted one.
    const iss = resolveBaseOrigin(request.url);

    if (params.decision !== "allow") {
      annotate({ action: { name: "mcp.oauth.authorize.denied" } });
      return redirectBack(v.redirectUri, {
        error: "access_denied",
        iss,
        ...(v.state !== undefined ? { state: v.state } : {}),
      });
    }

    const code = signArtifact(
      "authCode",
      {
        // `jti` makes the code single-use: the token endpoint claims it once
        // through the atomic rate-limit upsert, so a replay within the TTL is
        // rejected.
        jti: randomUUID(),
        sub: session.user.id,
        client_id: v.clientId,
        // Carried so the token endpoint can label the persistent connection
        // (H2) without re-resolving the client.
        client_name: v.clientName,
        redirect_uri: v.redirectUri,
        code_challenge: v.codeChallenge,
        scope: v.scope,
        resource: v.resource,
      },
      AUTH_CODE_TTL_SECONDS * 1000,
    );

    await auditLog("mcp.oauth.authorize.granted", {
      userId: session.user.id,
      details: { client_id: v.clientId, scope: v.scope },
    });
    annotate({ action: { name: "mcp.oauth.authorize.granted" } });

    return redirectBack(v.redirectUri, {
      code,
      iss,
      ...(v.state !== undefined ? { state: v.state } : {}),
    });
  });
}
