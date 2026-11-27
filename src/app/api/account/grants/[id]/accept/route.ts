/**
 * `POST /api/account/grants/[id]/accept` — the delegate accepts an invitation.
 *
 * The handshake exists because being handed read access to somebody's health
 * record is not something to impose silently: an invitation confers nothing
 * until the person named on it says yes, which is why `isGrantActive` fails a
 * row with `acceptedAt IS NULL` and why this route is the only thing that can
 * set it.
 *
 * The acceptance is also the consent record. `acceptedAt` is stamped here and
 * never anywhere else, on the same row that carries who offered the access and
 * when it ended — one row, one history, no second receipt table to disagree
 * with it. The address the delegate accepted from is deliberately not part of
 * it: who and when is what a consent record has to answer, and an address kept
 * for the life of both accounts answers nothing further. The audit row below
 * still carries it, under `audit_logs`' own retention.
 *
 * Not delegable: `requireSelfAuth()` refuses under a switch, so nobody can
 * accept an invitation while acting as somebody else. The delegate is the
 * session user, never a body field, and `acceptGrant` puts that id in the
 * `where` of a conditional update — so an invitation addressed to another
 * account matches nothing and is refused as not-yours rather than accepted by
 * the wrong person.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { GRANT_PARTY_SELECT, toGrantView } from "@/lib/sharing/grant-view";
import { acceptGrant, GrantError } from "@/lib/sharing/grants";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Thirty a minute. Accepting is a one-shot transition per row, so the only
 * traffic this bounds is somebody guessing grant ids — which the conditional
 * update already refuses; the limit just stops them doing it quickly.
 */
const ACCEPT_LIMIT = 30;
const ACCEPT_WINDOW_MS = 60 * 1000;

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireSelfAuth();

    const rl = await checkRateLimit(
      `sharing:accept:${user.id}`,
      ACCEPT_LIMIT,
      ACCEPT_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many attempts, try again later", 429);
    }

    const { id } = await params;
    const ip = getClientIp(request);

    try {
      const grant = await acceptGrant({
        grantId: id,
        granteeId: user.id,
      });

      const grantor = await prisma.user.findUniqueOrThrow({
        where: { id: grant.grantorId },
        select: GRANT_PARTY_SELECT,
      });

      // Filed under the delegate, because accepting is the delegate's own act
      // and `actorUserId` NULL means exactly that. The owner's side of this
      // fact is not an audit row at all — it is `acceptedAt` on the grant,
      // which their panel reads.
      await auditLog("sharing.grant.accepted", {
        userId: user.id,
        details: { grantId: grant.id, grantorId: grant.grantorId },
        ipAddress: ip,
      }).catch(() => {});

      annotate({
        action: { name: "sharing.grant.accepted" },
        meta: { grant_id: grant.id },
      });

      return apiSuccess(toGrantView(grant, grantor));
    } catch (err) {
      if (err instanceof GrantError) return acceptErrorResponse(err);
      throw err;
    }
  },
);

/**
 * Why the acceptance was refused.
 *
 * `not_found` and `not_grantee` deliberately answer the same 404: an
 * invitation addressed to somebody else is, as far as this caller is
 * concerned, not there. Confirming it exists would tell a stranger that a
 * particular grant id is real and that two accounts share a record.
 */
function acceptErrorResponse(err: GrantError): Response {
  switch (err.code) {
    case "expired":
      return apiError("That invitation has lapsed", 410, {
        errorCode: "sharing.accept.expired",
      });
    case "already_revoked":
      return apiError("That invitation was withdrawn", 410, {
        errorCode: "sharing.accept.revoked",
      });
    case "not_pending":
      return apiError("That invitation was already accepted", 409, {
        errorCode: "sharing.accept.not_pending",
      });
    default:
      return apiError("Invitation not found", 404, {
        errorCode: "sharing.accept.not_found",
      });
  }
}
