/**
 * Dynamic Client Registration (RFC 7591) — the DCR fallback for clients that
 * do not present a CIMD `client_id` URL.
 *
 * Registration is STATELESS: the issued `client_id` is a signed, self-describing
 * `hlc_` artifact carrying the registered `redirect_uris` + name (see
 * `clients.ts` / `artifacts.ts`), so no client row is written. The endpoint only
 * validates the metadata, enforces a per-IP rate limit (it is unauthenticated),
 * and returns the RFC 7591 client-information response for a PUBLIC client
 * (`token_endpoint_auth_method: "none"` — PKCE is the proof, there is no secret).
 *
 * Redirect URIs are shape-validated here; the AUTHORITATIVE redirect-URI match
 * happens at `/authorize` against the decoded registration.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { readBodyCapped } from "@/lib/http/read-capped";
import {
  isAllowableRedirectUri,
  registerDcrClient,
} from "@/lib/mcp/oauth/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const registrationSchema = z.object({
  redirect_uris: z
    .array(z.string().min(1).max(2048))
    .min(1)
    .max(12)
    .refine((uris) => uris.every(isAllowableRedirectUri), {
      message: "redirect_uris must be HTTPS or http loopback URLs",
    }),
  client_name: z.string().min(1).max(200).optional(),
  // OIDC dynamic-registration `application_type` (forward-compat with OIDC-style
  // clients): honoured by echoing it back, validated to the closed set so a
  // malformed value is rejected cleanly rather than silently dropped. Absent ⇒
  // the OIDC default `web`. It does not alter the redirect-URI rules — those are
  // already shape-validated below and authoritatively matched at `/authorize`.
  application_type: z.enum(["web", "native"]).optional(),
  // Accepted-and-ignored RFC 7591 fields (we never read them but tolerate them).
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
});

function oauthError(
  error: string,
  description: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: extraHeaders },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  return withBackgroundEvent("mcp.oauth.register", async () => {
    const rl = await checkAuthSurfaceRateLimit(
      request,
      "mcp:oauth:register",
      REGISTER_LIMIT,
      REGISTER_WINDOW_MS,
    );
    if (!rl.allowed) {
      annotate({ action: { name: "mcp.oauth.register.rate_limited" } });
      return Response.json(
        { error: "temporarily_unavailable" },
        {
          status: 429,
          headers: rateLimitHeaders(rl),
        },
      );
    }

    // M4 — the operator API kill-switch covers the OAuth surface too.
    if (!(await isApiGloballyEnabled())) {
      return oauthError("temporarily_unavailable", "API is disabled", 503);
    }

    // M3 — enforce the cap WHILE reading the (unauthenticated) registration
    // body so a hostile client cannot buffer an oversized payload first.
    const read = await readBodyCapped(request, MAX_BODY_BYTES);
    if (!read.ok) {
      return oauthError("invalid_client_metadata", "Payload too large", 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(read.text);
    } catch {
      return oauthError("invalid_client_metadata", "Invalid JSON", 400);
    }

    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      annotate({ action: { name: "mcp.oauth.register.invalid" } });
      return oauthError(
        "invalid_client_metadata",
        "redirect_uris is required and must contain HTTPS or loopback URLs",
        400,
      );
    }

    const applicationType = parsed.data.application_type ?? "web";

    const client = registerDcrClient({
      clientName: parsed.data.client_name ?? "MCP client",
      redirectUris: parsed.data.redirect_uris,
    });

    annotate({
      action: { name: "mcp.oauth.register.issued" },
      meta: { source: "dcr", redirect_uri_count: client.redirectUris.length },
    });

    // RFC 7591 client-information response for a public client.
    return Response.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirectUris,
        client_name: client.clientName,
        application_type: applicationType,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201 },
    );
  });
}
