/**
 * `/api/account/handover-decision` — the new owner's final word on each former
 * Guardian after claiming a managed profile (v1.42, #959).
 *
 * The claim applies the access the issuing Guardian proposed, so the record
 * is never without a decision. This is where the owner sees it and decides:
 *
 *   - `GET` answers the decision that is waiting, or `pending: null`.
 *   - `POST` records it. A Guardian the body leaves out keeps what the claim
 *     gave them; after this, the ordinary Settings → Shared access panel is
 *     where access changes.
 *
 * A grant-management surface, resolved like the others (`/api/account/
 * grants/**`): bare `requireAuth()`, which refuses under an acting-account
 * switch and refuses a narrow Bearer scope. The owner is the session user; no
 * party to any grant comes from the body, only the claim-time grant id that
 * names which former Guardian a decision is about.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  decideHandover,
  HandoverError,
  readPendingHandoverDecision,
} from "@/lib/managed-profiles/handover";
import { notifyGuardiansOfHandover } from "@/lib/managed-profiles/handover-notify";
import { prisma } from "@/lib/db";
import { handoverDecisionSchema } from "@/lib/validations/managed-profile-handover";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  const pending = await readPendingHandoverDecision(user.id);
  annotate({
    action: { name: "managed_profile.handover.decision_read" },
    meta: { pending: pending !== null },
  });
  return apiSuccess({
    pending: pending
      ? {
          claimedAt: pending.claimedAt.toISOString(),
          guardians: pending.guardians,
        }
      : null,
  });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = handoverDecisionSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  let result;
  try {
    result = await decideHandover({
      userId: user.id,
      decisions: parsed.data.decisions.map((d) => ({
        grantId: d.grantId,
        access: d.access,
      })),
    });
  } catch (error) {
    if (error instanceof HandoverError) {
      if (error.code === "unknown_guardian") {
        return apiError(
          "A decision names somebody who was not a Guardian",
          422,
          {
            errorCode: "managed_profile.handover.unknown_guardian",
          },
        );
      }
      return apiError("There is no handover decision waiting", 409, {
        errorCode: "managed_profile.handover.no_pending",
      });
    }
    throw error;
  }

  if (result.changed.length > 0) {
    const self = await prisma.user.findUnique({
      where: { id: user.id },
      select: { displayName: true, username: true },
    });
    notifyGuardiansOfHandover(
      "changed",
      self?.displayName?.trim() || self?.username || user.username,
      result.changed,
    );
  }

  annotate({
    action: { name: "managed_profile.handover.decided" },
    meta: { changed: result.changed.length },
  });
  return apiSuccess({ decided: true, changed: result.changed.length });
});
