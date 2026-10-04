/**
 * Idempotency-Key support for write endpoints (POST/PUT/PATCH/DELETE).
 *
 * Mobile clients send `Idempotency-Key: <uuid>`. The first request runs
 * the handler normally and the response (status + body) is cached. Any
 * retry within the TTL (24h) for the same `(userId, key, method, path)`
 * tuple returns the cached envelope as a 200 (carrying the original
 * status inside the JSON if needed) — no second side-effect.
 *
 * `userId` is the CALLER. Since a caller can act on somebody else's record,
 * the record the request claims is folded into `key` (see `cellKey`), so the
 * tuple identifies a request to one person's record rather than a request by
 * one person. A caller acting only as themselves is unaffected, byte for byte.
 *
 * A cell also remembers WHICH request it answered: a SHA-256 of the canonical
 * request body (`requestFingerprint`). A key names one request, not a slot, and
 * a client that reuses a key for a second, different request must not be
 * handed the first request's response. Native clients up to 1.1.0 sent the two
 * halves of a manual blood pressure as two POSTs under one key; the second half
 * replayed the first's 201 and was never written. A lookup therefore replays,
 * or reports in-flight, only for the same body. A different body — or a row
 * written before fingerprints existed — runs the handler normally without
 * claiming or caching anything, and the existing cell stays for its own
 * retries. This is deliberately not the IETF draft's 422: refusing would turn
 * every affected client's second write into a visible error with no way for
 * the person to recover the value.
 */
import type { NextRequest } from "next/server";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import {
  readClaimedRecordContext,
  selectorNamesAnAccount,
} from "@/lib/auth/acting-carrier";
import { refuseStaleRecordSessionClaim } from "@/lib/sharing/record-session-fence";
import { hashToken } from "@/lib/auth/hmac";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import { findActiveGrant } from "@/lib/sharing/grants";
import { decrypt, encrypt } from "@/lib/crypto";
import { createHash } from "node:crypto";
import { looksSecretShaped } from "@/lib/secret-shape";

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

/**
 * Separates the record from the client's key inside a cell's `key` column.
 *
 * `KEY_REGEX` above does not admit it, which is the whole reason it was
 * chosen: a caller cannot hand-craft a key that lands in the cell of a request
 * they are not making. Changing either one without the other reopens that.
 */
const RECORD_SEPARATOR = "|";

/**
 * The `key` column for a request, given the record it claims to act on.
 *
 * Why the key and not the owner column: `IdempotencyKey.userId` is a foreign
 * key to `users` with a cascade behind it (`prisma/schema.prisma`), so it can
 * hold one real account id and nothing composite. It keeps holding the ACTOR —
 * which is what makes "two delegates, one owner, one key" two cells without
 * anything extra — and the record joins the other half of the composite unique
 * index instead.
 *
 * No carrier means the key the client sent, byte for byte. Every request that
 * is nobody's delegate therefore files exactly where it filed before, and the
 * fold cannot change the behaviour of a client that never heard of sharing.
 *
 * The cell a request reads and claims, since v1.38.11:
 *
 * An own-record request under a cookie session or a wildcard token is keyed
 * byte-for-byte as the client sent it — that contract is frozen by the unit
 * tests and is what every existing client's retry depends on. Everything else
 * folds the authority the request carries into the key, so a cell can only be
 * hit again by a request the handler would answer the same way:
 *
 * - a delegated request carries the grant it acts under (`delegatedGrantFacet`),
 *   so a replaced or narrowed grant lands in a fresh cell and reaches the
 *   handler's own refusal instead of an earlier response;
 * - a narrow-scoped Bearer token carries its own identity (`narrowTokenFacet`),
 *   so it replays only what it wrote itself and never a wildcard credential's
 *   response on a route outside its scope.
 *
 * The handler's `requireRecordAuth` remains the authority; the key only makes
 * sure the cache cannot answer for a credential the handler has not seen.
 */
function cellKey(
  clientKey: string,
  actingAccountId: string | null,
  facets: readonly string[],
): string {
  const parts = [
    ...(actingAccountId === null ? [] : [actingAccountId]),
    ...facets,
    clientKey,
  ];
  return parts.join(RECORD_SEPARATOR);
}

export interface IdempotencyContext {
  userId: string;
  key: string;
  method: string;
  path: string;
  /** See `requestFingerprint`. Never the body itself. */
  fingerprint: string;
}

/**
 * How much of a body the fingerprint reads before it stops. The wrapper runs
 * before the handler's own bounded readers and upload slots, so it must not
 * buffer an arbitrarily large body on their behalf: reading the clone holds
 * what it has read in the original's queue until the handler consumes it.
 * Every JSON write the cache fronts is far below this; the one multipart route
 * (document upload) is above it, and there the prefix plus the declared length
 * identifies a retry of the same upload, with the route's own content hash as
 * the duplicate check behind it.
 */
const FINGERPRINT_MAX_BYTES = 1024 * 1024;

/**
 * JSON with every object's keys sorted, recursively. Arrays keep their order —
 * it is part of the request. Exported for its unit tests.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Replace every occurrence of the multipart boundary named in `contentType`
 * with a fixed token. Any other body is returned as it is.
 */
function withoutMultipartBoundary(
  body: Uint8Array,
  contentType: string | null,
): Uint8Array {
  if (!contentType || !/^multipart\//i.test(contentType)) return body;
  const match = /;\s*boundary="?([^";]+)"?/i.exec(contentType);
  if (!match) return body;
  const boundary = Buffer.from(match[1], "utf8");
  const token = Buffer.from("boundary", "utf8");
  const source = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const parts: Buffer[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(boundary, from);
    if (at === -1) break;
    parts.push(source.subarray(from, at), token);
    from = at + boundary.length;
  }
  if (parts.length === 0) return body;
  parts.push(source.subarray(from));
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * The fingerprint of a request: SHA-256 hex over method, path and the body in
 * canonical form. A body that parses as JSON is hashed as `canonicalJson`, so
 * the same object serialised with a different key order is the same request;
 * anything else (multipart, plain text, an empty body) is hashed as its raw
 * bytes. `truncatedAt` marks a body cut at `FINGERPRINT_MAX_BYTES`, hashed as
 * that raw prefix together with the declared length. A multipart body has its
 * boundary replaced by a fixed token first: a client that rebuilds the form
 * for a retry picks a fresh random boundary, and the same upload must still
 * replay. Exported for unit tests.
 */
export function requestFingerprint(
  method: string,
  path: string,
  rawBody: Uint8Array,
  truncatedAt: string | null = null,
  contentType: string | null = null,
): string {
  const body = withoutMultipartBoundary(rawBody, contentType);
  const hash = createHash("sha256")
    .update(method)
    .update("\0")
    .update(path)
    .update("\0");
  if (truncatedAt !== null) {
    return hash.update(`partial:${truncatedAt}\0`).update(body).digest("hex");
  }
  if (body.length > 0) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      return hash
        .update("json:")
        .update(canonicalJson(JSON.parse(text)))
        .digest("hex");
    } catch {
      // Not UTF-8 or not JSON — fall through to the raw bytes.
    }
  }
  return hash.update("raw:").update(body).digest("hex");
}

/**
 * Read the request's body from a clone, at most `FINGERPRINT_MAX_BYTES`, and
 * fingerprint it. The original request keeps its body for the handler.
 */
async function fingerprintRequest(
  request: Request | NextRequest,
  path: string,
): Promise<string> {
  const stream = request.clone().body;
  if (!stream)
    return requestFingerprint(request.method, path, new Uint8Array());
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > FINGERPRINT_MAX_BYTES) {
      chunks.push(value.subarray(0, FINGERPRINT_MAX_BYTES - total));
      total = FINGERPRINT_MAX_BYTES;
      truncated = true;
      // Cancelling this branch of the tee stops it from queueing the rest of
      // the body, and leaves the handler's branch intact. Not awaited: a tee
      // branch's cancel settles only once BOTH branches are done, which is
      // after the handler has run.
      void reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return requestFingerprint(
    request.method,
    path,
    body,
    truncated ? (request.headers.get("content-length") ?? "unknown") : null,
    request.headers.get("content-type"),
  );
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
 *   - `{ kind: "mismatch" }` — the live row answered a different body (or
 *                             predates fingerprints); the caller runs the
 *                             handler without claiming or caching.
 *   - `null`                — no live row; the caller may claim + run.
 */
type CacheLookup =
  | { kind: "replay"; response: NextResponse }
  | { kind: "pending" }
  | { kind: "mismatch" }
  | null;

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

  // Checked before both the pending and the replay arm: a different request
  // under the same key is neither in flight nor answered. A legacy row's null
  // never equals a fingerprint.
  if (row.requestFingerprint !== ctx.fingerprint) {
    return { kind: "mismatch" };
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
        requestFingerprint: ctx.fingerprint,
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
        requestFingerprint: ctx.fingerprint,
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
        requestFingerprint: ctx.fingerprint,
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
 * It resolves the CALLER and only the caller — which record they are aiming at
 * is a separate question, answered by `readClaimedRecordContext()` above and
 * folded into the key. Neither answer authorises anything: the handler runs
 * its own `requireAuth()` / `requireRecordAuth()` either way.
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
/**
 * The 409 both in-flight arms return.
 *
 * `error` is a STRING, matching the envelope `@/lib/api-response` defines
 * for every other route (`{ data: null, error: <prose>, meta? }`). Until
 * v1.35.1 these two literals sent `error` as `{ message }` — the only
 * object-shaped error the app ever emitted, inherited by every route under
 * `withIdempotency`, and never what the published contract promised. A
 * client decoding the documented envelope now gets what it was generated
 * against.
 *
 * Built once rather than twice so the two arms cannot drift apart again.
 * The response is hand-built rather than routed through `apiError` because
 * the 409 carries the `X-Idempotent-Replay` header.
 */
function inflightConflictResponse(): Response {
  return NextResponse.json(
    {
      data: null,
      error: "A request with this Idempotency-Key is already in progress",
    },
    { status: 409, headers: { "X-Idempotent-Replay": "false" } },
  );
}

/**
 * The grant a delegated request acts under, as a key facet — or `null` when
 * there is no live grant, in which case the request must not touch a cell at
 * all and the handler issues its own refusal.
 *
 * The wrapper runs before a route can call `requireRecordAuth`, and it must
 * not become an alternate way around that check. Until v1.38.11 the grant was
 * consulted at replay time, but only for its existence: a delegate whose grant
 * had been replaced by a narrower one, or whose scope had been edited in
 * place, still matched the cell they filled under the wider grant and were
 * handed that body back. Folding the grant's identity, level and scope into
 * the key means a cell is reachable only under the exact authority it was
 * written under; any change lands the retry in a fresh cell, where the handler
 * decides. A missing, expired, revoked, or unreadable grant reads as `null` —
 * the cache is an accelerator, and falling through to the handler is always
 * the safe answer.
 */
async function delegatedGrantFacet(
  actorUserId: string,
  recordUserId: string,
): Promise<string | null> {
  try {
    const grant = await findActiveGrant({
      grantorId: recordUserId,
      granteeId: actorUserId,
    });
    if (!grant) return null;
    const scopeFingerprint = createHash("sha256")
      .update(JSON.stringify(grant.scopeJson ?? null))
      .digest("hex")
      .slice(0, 16);
    return `g:${grant.id}:${grant.access}:${scopeFingerprint}`;
  } catch {
    return null;
  }
}

/**
 * The identity of a narrow, single-purpose Bearer token, as a key facet — or
 * `null` for a cookie session, a wildcard token, or no Bearer header.
 *
 * A narrow token is refused delegation outright by `requireRecordAuth`, and
 * refused any own-record route outside its scope by `requireAuth`. Neither
 * refusal is cachable, so a narrow token can never fill a cell it should not
 * have; what it could do, before v1.38.11, was READ one: the own-record cell
 * is keyed by account, and a wildcard credential of the same account had
 * filled it. Keying the narrow token's cells by the token itself keeps its own
 * retries idempotent — an ingest client re-posting after a timeout still
 * replays — while no cell written by another credential is reachable to it.
 *
 * Authorises nothing. An unreadable token reads as narrow, and then keys by
 * the presented hash: falling into a private cell is always safe. One indexed
 * single-row read, only when a Bearer header is present.
 */
async function narrowTokenFacet(): Promise<string | null> {
  let authHeader: string | null = null;
  try {
    const headerList = await headers();
    authHeader = headerList.get("authorization");
  } catch {
    return null;
  }
  if (!authHeader?.startsWith("Bearer ")) return null;

  const presentedHash = hashToken(authHeader.slice(7));
  const apiToken = await prisma.apiToken
    .findUnique({
      where: { tokenHash: presentedHash },
      select: { id: true, permissions: true },
    })
    .catch(() => null);

  if (!apiToken) return `t:${presentedHash.slice(0, 32)}`;
  return apiToken.permissions.includes("*") ? null : `t:${apiToken.id}`;
}

/**
 * Run a request whose key is already taken by a different body: the handler
 * runs exactly as it would without a key, and nothing is claimed or cached, so
 * the existing cell keeps answering its own retries.
 */
function runUncached<Args extends [Request | NextRequest, ...unknown[]]>(
  ctx: IdempotencyContext,
  handler: (...args: Args) => Promise<Response>,
  args: Args,
): Promise<Response> {
  annotate({
    action: { name: "idempotency.key.body_mismatch" },
    meta: { method: ctx.method, path: ctx.path },
  });
  return handler(...args);
}

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

    // Which RECORD this request is aimed at, as claimed by the transport and
    // not yet checked against a grant — the check belongs to the handler, and
    // this runs before it. One delegate posting the same key first for one
    // person and then for another must not meet themselves in a single cell:
    // that replays the first person's response, writes nothing to the second
    // person's record, and reports success. Nothing errors and nothing logs a
    // conflict, which is why it is folded here rather than left to call sites.
    //
    // A claim only chooses the cache cell. It never carries authority: a
    // completed delegated cell is checked against the current grant again
    // immediately before its body can be returned below.
    const claim = await readClaimedRecordContext();

    // v1.37.0 — the record-session fence, evaluated HERE and not one line
    // lower. A stale request must not learn whether a cell exists, must not
    // replay a body out of one, and must not insert a claim row — so the
    // verdict sits above `findCached` and above the two carrier arms below,
    // which choose the cell. It is the second, independent evaluation of the
    // same client assertion (the handler's own `requireRecordAuth` is the
    // other) and nothing is carried between them; see the note on
    // `refuseStaleRecordSessionClaim`.
    //
    // Only `stale` refuses here. An `unfenced-client` verdict falls through so
    // the route issues the 403 a pre-fence bundle already recovers from, with
    // the annotation and audit posture that belong to the route.
    //
    // A never-switched session and every Bearer request are untouched: both
    // pass the verdict without a header, which is what keeps every existing
    // own-record and delegated-cell contract byte-identical.
    const staleContext = await refuseStaleRecordSessionClaim(claim);
    if (staleContext) return staleContext;

    const claimedRecord = claim.claimedRecord;
    if (claimedRecord === undefined) {
      // The carrier cannot safely name a record. In particular, a selector on
      // a cookie request is a misplaced claim, not an own-record request.
      // Let the route return its normal refusal instead of exposing a cached
      // body from the own-record cell.
      return handler(...args);
    }
    if (claimedRecord !== null && !selectorNamesAnAccount(claimedRecord)) {
      // A claim that names no account that could exist. The request is refused
      // downstream; skipping the cache keeps a caller from writing an
      // arbitrarily long key into the table on the way to that refusal, and
      // never lets one fall back onto the un-delegated cell.
      return handler(...args);
    }

    // The authority this request carries, folded into the cell key BEFORE any
    // cell is read or claimed — see `cellKey`. Both facets are resolved here
    // rather than at replay time so that a request the handler would refuse
    // cannot read a cell at all, and a request the handler would accept lands
    // in a cell only a request with the same authority can reach.
    const facets: string[] = [];
    if (claimedRecord !== null) {
      const grantFacet = await delegatedGrantFacet(userId, claimedRecord);
      if (grantFacet === null) {
        // No live grant: neither read nor claim a cell. The route owns the
        // stable 403 envelope and the audit trail that goes with it.
        return handler(...args);
      }
      facets.push(grantFacet);
    }
    const tokenFacet = await narrowTokenFacet();
    if (tokenFacet !== null) facets.push(tokenFacet);

    const url = new URL(request.url);
    const fingerprint = await fingerprintRequest(request, url.pathname).catch(
      () => null,
    );
    if (fingerprint === null) {
      // The body could not be read for the fingerprint (already consumed, or
      // the stream failed). Without knowing which request this is, no cell
      // may answer for it; the handler meets the body problem itself.
      return handler(...args);
    }
    const ctx: IdempotencyContext = {
      userId,
      key: cellKey(key, claimedRecord, facets),
      method: request.method,
      path: url.pathname,
      fingerprint,
    };

    const cached = await findCached(ctx);
    if (cached?.kind === "mismatch") {
      return runUncached(ctx, handler, args);
    }
    if (cached?.kind === "replay") {
      return cached.response;
    }
    if (cached?.kind === "pending") {
      // A concurrent request is mid-flight on this exact key. Refuse
      // rather than run the side-effect a second time. The client should
      // retry after the in-flight request lands, at which point the
      // completed row replays.
      annotate({
        action: { name: "idempotency.inflight_conflict" },
        meta: { method: ctx.method, path: ctx.path },
      });
      return inflightConflictResponse();
    }

    // Claim the key before running the handler. If a racing request beats
    // us to the insert, treat it as the in-flight conflict above — only
    // one caller may execute the side-effect for a given key.
    const won = await claimKey(ctx);
    if (!won) {
      // The racing claim may be a different request under the same key —
      // the two halves of one reading posted together. That one is not a
      // duplicate of this one and must still run.
      const raced = await findCached(ctx);
      if (raced?.kind === "mismatch") {
        return runUncached(ctx, handler, args);
      }
      annotate({
        action: { name: "idempotency.inflight_conflict" },
        meta: { method: ctx.method, path: ctx.path },
      });
      return inflightConflictResponse();
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
      // with, but if a future caller forgets we refuse to leak. The prefixes
      // are listed where the matcher lives (`src/lib/secret-shape.ts`).
      const cloned = response.clone();
      const text = await cloned.text();
      if (!looksSecretShaped(text)) {
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
