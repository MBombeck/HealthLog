import { prisma, toJson } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { normalisePrefs } from "@/lib/modules/gate";
import { modulesHoldingRecordData } from "@/lib/modules/domain-data";
import {
  deriveOnboardingModuleDefaults,
  mergeDerivedModulePreferences,
  OWNED_MODULE_KEYS,
} from "@/lib/modules/registry";
import {
  everyOnboardingQuestionSettled,
  readHeldUnitPreferences,
  resolveOnboardingSteps,
  type HeldUnitPreferences,
} from "@/lib/onboarding/needs";
import {
  ONBOARDING_RECORD_SELECT,
  readOnboardingRecordState,
  toOnboardingStateDto,
} from "@/lib/onboarding/needs-store";
import { writeRecordModulePreferences } from "@/lib/record-settings/modules";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { onboardingCompleteSchema } from "@/lib/validations/onboarding";

/**
 * Complete the onboarding flow. Saves optional profile data and marks
 * onboarding as completed.
 *
 * v1.39 (C1) — this is also the confirm screen's endpoint for the needs-based
 * flow, and the two live side by side rather than one replacing the other.
 * The legacy half is unchanged: the optional profile fields, the completion
 * stamp on `User.onboardingCompletedAt`, and the cleared pending cookie. The
 * needs half runs only for a record that actually FINISHED the questions —
 * every one of them answered or deliberately passed — and is what turns them
 * into a module
 * map — ONCE, guarded by `OnboardingRecord.modulesDerivedAt`, because a
 * re-derivation would re-apply the questionnaire over decisions taken in
 * Settings since. `POST /api/onboarding/restart` clears that marker when the
 * person asks for the questions again.
 *
 * The goal slugs of today (`src/lib/onboarding/goals.ts`, the four-step wizard
 * at `POST /api/onboarding/step`) are untouched and stay live until C2
 * replaces that surface. They decide TILE ORDER; the answers below decide
 * WHICH MODULES ARE ON. Neither reads the other.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "onboarding.complete" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const result = z.safeParse(onboardingCompleteSchema, body);
  if (!result.success) {
    return apiError("Invalid input", 422, {
      errorCode: "onboarding.complete.invalid",
    });
  }

  const data: Record<string, unknown> = {
    onboardingCompletedAt: new Date(),
  };

  if (result.data.heightCm) {
    data.heightCm = result.data.heightCm;
  }

  if (result.data.dateOfBirth) {
    const dob = new Date(result.data.dateOfBirth);
    if (!isNaN(dob.getTime())) {
      data.dateOfBirth = dob;
    }
  }

  if (result.data.gender) {
    data.gender = result.data.gender;
  }

  if (result.data.displayName) {
    data.displayName = result.data.displayName;
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });

  // v1.4.22 C4 — clear the proxy-readable onboarding cookie so the
  // next navigation drops the /onboarding redirect immediately.
  await setOnboardingPendingCookie(false);

  const onboarding = await completeNeedsFlow(
    user.id,
    readHeldUnitPreferences(user),
    request,
  );

  return apiSuccess({ completed: true, ...(onboarding ? { onboarding } : {}) });
});

/**
 * The needs half: derive the module map once, mark the confirm step, stamp the
 * flow's own completion.
 *
 * Returns the published state, or `null` for a caller that never entered the
 * needs flow — a legacy wizard completion then answers exactly the body it
 * always did.
 */
async function completeNeedsFlow(
  userId: string,
  held: HeldUnitPreferences,
  request: NextRequest,
) {
  const record = await prisma.onboardingRecord.findUnique({
    where: { userId },
    select: ONBOARDING_RECORD_SELECT,
  });
  if (!record) return null;

  const state = readOnboardingRecordState(record);
  // The units question answers itself for an account that already holds both
  // preferences, so the gate and the published state read the same resolved
  // ledger rather than the raw one.
  const steps = resolveOnboardingSteps(state.steps, held);
  if (state.needs.recordTarget === null) {
    // The row exists but Q1 was never answered, so there is nothing to derive
    // from. Stamping a completion here would claim a setup that did not happen.
    annotate({
      action: { name: "onboarding.needs.complete" },
      meta: { outcome: "no_answers" },
    });
    return toOnboardingStateDto(record, held);
  }
  if (!everyOnboardingQuestionSettled(steps)) {
    // The confirm screen is the only caller that may derive, and it is reached
    // only once every question has an answer or a deliberate pass. Q1 alone is
    // not enough: an abandoned flow would have every remaining question read
    // as its conservative default, switch off the surfaces that default
    // implies, and latch the result so nobody could re-derive it. This route
    // is also the LEGACY wizard's endpoint, and that wizard knows nothing
    // about these questions — so a person who answered Q1, left, and later
    // finished the old wizard must not have a module map derived for them.
    annotate({
      action: { name: "onboarding.needs.complete" },
      meta: { outcome: "incomplete" },
    });
    return toOnboardingStateDto(record, held);
  }

  let derived = false;
  let keptForData: string[] = [];
  if (record.modulesDerivedAt === null) {
    const defaults = deriveOnboardingModuleDefaults({
      recordTarget: state.needs.recordTarget,
      areas: state.needs.areas,
      // An unanswered (skipped) question is the conservative answer: no
      // medication surface, no doctor report. Both stay one click away in
      // Settings, which is the whole ordering-versus-removal decision.
      medication: state.needs.medication ?? "no",
      visit: state.needs.visit ?? "no",
    });

    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { modulePreferencesJson: true },
    });
    // Only the modules the answers would switch OFF are worth asking about,
    // and a record that already holds rows in one of those domains keeps its
    // surface: the flow orders a record, and it cannot order away content
    // somebody already has.
    const wouldSwitchOff = OWNED_MODULE_KEYS.filter(
      (key) => defaults.preferences[key] === false,
    );
    const holdsData = await modulesHoldingRecordData(
      prisma,
      userId,
      wouldSwitchOff,
    );
    const merged = mergeDerivedModulePreferences(
      normalisePrefs(row?.modulePreferencesJson),
      defaults.preferences,
      holdsData,
    );
    // The same record-keyed write the guardian's modules route uses, so the
    // two surfaces that decide a record's modules cannot drift apart on how
    // the decision is stored or what it invalidates. `cycle` delegates to
    // `CycleProfile.cycleTrackingEnabled`, so the module blob never owns it,
    // and it is only ever switched ON from here: the gate derives an
    // unanswered cycle from recorded sex, and an untick is not a request to
    // retract that.
    await writeRecordModulePreferences({
      recordId: userId,
      modulePreferences: merged,
      ...(defaults.cycleTracking ? { cycleTrackingEnabled: true } : {}),
    });

    // The same trail the dedicated modules route writes, under the same event
    // name, because it is the same column and the activity panel is where
    // somebody goes to ask why their modules changed. The flow was writing
    // three audited settings columns and leaving no trail at all, which made
    // the answer to that question "nothing did it".
    const stored = normalisePrefs(row?.modulePreferencesJson);
    const changed = [
      ...Object.keys(merged).filter((key) => merged[key] !== stored[key]),
      ...(defaults.cycleTracking ? ["cycleTrackingEnabled"] : []),
    ];
    await auditLog("user.modules.update", {
      userId,
      ipAddress: getClientIp(request),
      details: { changed, keptForData: [...holdsData], source: "onboarding" },
    });

    keptForData = [...holdsData];
    derived = true;
  }

  const now = new Date();
  const confirmed = steps.map((step) =>
    step.id === "confirm" && step.status === "pending"
      ? { ...step, status: "done" as const }
      : step,
  );
  const written = await prisma.onboardingRecord.update({
    where: { userId },
    data: {
      stepsJson: toJson(confirmed),
      completedAt: now,
      ...(derived ? { modulesDerivedAt: now } : {}),
    },
    select: ONBOARDING_RECORD_SELECT,
  });

  annotate({
    action: { name: "onboarding.needs.complete" },
    meta: {
      outcome: derived ? "derived" : "already_derived",
      keptForData: keptForData.length,
    },
  });

  return toOnboardingStateDto(written, held);
}
