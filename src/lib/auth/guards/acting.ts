import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  carrierTarget,
  decideActingCarrier,
  readSelectorHeader,
  type ActingCarrier,
} from "@/lib/auth/acting-carrier";
import { SharingNotPermittedError } from "@/lib/api-errors";

import type { AuthContext } from "./context";

// ── The acting-account resolver ─────────────────────────────────────────────
//
// One function decides, for every transport, whether this request acts on
// somebody else's record — the same argument that put `resolveBearerToken` in
// one file for two wires. Two carriers converge on one decision because they
// are two answers to one question, and two answers that live apart drift.
//
// That decision lives in `@/lib/auth/acting-carrier`, because a second caller
// needs it: the idempotency wrapper files its replay cell under the record a
// request claims, and it runs before any auth context exists. What stays in
// the guards is what only they may do: turning a claim into a data scope after
// a live grant says so (`./record.ts`), and refusing one (below).

/**
 * The acting-account carrier for this request.
 *
 * The session value rides out of `getSession()` on the row that call already
 * loaded — a second query for a column we have just read would be waste on
 * every cookie request in the app. What does NOT ride out of `getSession()` is
 * a substituted user: it keeps answering "who is calling" and nothing else,
 * which is exactly why `requireAdmin`, `requireCookieAuth` and
 * `requireFreshMfa` are unreachable by a switch. The carrier is an id to be
 * checked, not a decision that has been made.
 *
 * Fresh on every request, by construction: `getSession()` reads the row from
 * Postgres each time, so a switch cleared by a revocation is gone from the very
 * next request rather than from the next login.
 */
export async function readActingCarrier(
  auth: AuthContext,
): Promise<ActingCarrier> {
  return decideActingCarrier({
    transport: auth.authMethod === "bearer" ? "bearer" : "cookie",
    stamped: auth.session.actingAsUserId ?? null,
    header: await readSelectorHeader(),
  });
}

/**
 * Record a refused delegation.
 *
 * The row is filed under the CALLER, with no actor, and it is the operator's
 * trail rather than the owner's. It names who called, the account they claimed,
 * and why the claim was refused — none of which reaches the response.
 *
 * It is deliberately not filed under the claimed account, and that decision is
 * worth stating because the opposite reads as the obvious one. A row is only
 * written for a HEADER refusal, and a header is an unverified per-request
 * assertion: the value is whatever the caller typed. Filing under it would let
 * any authenticated caller write rows into any account's activity feed by
 * naming it, which is a spam vector aimed at exactly the panel that exists to
 * be trustworthy. Verifying the claim first would mean a grant lookup on a path
 * whose whole job is to refuse without touching the record.
 *
 * What the owner does see is the other half: `recordDelegatedAccess` files a
 * per-day row under the OWNER, naming the actor, for every delegated read that
 * succeeded. "Who reached my record" is answered there. "Whose client sent a
 * malformed claim" is an operator question and stays here.
 *
 * Fire-and-forget: an audit write that fails must not convert a 403 into a 500,
 * because the 403 is the part that protects the record.
 */
export function auditRefusal(
  auth: AuthContext,
  carrier: ActingCarrier,
  reason: string,
): void {
  auditLog("sharing.access.denied", {
    userId: auth.user.id,
    details: {
      reason,
      carrier: carrier.kind,
      target: carrierTarget(carrier),
      method: getEvent()?.getHttpMethod() ?? null,
    },
  }).catch(() => {});
}

/**
 * This request says it is acting on another account and this route will not.
 *
 * Three ways to arrive: a route that never declared a mode (`undeclared_mode`),
 * a selector sent over the transport that does not carry one
 * (`misplaced_selector`), and a narrow single-purpose Bearer naming a record
 * that is not its owner's (`narrow_scope_selector`). One response every way —
 * the caller learns that the request will not be served, and nothing about
 * grants.
 *
 * The audit rule, stated once because it is a judgement call: a HEADER refusal
 * always writes a row, a SESSION refusal never does. The header is a per-request
 * assertion by a client — a bug or a probe, and both are worth a durable record.
 * The session field is ambient browser state: while a switch is on, every
 * navigation, prefetch and poll that touches a non-delegable route lands here,
 * and a row per such request would bury the header rows that matter under noise
 * from the feature working as designed. Both are on the wide event either way.
 */
export function refuseUndeclaredMode(
  auth: AuthContext,
  carrier: ActingCarrier,
  reason:
    | "undeclared_mode"
    | "misplaced_selector"
    | "narrow_scope_selector" = "undeclared_mode",
): SharingNotPermittedError {
  annotate({ meta: { sharing_refusal: reason } });
  if (carrier.kind !== "session") {
    auditRefusal(auth, carrier, reason);
  }
  return new SharingNotPermittedError();
}
