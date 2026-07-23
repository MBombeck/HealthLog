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
import { isP2002 } from "@/lib/prisma-errors";
import { decrypt, encrypt } from "@/lib/crypto";

const TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Claim TTL — how long an in-flight "pending" row is honoured before a
 * retry is allowed to re-run the handler. Bounds the blast radius of a
 * crashed handler that never wrote its result: the key self-heals after
 * this window instead of being locked for the full 24h response TTL.
 * Sized above the longest realistic write-handler latency.
 */
const PENDING_TTL_MS = 2 * 60 * 1000;
const SUPPORTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Sentinel `responseStatus` for a claimed-but-not-yet-completed row. A
 * real HTTP status is never 0, so `findCached` can distinguish an
 * in-flight claim from a cached response without a schema change.
 */
const PENDING_STATUS = 0;

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
 * Outcome of a key lookup:
 *   - `{ kind: "replay" }`  — a completed response is cached; replay it.
 *   - `{ kind: "pending" }` — another request holds an in-flight claim
 *                             for this key; the caller must NOT run the
 *                             handler again.
 *   - `null`                — no live row; the caller may claim + run.
 */
type CacheLookup =
  { kind: "replay"; response: NextResponse } | { kind: "pending" } | null;

/**
 * Look up the state of a (userId, key, method, path) tuple. Distinguishes
 * a completed cached response (replay) from an in-flight claim (pending)
 * via the `PENDING_STATUS` sentinel.
 */
async function findCached(ctx: IdempotencyContext): Promise<CacheLookup> {
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
    // Stale (completed row past its TTL, or a crashed claim past the
    // pending window) — purge and fall through so the retry re-runs.
    await prisma.idempotencyKey
      .delete({ where: { id: row.id } })
      .catch(() => {});
    return null;
  }

  if (row.responseStatus === PENDING_STATUS) {
    // A concurrent request claimed this key and is still running its
    // side-effect. Signal the caller to refuse rather than double-execute.
    return { kind: "pending" };
  }

  let parsed: unknown = null;
  try {
    // Rows written before the body was encrypted are plaintext JSON. Those
    // expire within the 24h replay window, so rather than migrate them, try
    // ciphertext first and fall back to a direct parse; the fallback becomes
    // dead within a day of deploy and is safe to remove after that.
    parsed = JSON.parse(decryptCachedBody(row.responseBody));
  } catch {
    parsed = null;
  }

  annotate({
    action: { name: "idempotency.replay" },
    meta: { method: ctx.method, path: ctx.path },
  });

  // Replay original status to keep client behaviour byte-identical.
  return {
    kind: "replay",
    response: NextResponse.json(parsed, {
      status: row.responseStatus,
      headers: {
        "X-Idempotent-Replay": "true",
      },
    }),
  };
}

/**
 * Atomically claim a key by inserting a `PENDING_STATUS` row under the
 * `(userId, key, method, path)` unique constraint BEFORE the handler
 * runs. Returns `true` when this caller won the claim, `false` when a
 * concurrent request already holds it (unique-constraint collision) so
 * the wrapper can refuse with 409 instead of double-executing the
 * side-effect. The claim carries a short `PENDING_TTL_MS` so a crashed
 * handler self-heals.
 */
async function claimKey(ctx: IdempotencyContext): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({
      data: {
        userId: ctx.userId,
        key: ctx.key,
        method: ctx.method,
        path: ctx.path,
        responseStatus: PENDING_STATUS,
        responseBody: "",
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });
    return true;
  } catch (err) {
    // Another request inserted the claim first — refuse this one.
    if (isP2002(err)) return false;
    throw err;
  }
}

/**
 * Release a claim that produced a non-cachable result (or threw) so a
 * later retry gets a fresh attempt rather than a stuck pending row.
 */
async function releaseClaim(ctx: IdempotencyContext): Promise<void> {
  await prisma.idempotencyKey
    .deleteMany({
      where: {
        userId: ctx.userId,
        key: ctx.key,
        method: ctx.method,
        path: ctx.path,
        responseStatus: PENDING_STATUS,
      },
    })
    .catch(() => {});
}

/**
 * Encrypt a cached response body at rest.
 *
 * The replay cache stores the response verbatim, and the PHI-returning creates
 * echo their own decrypted DTO — cycle day-log free text, reproductive-intent
 * fields, mood notes, allergy reactions. That is exactly what the `*Encrypted`
 * columns exist to protect, and it was sitting in cleartext for 24 hours in a
 * column that lands in every backup. The secret-shaped-body guard did not catch
 * it because health data is not secret-SHAPED.
 */
function encryptCachedBody(body: string): string | null {
  if (body.length === 0) return body;
  try {
    return encrypt(body);
  } catch {
    // The crypto loader is deliberately fail-closed: no key, malformed key map
    // or unknown key id all throw rather than silently writing plaintext. The
    // replay cache is an accelerator, not a correctness guarantee, so the right
    // response is to skip caching — never to store the body unprotected, and
    // never to fail the caller's write over a cache we could not populate.
    return null;
  }
}

/**
 * Read a cached body back, tolerating rows written before encryption.
 *
 * `decrypt` throws on anything that is not a well-formed envelope, so a legacy
 * plaintext row falls through to being returned as-is. Those rows age out
 * within the 24h replay window.
 */
function decryptCachedBody(stored: string): string {
  if (stored.length === 0) return stored;
  try {
    return decrypt(stored);
  } catch {
    return stored;
  }
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

  const storedBody = encryptCachedBody(body);
  if (storedBody === null) {
    // Could not encrypt — drop the claim rather than cache the body in the
    // clear. A later retry misses and re-runs the handler, which is the same
    // behaviour as any other cache miss.
    annotate({ meta: { idempotency_cache_skipped: "encryption_unavailable" } });
    await releaseClaim(ctx);
    return;
  }

  // Promote the claimed pending row to the completed response, extending
  // the TTL from the short claim window to the full 24h replay window.
  // The claim is held under the unique constraint, so this caller owns
  // the row — a plain update, not an upsert.
  await prisma.idempotencyKey
    .updateMany({
      where: {
        userId: ctx.userId,
        key: ctx.key,
        method: ctx.method,
        path: ctx.path,
      },
      data: {
        responseStatus: response.status,
        responseBody: storedBody,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    })
    .catch(() => {
      // The claim row vanished (e.g. purged as stale) — a future replay
      // will simply miss and re-run; never throw out of the cache path.
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
    if (cached?.kind === "replay") return cached.response;
    if (cached?.kind === "pending") {
      // A concurrent request is mid-flight on this exact key. Refuse
      // rather than run the side-effect a second time. The client should
      // retry after the in-flight request lands, at which point the
      // completed row replays.
      annotate({
        action: { name: "idempotency.inflight_conflict" },
        meta: { method: ctx.method, path: ctx.path },
      });
      return NextResponse.json(
        {
          data: null,
          error: {
            message:
              "A request with this Idempotency-Key is already in progress",
          },
        },
        { status: 409, headers: { "X-Idempotent-Replay": "false" } },
      );
    }

    // Claim the key before running the handler. If a racing request beats
    // us to the insert, treat it as the in-flight conflict above — only
    // one caller may execute the side-effect for a given key.
    const won = await claimKey(ctx);
    if (!won) {
      annotate({
        action: { name: "idempotency.inflight_conflict" },
        meta: { method: ctx.method, path: ctx.path },
      });
      return NextResponse.json(
        {
          data: null,
          error: {
            message:
              "A request with this Idempotency-Key is already in progress",
          },
        },
        { status: 409, headers: { "X-Idempotent-Replay": "false" } },
      );
    }

    let response: Response;
    try {
      response = await handler(...args);
    } catch (err) {
      // Handler threw — release the claim so a retry isn't locked out for
      // the full pending window, then re-throw to the error envelope.
      await releaseClaim(ctx);
      throw err;
    }

    const noStore = response.headers
      .get("Cache-Control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store");
    if (isCachableStatus(response.status) && !noStore) {
      // Defence-in-depth: never persist a body that carries a freshly-issued
      // bearer / refresh token or a third-party AI provider key. Auth and
      // settings routes shouldn't be wrapped in withIdempotency to begin
      // with, but if a future caller forgets we refuse to leak.
      //   `hlk_`    = our access tokens
      //   `hlr_`    = our refresh tokens
      //   `hls_`    = clinician share-link tokens (v1.11)
      //   `hlv_`    = registration invite tokens (v1.16 — the admin mint
      //               response is the one place the raw token appears)
      //   `sk-…`    = OpenAI / Anthropic keys (full token form, not the
      //               raw substring — a 422 body explaining "task-id…"
      //               or any other word containing `sk-` would otherwise
      //               silently break idempotency for benign retries).
      const SECRET_PATTERN =
        /(?:\b(?:hlk_|hlr_|hls_|hlv_|hle_)[A-Za-z0-9_-]+|\bsk-(?:ant-)?[A-Za-z0-9_-]{8,})/;
      const cloned = response.clone();
      const text = await cloned.text();
      if (!SECRET_PATTERN.test(text)) {
        await persistCached(ctx, response, text);
      } else {
        // Secret-shaped body — drop the claim so the key isn't left
        // pending (it was never going to cache).
        await releaseClaim(ctx);
      }
    } else {
      // Non-cachable status or an explicit `no-store` response releases the
      // claim so a retry gets a fresh attempt.
      await releaseClaim(ctx);
    }

    return response;
  };
}
