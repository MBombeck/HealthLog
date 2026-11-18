/**
 * v1.37.0 — the browser's half of the record-session fence.
 *
 * Every same-origin API request says which record it believes it is addressing,
 * and every response that resolved a record scope says which one it was
 * actually served under. This module holds both halves: the adopted context,
 * the request headers built from it, and the response check.
 *
 * ─── Where the context comes from ─────────────────────────────────────────
 *
 * Exactly two responses may be ADOPTED from: `GET /api/auth/me` and
 * `POST /api/account/switch`. Both are actor surfaces that resolve canonical
 * session state, and both carry the context in the response BODY. Every other
 * response's echoed context is used to VALIDATE and never to adopt — which is
 * also why the 409 refusal carries only an error code and no epoch: a refusal
 * arriving on a request whose context is in doubt is the worst possible third
 * source of truth.
 *
 * ─── Why it is in memory only ─────────────────────────────────────────────
 *
 * Not mirrored to storage. `/api/auth/me` runs on every boot and is the single
 * bootstrap, so a storage mirror would be a second answer that can go stale
 * across a deploy — and the `bootstrap` sentinel already makes the
 * pre-adoption window safe by producing a 409 rather than a served request.
 *
 * ─── The validation rule is MISMATCH-ONLY ─────────────────────────────────
 *
 * A response is discarded only when it carries an echo that CONTRADICTS the
 * adopted context. A response carrying NO echo is returned untouched, because
 * absence means "this response resolved no record scope" — which is exactly
 * true for public routes, actor surfaces, admin, `/me` itself, and static
 * responses.
 *
 * The concrete thing a discard-on-absence rule breaks:
 * `src/components/version-poller.tsx` polls the PUBLIC `/api/version` through
 * `apiGet` on a timer. That response resolves no record and echoes nothing, so
 * a discard-on-absence client would enter the safe hold and fire a network-only
 * `/me` on every poll cycle, forever. Do not "tighten" this rule.
 *
 * The case mismatch-only appears to give up — a service-worker disk-cache hit
 * that predates the fence and therefore carries no echo — is closed by two
 * other things, and it is worth being exact about which one does what:
 *
 *   * `public/sw.js` names its caches by the app release and its `activate`
 *     handler deletes every `healthlog-(static|pages|data)-*` cache not in the
 *     current set, so the deploy that ships the fence evicts every pre-fence
 *     cached response before one can be served. Executed in
 *     `e2e/v137-record-session-fence-offline.spec.ts`;
 *   * a POST-fence cached record response is stored under a `Vary` on the two
 *     fence headers (`attachRecordContextEcho`), so `cache.match()` will not
 *     hand it to a request asserting a different context — or none. That is
 *     what covers the EXTERNAL switch, where this browser never ran its own
 *     cache wipe and the previous record's entries are still on disk. Also
 *     executed in that spec, and it fails when the `Vary` is removed.
 *
 * The client-side discard below is the third layer, over responses that reach
 * it. It is not what protects the disk.
 */

import {
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_BOOTSTRAP,
  RECORD_SCOPE_HEADER,
  recordScopeHeaderValue,
} from "@/lib/sharing/record-session-fence-contract";

/**
 * The context this browser has adopted, or null before `/api/auth/me` has told
 * it one.
 *
 * Imported from the contract module and NOT from `record-session-fence.ts` or
 * `acting-carrier.ts`: those pull `next/headers` and Prisma, which typechecks
 * cleanly in a client module and fails `pnpm build`.
 */
export interface AdoptedRecordContext {
  epoch: number;
  scope: string | null;
}

let adopted: AdoptedRecordContext | null = null;

/** What a mismatching response should trigger. Installed by the app shell. */
let onContextMismatch: (() => void) | null = null;

/**
 * Adopt the context published by `GET /api/auth/me` or
 * `POST /api/account/switch`.
 *
 * `null` is a real value with a real meaning — the Bearer transport, or a
 * server image that predates the field — and it un-adopts, returning the client
 * to the `bootstrap` sentinel rather than leaving a stale context in place.
 */
export function adoptRecordFenceState(
  context: AdoptedRecordContext | null | undefined,
): void {
  adopted = context ?? null;
}

/** What this browser currently believes. Read by the capability gate. */
export function currentRecordFenceState(): AdoptedRecordContext | null {
  return adopted;
}

/**
 * Install the handler a contradicting response triggers.
 *
 * A callback rather than a direct import of the transition store, so this
 * module stays a transport concern and the app shell owns what "hold and
 * reconcile" means. Returns a disposer.
 */
export function onRecordFenceMismatch(handler: () => void): () => void {
  onContextMismatch = handler;
  return () => {
    if (onContextMismatch === handler) onContextMismatch = null;
  };
}

/** @internal — deterministic module state for unit tests. */
export function __resetRecordFenceForTests(): void {
  adopted = null;
  onContextMismatch = null;
}

/**
 * The two header values to send on this request.
 *
 * Before adoption both are the literal `bootstrap`. That is a PRESENT header,
 * which is the whole point: the server's header-absent arm means exactly "a
 * bundle that predates the fence" and answers it with the 403 such a bundle
 * recovers from, so a fence-aware client must never reach it. On a session that
 * never entered a shared record the server's exemption serves `bootstrap`
 * normally, so an ordinary sign-in sees no refusal during boot.
 */
export function currentAssertion(): { epoch: string; scope: string } {
  if (adopted === null) {
    return { epoch: RECORD_FENCE_BOOTSTRAP, scope: RECORD_FENCE_BOOTSTRAP };
  }
  return {
    epoch: String(adopted.epoch),
    scope: recordScopeHeaderValue(adopted.scope),
  };
}

/**
 * Attach the assertion to a request.
 *
 * Applied inside `apiFetch` / `apiFetchEnvelope` / `apiFetchRaw` rather than at
 * call sites, so no caller has to classify its own request as record traffic —
 * a classification that would be wrong the first time a route changed mode. A
 * caller that set the headers itself keeps them: an explicit value wins, the
 * same posture `withDefaultTimeout` takes for `signal`.
 */
export function withRecordFenceHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const assertion = currentAssertion();
  if (!headers.has(RECORD_EPOCH_HEADER)) {
    headers.set(RECORD_EPOCH_HEADER, assertion.epoch);
  }
  if (!headers.has(RECORD_SCOPE_HEADER)) {
    headers.set(RECORD_SCOPE_HEADER, assertion.scope);
  }
  return { ...init, headers };
}

/**
 * Discard a response served under a record context this browser is no longer
 * on.
 *
 * Returns the response untouched when it carries no echo, or when the echo
 * agrees. Throws when it contradicts — and triggers the safe hold on the way
 * out, so the caller's error path and the browser's reconciliation are one
 * event rather than two that can disagree.
 *
 * Read from headers only. Never consume the body here: `apiFetchRaw` hands the
 * response to SSE readers and blob downloads that need the stream intact.
 */
export function validateResponseContext(res: Response): Response {
  validateEchoedContext((name) => res.headers.get(name));
  return res;
}

/**
 * The header-level check behind `validateResponseContext`, for a transport
 * that is not `fetch`.
 *
 * The vault upload is an `XMLHttpRequest` because it needs real upload
 * progress, so it has no `Response` to hand over — only a header getter. It
 * runs the same rule through this function rather than a copy of it, so the
 * mismatch-only posture cannot drift between the two transports.
 */
export function validateEchoedContext(
  getHeader: (name: string) => string | null,
): void {
  const echoedEpoch = getHeader(RECORD_EPOCH_HEADER);
  const echoedScope = getHeader(RECORD_SCOPE_HEADER);

  // No echo: this response resolved no record scope. True, safe, and the
  // common case — see the version-poller note above.
  if (echoedEpoch === null || echoedScope === null) return;

  // Not adopted yet: there is nothing to contradict. The request itself
  // asserted `bootstrap`, so the server already decided whether to serve it.
  if (adopted === null) return;

  const expected = currentAssertion();
  if (echoedEpoch === expected.epoch && echoedScope === expected.scope) {
    return;
  }

  onContextMismatch?.();
  throw new RecordContextMismatchError();
}

/**
 * Hand a 409 `sharing.session.changed` that did not travel through the query
 * cache to the same reconciler.
 *
 * `RecordSessionFenceBridge` finds the 409 by watching errored queries, which
 * covers every `useQuery` read. A transport outside that cache (the XHR upload)
 * reports the refusal here, so the tab holds and re-reads `/api/auth/me` the
 * same way it would for a read.
 */
export function reportRecordSessionChanged(): void {
  onContextMismatch?.();
}

/**
 * A response arrived describing a record this browser has left.
 *
 * Deliberately not an `ApiError`: nothing about the HTTP exchange failed, and a
 * caller branching on `err.status` must not see a status that was never
 * refused. What happened is that the answer is about somebody else's record,
 * and the only safe thing to do with it is to drop it.
 */
export class RecordContextMismatchError extends Error {
  constructor() {
    super("Response describes a record this session has left");
    this.name = "RecordContextMismatchError";
  }
}
