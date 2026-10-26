/**
 * `POST /api/account/switch` — point this browser at a record, or back at its own.
 *
 * Cookie transport only. The Bearer carrier is a per-request header, and that
 * difference is not an inconsistency to be smoothed over: stamping a switch on
 * a long-lived token would make the credential itself ambient authority, and
 * the token has to keep meaning "this person" for as long as it exists. A
 * Bearer caller reaching this endpoint has misunderstood its own transport, so
 * it is refused rather than quietly ignored.
 *
 * An actor surface — `requireActorAuth()` — and it has to be, because this is
 * the way back. Under the fail-closed default every route refuses while a
 * switch is on; if this one did too, a switched browser could enter a record
 * and never leave it, which turns a read-only convenience into a trap. So the
 * mode is declared, and the declaration is narrow: the only row this handler
 * touches is the caller's own session.
 *
 * What it writes is a SELECTOR, not a permission. The grant is validated here
 * before the stamp so a client gets an immediate, honest refusal instead of a
 * switch that appears to work and 403s on the next page — but the stamp itself
 * authorises nothing, and the resolver re-checks the grant on every request
 * that follows. A value stranded here by a revocation seconds later confers
 * exactly nothing.
 *
 * v1.37.0 — unfenced, deliberately, and the reason is the same one that makes
 * it an actor surface: this is the way back. A session whose context cannot be
 * proved must still be able to leave the record it may or may not be in, and
 * fencing the exit would make an unprovable context unrecoverable.
 *
 * What it takes instead is an optional `expectedEpoch`, which turns the
 * selector write into a compare-and-set. Two tabs pressing the switcher at once
 * both name the epoch they saw; one `UPDATE` matches, the loser gets zero rows
 * and the same 409 the fence raises, and the browser reconciles through
 * `/api/auth/me` before retrying. That is the monotonic ordering a server-side
 * pending lease was proposed for, in one statement, with no intermediate state
 * for a crashed initiator to strand.
 *
 * An ABSENT `expectedEpoch` keeps the unconditional write, and the two halves
 * of what that means are worth stating together:
 *
 *   * It is reachable only by a bundle that predates the fence. The switcher is
 *     rendered from `/api/auth/me` data, so a fence-aware client has adopted a
 *     context before it can offer a switch at all — it never omits the field.
 *   * It can therefore clobber a concurrent fenced switch. That is accepted:
 *     the fenced tab's next request asserts an epoch the row no longer holds,
 *     it takes the 409, and it reconciles to the truth; the pre-fence tab
 *     reloads into a fence-aware bundle immediately afterwards. Fail-closed and
 *     self-healing, bounded to the deploy window.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  RecordSessionChangedError,
  requireActorAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  pointSessionAt,
  pointSessionAtIfUnchanged,
} from "@/lib/sharing/acting-session";
import { findActiveGrant } from "@/lib/sharing/grant-access";
import { switchAccountSchema } from "@/lib/validations/account-sharing";

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireActorAuth();

  if (auth.authMethod !== "cookie") {
    return apiError(
      "Account switching is a browser-session feature; send the account selector header instead",
      400,
      { errorCode: "sharing.switch.wrong_transport" },
    );
  }

  const parsed = await parseJsonBody(request, switchAccountSchema, {
    maxBytes: 4 * 1024,
    errorCode: "sharing.switch.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const { accountId, expectedEpoch } = parsed.data;
  const ip = getClientIp(request);

  /**
   * Move the selector, conditionally when the caller named an epoch.
   *
   * Returns the record context the session ends up in, so the response can
   * publish it — this endpoint and `/api/auth/me` are the only two responses a
   * client may ADOPT a context from, and both carry it in the body. Every other
   * response's echo is used to validate and never to adopt.
   *
   * `null` on the unconditional arm, and that is the honest answer rather than
   * a gap: the epoch after an unconditional write is whatever the trigger
   * decided, this statement did not read it back, and a number computed here
   * would be wrong the moment the target equalled the current selector (the
   * trigger's `IS DISTINCT FROM` clause declines to move on a no-op write). A
   * caller that omitted `expectedEpoch` is by construction a bundle that would
   * not read the field anyway, and `/api/auth/me` states the truth on its next
   * boot.
   */
  async function moveSelector(
    target: string | null,
  ): Promise<{ epoch: number; scope: string | null } | null | "stale"> {
    if (expectedEpoch === undefined) {
      await pointSessionAt(auth.session.id, auth.user.id, target);
      return null;
    }
    const outcome = await pointSessionAtIfUnchanged(
      auth.session.id,
      auth.user.id,
      target,
      expectedEpoch,
    );
    if (outcome.kind === "stale") return "stale";
    return { epoch: outcome.epoch, scope: target };
  }

  if (accountId === null) {
    const moved = await moveSelector(null);
    if (moved === "stale") {
      annotate({ meta: { sharing_refusal: "switch_epoch_stale" } });
      throw new RecordSessionChangedError();
    }
    await auditLog("sharing.switch.off", {
      userId: auth.user.id,
      details: {},
      ipAddress: ip,
    }).catch(() => {});
    annotate({ action: { name: "sharing.switch.off" } });
    return apiSuccess({ actingAs: null, recordSession: moved });
  }

  // The same predicate the resolver uses, on the same table, with no second
  // idea of "active" anywhere in this file. If this route decided for itself,
  // it would drift from the resolver in exactly one direction: a switch the
  // panel accepts and the next request refuses, or worse, the reverse.
  const grant = await findActiveGrant({
    grantorId: accountId,
    granteeId: auth.user.id,
  });
  if (!grant) {
    // The flat refusal, with no reason on the wire. An account that does not
    // exist and an account that granted nothing are the same empty row from
    // the same query, so a caller learns nothing about who has an account here.
    await auditLog("sharing.access.denied", {
      userId: auth.user.id,
      details: { reason: "switch_no_active_grant", target: accountId },
      ipAddress: ip,
    }).catch(() => {});
    throw new SharingAccessDeniedError();
  }

  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: grant.grantorId },
    select: { id: true, username: true, displayName: true },
  });

  const moved = await moveSelector(owner.id);
  if (moved === "stale") {
    annotate({ meta: { sharing_refusal: "switch_epoch_stale" } });
    throw new RecordSessionChangedError();
  }

  await auditLog("sharing.switch.on", {
    userId: auth.user.id,
    details: { grantId: grant.id, grantorId: owner.id },
    ipAddress: ip,
  }).catch(() => {});

  annotate({
    action: { name: "sharing.switch.on" },
    meta: { grant_id: grant.id },
  });

  return apiSuccess({
    actingAs: {
      accountId: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      access: grant.access,
    },
    recordSession: moved,
  });
});
