/**
 * `POST /api/account/grants/[id]/renounce` — the delegate hands the access back.
 *
 * The same transition as the owner's revoke, attributed to the other party:
 * `revokedBy = GRANTEE`, so the record can tell "she withdrew it" from "he
 * decided he no longer wanted it". Two facts, one column, because they are
 * answers to the same question and a trail that conflated them would misread
 * an ordinary handover as a fallout.
 *
 * Its own verb rather than a second meaning for DELETE. The owner's revoke and
 * the delegate's renunciation look identical in the database and are entirely
 * different acts; letting one endpoint mean both would put a `revokedBy`
 * decision inside a caller-identity check, which is exactly the sort of branch
 * that gets simplified later by somebody who does not know why it was there.
 *
 * Frictionless for the same reason as revocation, and cleaned up in the same
 * transaction: every session of theirs sitting inside that record leaves with
 * the grant, including the ones on other devices.
 *
 * Not delegable: `requireSelfAuth()`, so this cannot be done while acting as
 * somebody else, and the delegate is the session user rather than a body field.
 * That costs a browser already inside the record one extra request — switch
 * out, then renounce — and the exchange is worth it. Grant management is the
 * one surface where a delegate acting as somebody else must have no reach at
 * all, and "except this one endpoint, which only ever reduces" is precisely
 * the kind of exception that gets widened by somebody who reads the exception
 * and not the reason. Ending the access is still one click; the client makes
 * the switch-back call on the way.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { GRANT_PARTY_SELECT, toGrantView } from "@/lib/sharing/grant-view";
import { LastManagedGuardianError } from "@/lib/managed-profiles/lifecycle";
import { GrantError, renounceGrantAndClearSwitch } from "@/lib/sharing/grants";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireSelfAuth();
    const { id } = await params;

    try {
      const { grant, sessionsCleared } = await renounceGrantAndClearSwitch({
        grantId: id,
        granteeId: user.id,
      });

      const grantor = await prisma.user.findUniqueOrThrow({
        where: { id: grant.grantorId },
        select: GRANT_PARTY_SELECT,
      });

      await auditLog("sharing.grant.renounced", {
        userId: user.id,
        details: {
          grantId: grant.id,
          grantorId: grant.grantorId,
          sessionsCleared,
        },
        ipAddress: getClientIp(request),
      }).catch(() => {});

      annotate({
        action: { name: "sharing.grant.renounced" },
        meta: { grant_id: grant.id, sessions_cleared: sessionsCleared },
      });

      return apiSuccess({
        ...toGrantView(grant, grantor),
        sessionsCleared,
      });
    } catch (err) {
      if (err instanceof GrantError) return renounceErrorResponse(err);
      if (err instanceof LastManagedGuardianError) {
        return apiError("Add another Guardian before ending this access", 409, {
          errorCode: "managed_profile.guardian.required",
        });
      }
      throw err;
    }
  },
);

function renounceErrorResponse(err: GrantError): Response {
  if (err.code === "already_revoked") {
    return apiError("That access has already ended", 409, {
      errorCode: "sharing.renounce.already_ended",
    });
  }
  return apiError("Grant not found", 404, {
    errorCode: "sharing.renounce.not_found",
  });
}
