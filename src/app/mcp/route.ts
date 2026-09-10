/**
 * Remote MCP endpoint — Streamable HTTP transport.
 *
 * Exposes the SAME read-only tool / resource layer the stdio transport
 * serves (`src/lib/mcp/`) over HTTP, so a remote MCP client (Claude.ai /
 * ChatGPT / the hosted-or-iOS crowd) can connect with a manually-minted
 * `hlk_<hex>` Bearer token before full OAuth lands (ADR-002 / ADR-006). The
 * wire protocol — JSON-RPC framing, capability negotiation, the
 * GET/POST/DELETE method matrix — is the official SDK's
 * `WebStandardStreamableHTTPServerTransport`; this route only owns the four
 * HealthLog-specific gates in front of it:
 *
 *   1. AUTH — `Authorization: Bearer hlk_…` resolved by the SAME validator
 *      the HTTP edge uses (`resolveMcpAuthContext` → `resolveBearerToken`),
 *      so revoked / expired / scope semantics never drift between the stdio,
 *      remote, and REST wires. A cookie is never consulted — the wire
 *      carries none — so the cookie-only `requireAdmin()` boundary is
 *      unreachable here by construction (ADR-005 / REQ-SEC-7). No token,
 *      a malformed header, or a rejected token all answer one blunt 401.
 *
 *   2. RATE LIMIT — the Postgres limiter keyed by the `<userId>:<tokenId>`
 *      binding (`mcp:<binding>`), so a single leaked / shared credential
 *      cannot drain the account's other tokens (REQ-SEC-9 / REQ-SEC-11).
 *
 *   3. MODULE GATE — the `mcp` module is OPT-IN (off by default). With the
 *      module off the surface answers 404 and reveals nothing — a
 *      self-hoster who never opts in gets zero new exposure (ADR-007 /
 *      REQ-OPS-1).
 *
 *   4. TRANSPORT — a fresh stateless server + transport per request
 *      (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), torn
 *      down once the buffered JSON-RPC response is built.
 *
 * Write surface: the factory registers the confirmed write tools
 * (`log_measurement` / `log_mood`) ONLY for a `health:write`-scoped session;
 * a read-only token never sees them. Writes happen in-process here and are
 * audience-bound to `/mcp` — a `health:write` MCP token is refused on every
 * REST write/delete by the resource-server guard in `api-handler.ts`, so it
 * can never become a general REST write credential. `requireAdmin()` stays
 * cookie-only, so admin is unreachable over this wire regardless of token
 * scope — including `["*"]` (ADR-003 / ADR-005).
 *
 * Same-origin / no-CORS by construction: no `Access-Control-Allow-Origin`
 * header is emitted anywhere here, matching the app-wide posture.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  createMcpServer,
  resolveMcpAuthContext,
  SCOPE_HEALTH_READ,
} from "@/lib/mcp";
import { withBackgroundEvent } from "@/lib/logging/background";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkMcpRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import type { RateLimitSnapshot } from "@/lib/rate-limit-context";
import {
  isMcpOriginConfigured,
  resolveBaseOrigin,
} from "@/lib/mcp/oauth/config";
import { wwwAuthenticateChallenge } from "@/lib/mcp/oauth/metadata";
import type { ModuleKey } from "@/lib/modules/registry";

// The Bearer resolver + module gate + rate limiter all touch Prisma, so the
// route must run on the Node runtime, never the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MCP_MODULE: ModuleKey = "mcp";

/**
 * One blunt 401 for every authentication failure class — no oracle. The
 * `WWW-Authenticate` carries the RFC 9728 `resource_metadata` pointer so a
 * remote client can discover the Authorization Server and start the OAuth flow
 * (REQ-T3). An optional `scope` drives incremental consent (SEP-835).
 */
function unauthorized(request: Request, scope?: string): Response {
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": wwwAuthenticateChallenge(request.url, scope),
      },
    },
  );
}

/**
 * DNS-rebinding defense (MCP spec PR #1439): reject a request whose `Origin`
 * header does not match this deployment's own origin with a 403. A non-browser
 * MCP client (Claude.ai / ChatGPT server-side) sends no `Origin`, so the absence
 * of the header is allowed; only a present, mismatched browser `Origin` is
 * refused — closing the rebinding hole without breaking the real clients.
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === resolveBaseOrigin(request.url);
}

function forbiddenOrigin(): Response {
  return Response.json({ error: "forbidden_origin" }, { status: 403 });
}

/**
 * Module off → the surface does not exist for this account. A 404 (not a
 * 403) keeps the remote endpoint invisible until the operator / user opts
 * in, so a disabled instance leaks nothing about it.
 */
function moduleDisabled(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** 429 with the standard rate-limit headers. */
function tooManyRequests(rl: RateLimitSnapshot): Response {
  const response = Response.json({ error: "rate_limited" }, { status: 429 });
  for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(k, v);
  }
  return response;
}

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

async function handleMcp(request: Request): Promise<Response> {
  return withBackgroundEvent("mcp.request", async () => {
    // 0. ORIGIN — refuse a cross-origin browser request before anything else.
    if (!originAllowed(request)) {
      annotate({ action: { name: "mcp.origin.rejected" } });
      return forbiddenOrigin();
    }

    // 0a. KILL-SWITCH + ORIGIN CONFIG — M1 fails closed without a pinned
    //     origin; M4 honours the operator's global API switch. Both answer the
    //     same invisible 404 as the module-off posture so a disabled instance
    //     leaks nothing.
    if (!isMcpOriginConfigured() || !(await isApiGloballyEnabled())) {
      annotate({ action: { name: "mcp.surface.unavailable" } });
      return moduleDisabled();
    }

    // 1. AUTH — Bearer only; a cookie is never consulted (admin unreachable).
    const raw = readBearer(request);
    if (!raw) {
      annotate({ action: { name: "mcp.auth.missing" } });
      return unauthorized(request);
    }

    let ctx;
    try {
      ctx = await resolveMcpAuthContext(raw);
    } catch {
      // Do not echo the token or the rejection reason — one blunt 401.
      annotate({ action: { name: "mcp.auth.rejected" } });
      return unauthorized(request);
    }

    // Authorization is distinct from credential validity. A write-only or
    // unrelated bearer is still a real token, but it must not reach rate
    // limiting, module discovery, server construction, or any health reader.
    if (!ctx.canRead) {
      annotate({ action: { name: "mcp.auth.insufficient_scope" } });
      return unauthorized(request, SCOPE_HEALTH_READ);
    }

    // 2. RATE LIMIT — per `<userId>:<tokenId>` credential binding.
    const rl = await checkMcpRateLimit(ctx.binding);
    if (!rl.allowed) {
      annotate({ action: { name: "mcp.rate_limited" } });
      return tooManyRequests(rl);
    }

    // 3. MODULE GATE — off by default; hide the surface entirely when off.
    if (!(await isModuleEnabled(ctx.userId, MCP_MODULE))) {
      annotate({ action: { name: "mcp.module.disabled" } });
      return moduleDisabled();
    }

    // 4. TRANSPORT — stateless: one fresh server + transport per request.
    annotate({
      action: { name: "mcp.request.served" },
      meta: { method: request.method },
    });

    const server = createMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless mode — no server-held session; each request stands alone.
      sessionIdGenerator: undefined,
      // Buffer a single JSON-RPC response instead of opening an SSE stream;
      // the read tools return one structured result per call.
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      // In JSON-response stateless mode the returned Response is fully
      // buffered before this resolves, so tearing the transport down in the
      // `finally` cannot truncate it.
      return await transport.handleRequest(request);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
