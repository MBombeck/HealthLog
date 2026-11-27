/**
 * `DELETE /api/account/grants/[id]` — the owner withdraws access.
 *
 * **No step-up, no typed confirmation, no second factor, no ceremony.** That
 * is a decision, not an omission: reducing access must never be harder than
 * granting it was. Everything else in this product that guards a destructive
 * act guards it because the act is hard to undo — this one is the undo. A
 * person who wants their health record closed to somebody gets it closed on
 * the first click, and if they change their mind the invitation costs one
 * request to send again.
 *
 * Enforcement is the delegate's next request, not their next login: the
 * resolver re-reads the grant every time, so seconds, not sessions. What this
 * route adds on top is that the delegate's browser leaves too — the same
 * transaction clears the acting-account carrier on every session of theirs
 * pointing at this record, so a delegate sitting inside it lands back in their
 * own account instead of on a wall of 403s under a banner still naming the
 * owner.
 *
 * Despite the verb, nothing is deleted. `revokeGrant` stamps `revokedAt` and
 * `revokedBy` on a row that stays, because "who had access, from when to when,
 * and who ended it" is a question a deleted row cannot answer. DELETE is the
 * right HTTP verb for "end this thing"; it is not a promise about storage.
 *
 * Not delegable: `requireSelfAuth()` refuses under a switch, and the owner is
 * the session user, so a delegate can neither revoke somebody else's grant nor
 * hand their own to a third party.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { GRANT_PARTY_SELECT, toGrantView } from "@/lib/sharing/grant-view";
import { LastManagedGuardianError } from "@/lib/managed-profiles/lifecycle";
import { GrantError, revokeGrantAndClearSwitch } from "@/lib/sharing/grants";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireSelfAuth();
    const { id } = await params;

    try {
      const { grant, sessionsCleared } = await revokeGrantAndClearSwitch({
        grantId: id,
        grantorId: user.id,
      });

      const grantee = await prisma.user.findUniqueOrThrow({
        where: { id: grant.granteeId },
        select: GRANT_PARTY_SELECT,
      });

      await auditLog("sharing.grant.revoked", {
        userId: user.id,
        details: {
          grantId: grant.id,
          granteeId: grant.granteeId,
          sessionsCleared,
        },
        ipAddress: getClientIp(request),
      }).catch(() => {});

      annotate({
        action: { name: "sharing.grant.revoked" },
        meta: { grant_id: grant.id, sessions_cleared: sessionsCleared },
      });

      return apiSuccess({
        ...toGrantView(grant, grantee),
        sessionsCleared,
      });
    } catch (err) {
      if (err instanceof GrantError) return revokeErrorResponse(err);
      if (err instanceof LastManagedGuardianError) {
        return apiError("Add another Guardian before ending this access", 409, {
          errorCode: "managed_profile.guardian.required",
        });
      }
      throw err;
    }
  },
);

/**
 * A grant that is not this caller's to end reads as absent, for the same
 * reason it does on the accept path: a distinguishable refusal would confirm
 * that a given grant id exists.
 */
function revokeErrorResponse(err: GrantError): Response {
  if (err.code === "already_revoked") {
    return apiError("That access has already ended", 409, {
      errorCode: "sharing.revoke.already_ended",
    });
  }
  return apiError("Grant not found", 404, {
    errorCode: "sharing.revoke.not_found",
  });
}
