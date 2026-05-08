/**
 * Idempotency-Key support for write endpoints (POST/PUT/PATCH/DELETE).
 *
 * Mobile clients send `Idempotency-Key: <uuid>`. The first request runs
 * the handler normally and the response (status + body) is cached. Any
 * retry within the TTL (24h) for the same `(userId, key, method, path)`
 * tuple returns the cached envelope as a 200 (carrying the original
 * status inside the JSON if needed) — no second side-effect.
 */
import type { NextRequest } from "next/server";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/hmac";
import { annotate } from "@/lib/logging/context";

const TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const KEY_REGEX = /^[A-Za-z0-9_\-:.]{8,128}$/;

export interface IdempotencyContext {
  userId: string;
  key: string;
  method: string;
  path: string;
}

function getIdempotencyKey(request: Request | NextRequest): string | null {
  const raw = request.headers.get("idempotency-key");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!KEY_REGEX.test(trimmed)) return null;
  return trimmed;
}

/**
 * Look up a cached response for a (userId, key, method, path) tuple.
 * Returns the cached NextResponse or null.
 */
async function findCached(
  ctx: IdempotencyContext,
): Promise<NextResponse | null> {
  const row = await prisma.idempotencyKey.findUnique({
    where: {
      userId_key_method_path: {
        userId: ctx.userId,
        key: ctx.key,
        method: ctx.method,
        path: ctx.path,
      },
    },
  });

  if (!row) return null;
  if (row.expiresAt <= new Date()) {
    // Stale — purge and fall through.
    await prisma.idempotencyKey
      .delete({ where: { id: row.id } })
      .catch(() => {});
    return null;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.responseBody);
  } catch {
    parsed = null;
  }

  annotate({
    action: { name: "idempotency.replay" },
    meta: { method: ctx.method, path: ctx.path },
  });

  // Replay original status to keep client behaviour byte-identical.
  return NextResponse.json(parsed, {
    status: row.responseStatus,
    headers: {
      "X-Idempotent-Replay": "true",
    },
  });
}

async function persistCached(
  ctx: IdempotencyContext,
  response: Response,
  preReadBody?: string,
): Promise<void> {
  const body =
    preReadBody ??
    (await response
      .clone()
      .text()
      .catch(() => ""));

  await prisma.idempotencyKey
    .create({
      data: {
        userId: ctx.userId,
        key: ctx.key,
        method: ctx.method,
        path: ctx.path,
        responseStatus: response.status,
        responseBody: body,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    })
    .catch(() => {
      // Concurrent insert with the same key — the other writer wins.
      // Ignore because a future replay will hit their cached value.
    });
}

/**
 * Whether a response with the given HTTP status should be cached for
 * idempotent replay.
 *
 * Cached: any 2xx/3xx, plus 4xx-validation (so the same broken request
 * doesn't re-execute side-effects). Specifically NOT cached:
 *   401 — token may have expired between the original call and the retry
 *   403 — likewise authorization can change
 *   408 — caller timed out, retry deserves a fresh attempt
 *   429 — caller hit a rate-limit, retry deserves a fresh window check
 *   5xx — server fault, retry must not be locked into a bogus result
 *
 * Exported so the do-not-cache contract is unit-tested independently of
 * the database-backed wrapper.
 */
export function isCachableStatus(status: number): boolean {
  if (status < 400) return true;
  if (status >= 500) return false;
  if (status === 401 || status === 403 || status === 408 || status === 429) {
    return false;
  }
  return true;
}

/**
 * Default resolver: cookie session first, then Bearer token. The Bearer
 * fallback is what makes idempotency actually fire for native iOS / n8n
 * /external clients — without it, every Bearer-authed retry was running
 * the handler again and creating duplicate measurements (audit C-4).
 *
 * Exported for unit testing; production callers should let
 * `withIdempotency()` pick this up automatically via its default arg.
 */
export async function defaultUserIdResolver(): Promise<string | null> {
  const session = await getSession().catch(() => null);
  if (session) return session.user.id;

  let authHeader: string | null = null;
  try {
    const headerList = await headers();
    authHeader = headerList.get("authorization");
  } catch {
    authHeader = null;
  }
  if (!authHeader?.startsWith("Bearer ")) return null;

  const tokenHashValue = hashToken(authHeader.slice(7));
  const apiToken = await prisma.apiToken
    .findUnique({
      where: { tokenHash: tokenHashValue },
      select: { userId: true, revoked: true, expiresAt: true },
    })
    .catch(() => null);

  if (!apiToken || apiToken.revoked) return null;
  if (apiToken.expiresAt && apiToken.expiresAt <= new Date()) return null;
  return apiToken.userId;
}

/**
 * Wrap a write handler so a repeat call with the same `Idempotency-Key`
 * (and same userId/method/path) returns the originally cached response.
 *
 * The wrapped handler is responsible for authentication itself — this
 * helper only triggers for methods in {POST, PUT, PATCH, DELETE} and only
 * once `userIdResolver` returns a non-null value. The default resolver
 * supports both cookie sessions and Bearer-token clients; pass a custom
 * resolver only for routes that authenticate via something exotic.
 *
 * No-op when the header is missing or the value is malformed.
 */
export function withIdempotency<
  Args extends [Request | NextRequest, ...unknown[]],
>(
  handler: (...args: Args) => Promise<Response>,
  userIdResolver: (
    ...args: Args
  ) => Promise<string | null> = defaultUserIdResolver,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    const request = args[0];
    if (!SUPPORTED_METHODS.has(request.method)) {
      return handler(...args);
    }

    const key = getIdempotencyKey(request);
    if (!key) return handler(...args);

    const userId = await userIdResolver(...args);
    if (!userId) return handler(...args);

    const url = new URL(request.url);
    const ctx: IdempotencyContext = {
      userId,
      key,
      method: request.method,
      path: url.pathname,
    };

    const cached = await findCached(ctx);
    if (cached) return cached;

    const response = await handler(...args);

    if (isCachableStatus(response.status)) {
      // Defence-in-depth: never persist a body that carries a freshly-issued
      // bearer or refresh token. Auth routes shouldn't be wrapped in
      // withIdempotency to begin with, but if a future caller forgets we
      // refuse to leak. `hlk_` = access tokens, `hlr_` = refresh tokens.
      const cloned = response.clone();
      const text = await cloned.text();
      if (!text.includes("hlk_") && !text.includes("hlr_")) {
        await persistCached(ctx, response, text);
      }
    }

    return response;
  };
}
