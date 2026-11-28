import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { readHeldUnitPreferences } from "@/lib/onboarding/needs";
import {
  completeNeedsFlow,
  refuseManagedRecord,
} from "@/lib/onboarding/confirm";
import { NextRequest } from "next/server";
import { onboardingCompleteSchema } from "@/lib/validations/onboarding";
import { dateOfBirthForStorage } from "@/lib/tz/date-only";
import { resolveStoredTimezone } from "@/lib/tz/resolver";

/**
 * Complete the onboarding flow. Saves optional profile data and marks
 * onboarding as completed.
 *
 * v1.39 — the confirm screen's endpoint for the needs-based flow, and the
 * one completion write there is. The stamp half is what it always was: the
 * optional profile fields, the completion stamp on
 * `User.onboardingCompletedAt`, and the cleared pending cookie — the welcome
 * screen's "skip for now" is this route with an empty body. The needs half
 * runs only for a record that actually FINISHED the questions — every one
 * of them answered or deliberately passed — and is what turns them into a
 * module map and a dashboard order — ONCE, guarded by
 * `OnboardingRecord.modulesDerivedAt`, because a re-derivation would
 * re-apply the questionnaire over decisions taken in Settings since. `POST
 * /api/onboarding/restart` clears that marker when the person asks for the
 * questions again.
 *
 * v1.39 — the dashboard order joins the derivation. The five-step
 * wizard's goal slugs used to seed it from their own route; the answers now
 * carry both halves of Q2 — which modules are on, and what is on top — and
 * the seed keeps the wizard's one contract: only while the layout column is
 * still unset.
 *
 * `managedRecordId` (C2) — "someone I look after". The answers were given
 * FOR the profile the confirm screen just created, so the derivation and the
 * seed land on THAT record: the same access rule the guardian's own
 * `PATCH /api/record-settings/modules` applies (an active guardian grant on a
 * managed record), the same `writeRecordModulePreferences`, the same audit
 * event. The caller's own record is stamped complete and its derivation
 * marker set — latched, so a later confirm cannot derive the child's answers
 * onto the guardian — and its module map is not touched. A guardian's own
 * dashboard and modules are theirs; the child's answers say nothing about
 * them.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "onboarding.complete" } });

  const result = await parseJsonBody(request, onboardingCompleteSchema, {
    maxBytes: 64 * 1024,
    message: "Invalid input",
    errorCode: "onboarding.complete.invalid",
  });
  if (!result.ok) return result.error;

  const data: Record<string, unknown> = {
    onboardingCompletedAt: new Date(),
  };

  if (result.data.heightCm) {
    data.heightCm = result.data.heightCm;
  }

  if (result.data.dateOfBirth) {
    // The calendar day in the owner's zone: the iOS app sends an instant.
    const dob = dateOfBirthForStorage(
      result.data.dateOfBirth,
      await resolveStoredTimezone(user.timezone),
    );
    if (dob) data.dateOfBirth = dob;
  }

  if (result.data.gender) {
    data.gender = result.data.gender;
  }

  if (result.data.displayName) {
    data.displayName = result.data.displayName;
  }

  // The managed arm is checked BEFORE anything is stamped: a refused record
  // must leave the flow exactly where it was, so the person can fix the
  // answer or the profile and confirm again.
  const managedRecordId = result.data.managedRecordId ?? null;
  if (managedRecordId !== null) {
    const refusal = await refuseManagedRecord(user.id, managedRecordId);
    if (refusal) return refusal;
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });

  // v1.4.22 — clear the proxy-readable onboarding cookie so the
  // next navigation drops the /onboarding redirect immediately.
  await setOnboardingPendingCookie(false);

  const onboarding = await completeNeedsFlow(
    user.id,
    readHeldUnitPreferences(user),
    request,
    managedRecordId,
  );

  return apiSuccess({ completed: true, ...(onboarding ? { onboarding } : {}) });
});
