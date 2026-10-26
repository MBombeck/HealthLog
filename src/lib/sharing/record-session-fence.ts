/**
 * v1.37.0 — the server half of the record-session fence.
 *
 * The rule itself lives next door in `record-session-fence-contract.ts`, which
 * imports nothing so the browser bundle can name the same headers. This file is
 * the part that cannot be in a browser: it reads `next/headers`, it holds the
 * refusals, and it stamps the wide event that becomes the response echo.
 *
 * Three things happen on every call, and the order matters:
 *
 *   1. Read the two asserted headers.
 *   2. Stamp the context the request is ACTUALLY being served under onto the
 *      request-scoped wide event — on every call, pass or refuse. `apiHandler`
 *      turns that stamp into the response echo, and this is the only thing that
 *      ever stamps it. The alternative that looks equivalent is not: the wide
 *      event's `setActingAs` runs in exactly one place, inside
 *      `resolveSwitchedRecord`, so it never fires on the carrier-none path, on
 *      an actor surface, or on a public route — and a client rule of "2xx with
 *      no echo means discard" would then throw away every actor and public
 *      response, including the `/api/version` poll that runs on a timer.
 *   3. Refuse, or return.
 *
 * ─── The atomicity property, stated once ──────────────────────────────────
 *
 * The epoch compared here and the `actingAsUserId` the resolver is about to
 * serve under come from ONE `getSession()` row read — `findSessionByCookie`
 * loads the whole row and both fields are projected off it. So "the scope the
 * handler serves under" and "the epoch the fence validated" are the same fact
 * read at the same instant, not two reads a switch can land between. That turns
 * what would be a race window into a tautology, and it is why this function
 * takes an `AuthContext` instead of resolving a session of its own. Do not add
 * a second session read here for any reason.
 *
 * What that does NOT close, and nothing can: a request that has already passed
 * the fence when a switch commits still completes under the context it was
 * admitted with. Holding a lock across the handler's I/O would close it and was
 * examined and rejected during v1.37.0 planning — it buys a disclosure window
 * measured in milliseconds at the price of lock, pool, timeout and revocation
 * availability defects. What covers it instead is the response echo: the client
 * discards a response whose echoed context contradicts the one it is now on.
 */
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import {
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_ERROR_CODE,
  RECORD_SCOPE_HEADER,
  parseAssertedContext,
  recordScopeHeaderValue,
  recordSessionFenceVerdict,
  type AssertedRecordContext,
} from "@/lib/sharing/record-session-fence-contract";
// Runtime error classes come from the LEAF module — importing them from
// api-handler recreated the import cycle this split removed. The
// `AuthContext` type import stays on api-handler: type-only, erased at
// runtime, no cycle.
import {
  RecordSessionChangedError,
  SharingAccessDeniedError,
} from "@/lib/api-errors";
import type { AuthContext } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";

/**
 * What this request asserted about its record context.
 *
 * `try`/`catch`-wrapped the way `readSelectorHeader` is: outside a Next.js
 * request scope there is no header to read, and a direct unit invocation of a
 * legacy route must not crash on the attempt. An unreadable header store is
 * indistinguishable from a request that sent nothing, which is the honest
 * answer — and on a fenced session that answer is refused, not served.
 */
export async function readAssertedRecordContext(): Promise<AssertedRecordContext> {
  try {
    const headerList = await headers();
    return parseAssertedContext(
      headerList.get(RECORD_EPOCH_HEADER),
      headerList.get(RECORD_SCOPE_HEADER),
    );
  } catch {
    return { kind: "absent" };
  }
}

/**
 * Copy the context this response was served under onto its headers.
 *
 * Called once, from `apiHandler`, with whatever the fence stamped on the wide
 * event — which is `undefined` on every response that never resolved a record
 * scope. So the echo appears on exactly the responses where it means something,
 * and its ABSENCE means "nothing about a record was decided here" rather than
 * "unknown". That is what lets the browser's rule be discard-on-mismatch rather
 * than discard-on-absence: a discard-on-absence client would throw away the
 * public `/api/version` poll, the switcher list, admin, `/me` and every static
 * response.
 *
 * It lives here, not in `apiHandler`, so the two header names stay inside the
 * fence: declared in the contract module, read here, attached by the browser's
 * `src/lib/api/record-fence.ts`, and published by the OpenAPI route module. A
 * fifth file naming them is a route deciding something the fence decides once.
 */
export function attachRecordContextEcho(
  headers: Headers,
  context: { epoch: number; scope: string | null } | undefined,
): void {
  if (!context) return;
  headers.set(RECORD_EPOCH_HEADER, String(context.epoch));
  headers.set(RECORD_SCOPE_HEADER, recordScopeHeaderValue(context.scope));
  // And declare that the answer DEPENDS on those two request headers.
  //
  // Not a precaution against some future reverse proxy — it is load-bearing on
  // a path that exists today. When a switch is driven EXTERNALLY (another tab,
  // an account deletion, an operator), this browser never ran
  // `clearOfflineCachesForRecordSwitch`, so the service worker's
  // `healthlog-data-*` entries from the previous record are still on disk.
  // `Vary` is the only thing that stops `cache.match()` handing one of them to
  // the next request for the same URL under a different context — one person's
  // health record served to another, out of the disk layer, with no request
  // reaching the fence at all. Proved in
  // `e2e/v137-record-session-fence-offline.spec.ts`, which fails the moment
  // this block is removed.
  //
  // Appended rather than assigned: a route that already varies on something
  // (`Accept-Encoding`, a locale header) must keep it. Case-insensitive
  // de-duplication, because a value repeated in two spellings is the sort of
  // header that makes a proxy give up and cache nothing.
  const existing = headers
    .get("Vary")
    ?.split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const names = new Set((existing ?? []).map((part) => part.toLowerCase()));
  const merged = [...(existing ?? [])];
  for (const header of [RECORD_EPOCH_HEADER, RECORD_SCOPE_HEADER]) {
    if (names.has(header.toLowerCase())) continue;
    names.add(header.toLowerCase());
    merged.push(header);
  }
  headers.set("Vary", merged.join(", "));
}

/**
 * The record context to publish in the account payload, for a client that has
 * none yet.
 *
 * `GET /api/auth/me` is the fence's bootstrap: a browser cannot assert a
 * context until something tells it one, and this is that something. It lives
 * here rather than in the route because the two columns behind it have one
 * reader by design — a route projecting them itself would be a second statement
 * of what a record context is, and the second copy is the one that drifts.
 *
 * Null on the Bearer transport, which has no session row and no switch state to
 * be stale about. The native client neither sends nor receives fence headers,
 * and this field tells it so explicitly rather than by omission.
 */
export function recordSessionForPayload(
  auth: AuthContext,
): { epoch: number; scope: string | null } | null {
  if (auth.authMethod !== "cookie") return null;
  return {
    epoch: auth.session.recordEpoch ?? 0,
    scope: auth.session.actingAsUserId ?? null,
  };
}

/**
 * Refuse this request if the record context it asserted is not the one its
 * session is on.
 *
 * Called by `requireRecordAuth` and `requireGuardianAuth` immediately after
 * `authenticateCaller()` and before `readActingCarrier()`, and independently by
 * `withIdempotency` above the replay cache. Two independent evaluations against
 * the same client assertion, with nothing carried between them: carrying a
 * verdict across the wrapper/handler boundary would need request-scoped mutable
 * state, which is a second source of truth for the same question. A switch
 * landing between the two evaluations fails the second, so no handler body runs
 * under a scope the asserted epoch does not imply.
 */
export async function assertRecordSessionFence(
  auth: AuthContext,
): Promise<void> {
  const verdict = await decide({
    transport: auth.authMethod === "bearer" ? "bearer" : "cookie",
    sessionEpoch: auth.session.recordEpoch ?? 0,
    sessionScope: auth.session.actingAsUserId ?? null,
  });

  if (verdict === "pass") return;

  if (verdict === "stale") {
    annotate({ meta: { sharing_refusal: "record_context_stale" } });
    throw new RecordSessionChangedError();
  }

  // `unfenced-client`: a bundle that predates the fence, inside or after a
  // shared-record context. It gets the code it already recovers from — see the
  // two-refusals note in the contract module.
  //
  // No audit row, and that follows the rule already written for the session
  // carrier in `auth/guards/acting.ts`: a HEADER refusal is a per-request assertion by
  // a client and earns a durable record, a SESSION-state refusal is ambient
  // browser state and would bury the rows that matter under noise from the
  // feature working as designed. This arm is the second kind — every
  // navigation, prefetch and poll from one stale tab lands here until it
  // reloads, and the reload is the designed outcome.
  annotate({ meta: { sharing_refusal: "unfenced_client" } });
  throw new SharingAccessDeniedError();
}

/**
 * The same verdict, for the idempotency wrapper, returning bytes instead of
 * throwing.
 *
 * `withIdempotency` is composed OUTSIDE `apiHandler` on at least one route
 * (`POST /api/admin/backups/[id]/restore`), so a throw from the wrapper would
 * escape the envelope and become a 500 rather than the documented refusal. It
 * therefore returns a response, hand-built to the same
 * `{ data, error, meta.errorCode }` shape `apiHandler`'s `SharingAuthError` arm
 * emits, so a client cannot tell which layer refused it.
 *
 * Only the `stale` arm produces a response. `unfenced-client` deliberately
 * falls through to the handler, whose `requireRecordAuth` issues the 403 a
 * pre-fence bundle recovers from — along with the wide-event annotation and the
 * audit posture that belong to the route, not to a cache wrapper.
 *
 * This is the SECOND, INDEPENDENT evaluation of the fence on such a request,
 * and its result is deliberately NOT carried into the handler's own. Carrying
 * it would need request-scoped mutable state shared across the wrapper/handler
 * boundary, which is a second source of truth for the same question. Two
 * independent evaluations against the same client assertion are sufficient: a
 * switch landing between the two fails the second, so no handler body runs
 * under a scope the asserted epoch does not imply.
 */
export async function refuseStaleRecordSessionClaim(
  claim: RecordSessionInputs,
): Promise<Response | null> {
  const verdict = await decide(claim);
  if (verdict !== "stale") return null;
  annotate({ meta: { sharing_refusal: "record_context_stale_idempotent" } });
  return NextResponse.json(
    {
      data: null,
      error: "The record this session is on has changed",
      meta: { errorCode: RECORD_FENCE_ERROR_CODE },
    },
    { status: 409 },
  );
}

/** What the fence needs to know about the session, from either caller. */
interface RecordSessionInputs {
  transport: "cookie" | "bearer";
  sessionEpoch: number;
  sessionScope: string | null;
}

/** Stamp the echo and read the verdict. The one place either happens. */
async function decide(input: RecordSessionInputs) {
  // Stamped before the verdict, so a refusal echoes the truth too. The Bearer
  // transport carries no session context to echo and gets none: the frozen
  // native contract sends no fence header and receives none back.
  if (input.transport === "cookie") {
    getEvent()?.setRecordContext({
      epoch: input.sessionEpoch,
      scope: input.sessionScope,
    });
  }

  return recordSessionFenceVerdict({
    ...input,
    asserted: await readAssertedRecordContext(),
  });
}
