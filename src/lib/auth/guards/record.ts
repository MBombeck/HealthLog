import type { AccountGrant } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { SESSION_USER_SELECT, type SessionUser } from "@/lib/auth/session-user";
import { annotate, getEvent } from "@/lib/logging/context";
import { recordDelegatedAccess } from "@/lib/auth/audit";
import {
  readSelectorHeader,
  selectorNamesAnAccount,
  type ActingCarrier,
} from "@/lib/auth/acting-carrier";
import { meterAccountWrite } from "@/lib/auth/write-meter";
import {
  findActiveGrant,
  grantAllows,
  grantCoversDomain,
  touchGrantUsage,
  type GrantNeed,
} from "@/lib/sharing/grant-access";
import type { ShareScope } from "@/lib/sharing/scope";
import { assertRecordSessionFence } from "@/lib/sharing/record-session-fence";
import {
  SharingAccessDeniedError,
  SharingNotPermittedError,
} from "@/lib/api-errors";

import {
  auditRefusal,
  readActingCarrier,
  refuseUndeclaredMode,
} from "./acting";
import { authenticateCaller } from "./caller";
import {
  READ_HTTP_METHODS,
  isScopedCredential,
  type AuthContext,
} from "./context";

/**
 * An actor surface: this route always serves the CALLER's own rows.
 *
 * It works under a switch. That is the whole reason the mode exists: the
 * switcher itself, the banner, and the "which records may I open" list all have
 * to keep answering while the browser is acting as someone else, and every one
 * of them is about the delegate. So the session carrier is read and
 * deliberately ignored — no query, because there is nothing the answer could
 * change.
 *
 * A selector HEADER is refused, loudly. An actor surface is DEFINED as serving
 * the caller's own rows, so a client that attaches a selector to one has a bug,
 * and the bug is invisible until somebody files a support ticket about data
 * that looks wrong. Ignoring the header would serve exactly the right response
 * to exactly the wrong expectation.
 */
export async function requireActorAuth(): Promise<AuthContext> {
  const auth = await authenticateCaller();
  const header = await readSelectorHeader();
  if (header !== null) {
    annotate({ meta: { sharing_refusal: "actor_surface" } });
    auditRefusal(auth, { kind: "header", accountId: header }, "actor_surface");
    throw new SharingNotPermittedError();
  }
  await meterAccountWrite(auth.user.id);
  return auth;
}

/**
 * A request resolved against a record that may not be the caller's own.
 *
 * `user` is the account whose rows the handler must read and write — so an
 * existing `where: { userId: user.id }` is correct without being touched, which
 * is what keeps a route migration a one-line change instead of an audit.
 * `actor` is who is actually here. They are the same object when no switch is
 * active.
 */
export interface RecordAuthContext extends AuthContext {
  /** The authenticated caller. Equals `user` when the caller acts as themselves. */
  readonly actor: SessionUser;
  /** The grant being exercised, or null when the caller acts as themselves. */
  readonly grantId: string | null;
}

/** What a delegable route may additionally declare about the credentials it takes. */
export interface RecordAuthOptions {
  /**
   * A Bearer scope this route accepts in place of the cookie-equivalent
   * default. Naming one is a WIDENING — it admits a credential class the route
   * refused before — and is frozen by `bearer-scope-enforcement-guard.test.ts`
   * exactly like a `requireAuth` scope, so it lands in a reviewed diff.
   *
   * What the option does NOT do is relax anything below it. A credential
   * admitted this way is single-purpose: it reaches this route on its OWN
   * record and is refused the moment the request names another, before any
   * grant is read. The `need` and `domain` checks run unchanged for everyone
   * else.
   */
  readonly scope?: string;
  /**
   * This route answers a POST without changing anything: the body
   * carries a query that must not stand in a URL (the record search, whose
   * text is health data a proxy's access log would otherwise keep). Under a
   * route declaring `"read"`, a POST is then read at the grant's read level
   * instead of being escalated to a write.
   *
   * Like `scope`, naming it is a WIDENING and is frozen by
   * `read-over-post-guard.test.ts`, so it lands in a reviewed diff. It does
   * nothing for any other method, and nothing for a route declaring a need
   * above `"read"`.
   */
  readonly readOverPost?: true;
  /**
   * This route meters its writes with a dedicated bucket instead of the shared
   * per-account one (`meterAccountWrite`). Frozen per route, with the reason,
   * by `write-rate-limit-guard.test.ts`, which also requires the route to call
   * its own limiter.
   */
  readonly writeBucket?: "own";
}

/**
 * A delegable surface: this route may act on a shared record.
 *
 * Calling it is a DECLARATION, reviewed and frozen by a structural guard, that
 * the route reads or writes health data and nothing else — no credential, no
 * integration, no notification channel, no grant management, nothing that would
 * let a delegate extend their own reach. The declaration is the security
 * property; this function only enforces what was declared.
 *
 * @param need what the route does to the record. `"read"` still refuses a
 *   non-safe HTTP method under a read-only grant: the declaration and the
 *   method must BOTH be satisfiable, so a delegable GET handler that grows a
 *   POST export cannot quietly inherit the read grant's permission. An unknown
 *   method (no event context) counts as a write and is refused, the same
 *   fail-closed posture as the MCP audience guard in `caller.ts`. A route declaring
 *   `"manage"` refuses everything below it regardless of method: the method
 *   can only escalate what the declaration asked for, never satisfy it.
 * @param domain v1.37.0 — which section of the record the route touches, or
 *   `"record"` when it reads across sections. Required, and the requirement is
 *   the fail-closed lever: a delegable route without a classification does not
 *   typecheck, so the set of routes carrying one cannot fall behind the set of
 *   routes that are delegable. The value is frozen per module by
 *   `src/__tests__/sharing-surface-guard.test.ts` and reviewed against the
 *   design's clustering table; this function only enforces what was declared.
 * @param options v1.38.x — optional extra declarations. Today that is `scope`,
 *   naming a narrow Bearer this route admits alongside cookie sessions and
 *   cookie-equivalent tokens. A route that passes none keeps the fail-closed
 *   default and refuses every narrow token, which is what makes adding one a
 *   visible decision rather than an omission.
 */
export async function requireRecordAuth(
  need: GrantNeed,
  domain: ShareScope,
  options?: RecordAuthOptions,
): Promise<RecordAuthContext> {
  const auth = await authenticateCaller(options?.scope);
  // Before any carrier is read, any grant is looked up, or any record
  // row is touched: does this request still believe what its session believes?
  //
  // The atomicity that makes this a tautology rather than a race: the epoch the
  // fence compares and the `actingAsUserId` the carrier below is built from are
  // BOTH projected off the one session row `authenticateCaller()` already
  // loaded. The scope this handler serves under and the epoch it validated are
  // therefore the same fact read at the same instant, not two reads a commit
  // can land between. Do not add a second session read here to "refresh" it —
  // that would reintroduce exactly the window this ordering removes.
  //
  // `authenticateCaller` necessarily runs first because it supplies the row the
  // fence reads, so the invariant is "before the carrier", not "before the
  // first database await".
  await assertRecordSessionFence(auth);
  // The shared write ceiling, charged to the ACTING account before any grant
  // is read, so a refused write counts like an admitted one — see
  // `meterAccountWrite`.
  await meterAccountWrite(auth.user.id, {
    readOverPost: options?.readOverPost,
    writeBucket: options?.writeBucket,
  });
  const carrier = await readActingCarrier(auth);

  // A narrow, single-purpose Bearer never acts on another record.
  //
  // Its holder mints it themselves, for one job, and pastes it into something
  // that is not this app — a scale bridge, a home-automation rule. Admitting it
  // under a selector would exercise somebody else's grant through a credential
  // nobody reviewed for that purpose, and the blast radius of the paste would
  // stop being "my own record" without anyone deciding it should.
  //
  // Placed above the `none` arm and below the carrier read, which is the only
  // position that is both correct and cheap: no grant is looked up on the way
  // to the refusal, and a scoped credential on its own record still falls
  // through to the untouched `none` path below. A `["*"]` token and a cookie
  // session read `bearerScope: null` here and keep exactly the delegation
  // behaviour they had.
  if (carrier.kind !== "none" && isScopedCredential(auth)) {
    throw refuseUndeclaredMode(auth, carrier, "narrow_scope_selector");
  }

  if (carrier.kind === "none") {
    // Do no harm: without a carrier this is byte-for-byte the pre-v1.36.0
    // request, resolved by the same `authenticateCaller` every other mode uses.
    getEvent()?.setProviderWorkAuthority({
      origin: "owner",
      recordUserId: auth.user.id,
      actorUserId: auth.user.id,
      grantId: null,
    });
    return { ...auth, actor: auth.user, grantId: null };
  }
  if (carrier.kind === "misplaced-header") {
    // The route DID declare a mode; the client sent the selector over the
    // cookie transport, where the carrier is the session row.
    throw refuseUndeclaredMode(auth, carrier, "misplaced_selector");
  }

  const method = (getEvent()?.getHttpMethod() ?? "").toUpperCase();
  const readsOnly =
    READ_HTTP_METHODS.has(method) ||
    (options?.readOverPost === true && method === "POST");
  const effectiveNeed: GrantNeed =
    need !== "read" || !readsOnly ? escalate(need) : "read";

  return resolveSwitchedRecord(auth, carrier, (grant) => {
    if (!grantAllows(grant, effectiveNeed)) return "insufficient_access";
    // Level first, then scope, and the order is visible on the wire in exactly
    // one way: not at all. Both refusals are the same error with the same
    // bytes, and only the audit reason differs — so the ordering is a choice
    // about what the operator's trail says happened, not about what the caller
    // learns. It says the bigger thing: a delegate who was never given this
    // level is a different story from one whose sections do not reach here.
    if (!grantCoversDomain(grant, domain)) return "out_of_scope";
    return null;
  });
}

/**
 * The need a non-safe method implies, for a route that declared `need`.
 *
 * A PUT on a route declaring `"read"` needs a write grant, which is what this
 * has always done. A PUT on a route declaring `"manage"` needs a MANAGE grant
 * and must not be reduced to a write — so the escalation raises the floor to
 * `"write"` and never lowers a declaration that already sits above it.
 */
function escalate(need: GrantNeed): GrantNeed {
  return need === "manage" ? "manage" : "write";
}

/**
 * A guardian surface: this route administers a managed profile.
 *
 * The other declaration, and a separate function rather than a flag on the one
 * above, for the reason `requireActorAuth` is also separate: the guard freezes
 * each declaration as its own list, so a route moving between them is a diff a
 * human reviews rather than an argument about a parameter.
 *
 * What it admits is narrower than it looks. An active MANAGE grant is
 * necessary and NOT sufficient — the record must also carry the managed-profile
 * marker. That second condition is the identity fence, and it is the line
 * between "manage my data" and "own my account": an adult who granted
 * management of their own record reaches none of this, at any level, by any
 * argument, because their record has no marker and never will while they hold
 * it. A managed profile has no self to reserve these surfaces for, so its
 * guardian holds them.
 *
 * The fence is gated on the marker rather than on the grant precisely so that
 * no future change to what MANAGE means can reach through it. Widening MANAGE
 * would widen `requireRecordAuth`; it would not touch this function.
 */
export async function requireGuardianAuth(): Promise<RecordAuthContext> {
  const auth = await authenticateCaller();
  // Same placement and the same reason as `requireRecordAuth` above: the
  // guardian surfaces administer a managed profile, so a request arriving under
  // a context that has since moved must be refused before the marker is read,
  // not after.
  await assertRecordSessionFence(auth);
  await meterAccountWrite(auth.user.id);
  const carrier = await readActingCarrier(auth);

  if (carrier.kind === "none") {
    // The owner of an ordinary record, reaching their own settings. Same
    // do-no-harm posture as the record resolver: without a carrier this is the
    // request it always was.
    return { ...auth, actor: auth.user, grantId: null };
  }
  if (carrier.kind === "misplaced-header") {
    throw refuseUndeclaredMode(auth, carrier, "misplaced_selector");
  }

  return resolveSwitchedRecord(auth, carrier, (grant, owner) => {
    if (!grantAllows(grant, "manage")) return "insufficient_access";
    if (owner.managedProfileAt === null) return "guardian_only";
    return null;
  });
}

/**
 * The shared body of both record resolvers: turn a selector into an owner, or
 * refuse.
 *
 * Everything either resolver does with a carrier lives here except the
 * admission rule itself, which arrives as `admit` — a function of the grant
 * and the owner returning an audit reason to refuse with, or null to proceed.
 * The split is where it is because the two resolvers differ in exactly that
 * one decision and in nothing else, and two copies of the grant lookup, the
 * refusal shape, the usage stamp and the owner's access row would be two
 * copies to keep in step.
 *
 * The owner row is loaded BEFORE the admission runs, which is a change from
 * the first resolver's ordering and a deliberate one: the guardian rule is a fact about
 * the owner, so it cannot be decided before the owner is known. Nothing about
 * the refusal moved — every arm below is the same error with the same bytes,
 * and an admission that refuses after the load costs one query it does not use
 * and tells the caller nothing extra.
 */
async function resolveSwitchedRecord(
  auth: AuthContext,
  carrier: Extract<ActingCarrier, { accountId: string }>,
  admit: (grant: AccountGrant, owner: SessionUser) => string | null,
): Promise<RecordAuthContext> {
  /** Every refusal below is this one error, with the reason kept off the wire. */
  const denied = (reason: string): SharingAccessDeniedError => {
    annotate({ meta: { sharing_refusal: reason } });
    auditRefusal(auth, carrier, reason);
    return new SharingAccessDeniedError();
  };

  if (!selectorNamesAnAccount(carrier.accountId)) {
    throw denied("malformed_selector");
  }

  // Loaded here, on this request, every request. Not memoised on the session,
  // not cached in the process, not carried on the token: a revocation has to
  // land on the delegate's NEXT request, not on their next login. That is the
  // one property the owner is actually promised when they press revoke.
  //
  // Note what is NOT looked up: the account named by the carrier. An account
  // that does not exist and an account that granted nothing produce the same
  // empty row from the same query, which is what makes the two refusals
  // identical in bytes and in timing rather than identical by careful wording.
  const grant = await findActiveGrant({
    grantorId: carrier.accountId,
    granteeId: auth.user.id,
  });
  if (!grant) throw denied("no_active_grant");

  const owner = await prisma.user.findUnique({
    where: { id: grant.grantorId },
    select: SESSION_USER_SELECT,
  });
  // Unreachable while the FK cascade holds — a grant naming a deleted account
  // is deleted with it. Fail closed anyway: an authorization we cannot resolve
  // to a person is not one to act on.
  if (!owner) throw denied("owner_missing");
  // A record pending deletion is locked for everyone, its Guardians and
  // delegates included, until an admin undoes the deletion or it is erased.
  if (owner.deletionRequestedAt != null) {
    throw denied("owner_deletion_pending");
  }

  const refusal = admit(grant, owner);
  if (refusal !== null) throw denied(refusal);

  getEvent()?.setActingAs(owner.id);
  // And whether this request may spend the owner's provider budget.
  // MANAGE opens the generated reads; it does not open the generation behind
  // them, because the owner would pay for and consent to an egress they did
  // not cause. A managed profile is the exception and the reason the marker is
  // read here rather than the grant: it has no self to protect from its own
  // guardian. Stamped where the owner row is already loaded, so no generator
  // has to be told; see `src/lib/sharing/delegated-generation.ts`.
  if (owner.id !== auth.user.id && owner.managedProfileAt === null) {
    getEvent()?.setDelegatedGenerationSuppressed();
  }
  getEvent()?.setProviderWorkAuthority({
    origin: owner.managedProfileAt === null ? "delegate" : "guardian",
    recordUserId: owner.id,
    actorUserId: auth.user.id,
    grantId: grant.id,
  });
  // Fire-and-forget, the `ApiToken.lastUsedAt` posture: the read must not wait
  // on the bookkeeping, and the bookkeeping failing must not fail the read.
  trackBackgroundTask(runDetached(() => touchGrantUsage(grant.id)));
  // The owner's copy of the same fact, and the one they can read: a day-
  // coalesced row on their own record saying who opened it. It lands here
  // rather than in the handlers because a route cannot forget what it never
  // had to remember — every delegated request in the product passes through
  // this line, and only requests that got past the grant check reach it.
  trackBackgroundTask(
    runDetached(() => recordDelegatedAccess(owner.id, auth.user.id)),
  );

  return {
    session: auth.session,
    user: owner,
    authMethod: auth.authMethod,
    actor: auth.user,
    grantId: grant.id,
  };
}
