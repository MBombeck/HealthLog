/**
 * 1.49 — `GET /api/onboarding/extras`: the presence behind the
 * getting-started checklist's optional "More" group (emergency card, care
 * calendar feed, sharing, imports, doctor report schedule, the iPhone app).
 *
 * `requireGuardianAuth()`: the record's owner on their own record, or the
 * guardian of a managed profile, who holds the profile's emergency card, care
 * calendar and report schedule; a delegate on an adult's record is refused, so
 * the group never shows there. Existence and counts only. Read once, when the
 * person opens the group.
 */
import { apiHandler, requireGuardianAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { loadChecklistExtras } from "@/lib/onboarding/checklist-extras-load";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user, actor } = await requireGuardianAuth();
  const recordKind = user.id === actor.id ? "self" : "managed";
  annotate({
    action: { name: "onboarding.extras.get" },
    meta: { recordKind },
  });
  return apiSuccess(
    await loadChecklistExtras({ recordId: user.id, recordKind }),
  );
});
