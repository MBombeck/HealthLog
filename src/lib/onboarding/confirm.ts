/**
 * Confirming the person setup flow (1.50): the one completion write, shared
 * by `POST /api/onboarding/complete` and by `PATCH /api/onboarding/answers`,
 * which confirms on its own once the last owed screen is answered. Neither
 * client orchestrates the unshown questions or a separate confirm call.
 */
import { prisma, toJson } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { apiError, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { normalisePrefs } from "@/lib/modules/gate";
import { modulesHoldingRecordData } from "@/lib/modules/domain-data";
import {
  deriveOnboardingModuleDefaults,
  mergeDerivedModulePreferences,
  OWNED_MODULE_KEYS,
} from "@/lib/modules/registry";
import { buildNeedsSeededDashboardLayout } from "@/lib/onboarding/dashboard-seed";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { applyOnboardingAnswer } from "@/lib/onboarding/needs-apply";
import {
  everyOnboardingQuestionSettled,
  hasEnteredOnboardingFlow,
  resolveOnboardingSteps,
  type HeldUnitPreferences,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";
import {
  questionsToPassBeforeConfirm,
  resumeScreen,
  type PersonSegmentId,
} from "@/lib/onboarding/wizard-steps";
import {
  ONBOARDING_RECORD_SELECT,
  readOnboardingRecordState,
  toOnboardingStateDto,
} from "@/lib/onboarding/needs-store";
import { loadOnboardingOffers } from "@/lib/onboarding/load-offers";
import { readManagedProfileForGuardian } from "@/lib/managed-profiles/lifecycle";
import { writeRecordModulePreferences } from "@/lib/record-settings/modules";

/**
 * Whether `managedRecordId` may receive this caller's answers: the record
 * must be a managed profile the caller actively guards, and the answer to Q1
 * must be "someone-else" — the one answer that says the questions were about
 * another person. A `null` means proceed.
 */
export async function refuseManagedRecord(
  userId: string,
  managedRecordId: string,
): Promise<Response | null> {
  const guarded = await readManagedProfileForGuardian({
    profileId: managedRecordId,
    guardianId: userId,
  });
  if (!guarded) {
    // 404 for every case at once — missing, not a managed profile, not
    // guarded by the caller — as the id-addressed managed-profile route
    // answers (`managed_profile.not_found`): one answer, no existence oracle.
    annotate({
      action: { name: "onboarding.needs.complete" },
      meta: { outcome: "record_not_found" },
    });
    return apiError("Managed record not found", 404, {
      errorCode: "onboarding.complete.recordNotFound",
    });
  }
  const record = await prisma.onboardingRecord.findUnique({
    where: { userId },
    select: ONBOARDING_RECORD_SELECT,
  });
  const state = readOnboardingRecordState(record);
  if (state.needs.recordTarget !== "someone-else") {
    annotate({
      action: { name: "onboarding.needs.complete" },
      meta: { outcome: "record_target_mismatch" },
    });
    return apiError(
      "The answers were not given for somebody else's record",
      422,
      { errorCode: "onboarding.complete.recordTargetMismatch" },
    );
  }
  return null;
}

/**
 * The needs half: derive the module map once, mark the confirm step, stamp the
 * flow's own completion.
 *
 * Returns the published state, or `null` for a caller that never entered the
 * needs flow — a legacy wizard completion then answers exactly the body it
 * always did.
 */
/** The ledger as published: units and the follow-ups resolved (1.49). */
async function resolvedFlow(
  userId: string,
  state: ReturnType<typeof readOnboardingRecordState>,
  held: HeldUnitPreferences,
) {
  const offers = await loadOnboardingOffers(userId);
  const context = { held, needs: state.needs, offers };
  return { offers, steps: resolveOnboardingSteps(state.steps, context) };
}

/**
 * Write the module map the answers derive, merged into the blob as it is
 * stored at write time, under the record's row lock: a module switched from
 * another device while the flow completes is not written over by a read made
 * before it. Returns the stored map it merged into and the map it wrote.
 */
async function writeDerivedModules(
  recordId: string,
  defaults: ReturnType<typeof deriveOnboardingModuleDefaults>,
  holdsData: ReadonlySet<string>,
) {
  let stored = normalisePrefs(null);
  let merged = stored;
  await writeRecordModulePreferences({
    recordId,
    modulePreferences: (blob) => {
      stored = normalisePrefs(blob);
      merged = mergeDerivedModulePreferences(
        stored,
        defaults.preferences,
        holdsData,
      );
      return merged;
    },
    ...(defaults.cycleTracking ? { cycleTrackingEnabled: true } : {}),
  });
  return { stored, merged };
}

export async function completeNeedsFlow(
  userId: string,
  held: HeldUnitPreferences,
  request: Request,
  managedRecordId: string | null,
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
  const { steps, offers } = await resolvedFlow(userId, state, held);
  if (state.needs.recordTarget === null) {
    // The row exists but Q1 was never answered, so there is nothing to derive
    // from. Stamping a completion here would claim a setup that did not happen.
    annotate({
      action: { name: "onboarding.needs.complete" },
      meta: { outcome: "no_answers" },
    });
    return toOnboardingStateDto(record, held, offers);
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
    return toOnboardingStateDto(record, held, offers);
  }

  const now = new Date();
  let derived = false;
  let dashboardSeeded = false;
  let keptForData: string[] = [];
  // "Someone I look after" with no profile to apply the answers to: the
  // person declined (or could not, without a second factor) to create it on
  // the confirm screen. There is no record the answers describe yet, and
  // they must not describe the guardian's — so the flow is stamped complete
  // and LATCHED without deriving or seeding anything. The profile created
  // later under Settings starts from the defaults. Enforced here, on the
  // server, whatever the client sent.
  const answersForNobody =
    state.needs.recordTarget === "someone-else" && managedRecordId === null;
  if (record.modulesDerivedAt === null && !answersForNobody) {
    // The record the answers are about: the managed profile for "someone I
    // look after" (verified above), otherwise the caller's own.
    const targetId = managedRecordId ?? userId;
    const defaults = deriveOnboardingModuleDefaults({
      recordTarget: state.needs.recordTarget,
      areas: state.needs.areas,
      // A question that was not asked or was skipped is no answer: the
      // module keeps its default. Only an explicit "no" switches it off.
      medication: state.needs.medication ?? null,
      visit: state.needs.visit ?? null,
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
      targetId,
      wouldSwitchOff,
    );
    // The same record-keyed write the guardian's modules route uses, so the
    // two surfaces that decide a record's modules cannot drift apart on how
    // the decision is stored or what it invalidates. `cycle` delegates to
    // `CycleProfile.cycleTrackingEnabled`, so the module blob never owns it,
    // and it is only ever switched ON from here: the gate derives an
    // unanswered cycle from recorded sex, and an untick is not a request to
    // retract that.
    const { stored, merged } = await writeDerivedModules(
      targetId,
      defaults,
      holdsData,
    );

    // The same trail the dedicated modules route writes, under the same event
    // name, because it is the same column and the activity panel is where
    // somebody goes to ask why their modules changed. The flow was writing
    // three audited settings columns and leaving no trail at all, which made
    // the answer to that question "nothing did it".
    const changed = [
      ...Object.keys(merged).filter((key) => merged[key] !== stored[key]),
      ...(defaults.cycleTracking ? ["cycleTrackingEnabled"] : []),
    ];
    await auditLog("user.modules.update", {
      userId: targetId,
      ipAddress: getClientIp(request),
      details: {
        changed,
        keptForData: [...holdsData],
        source: "onboarding",
        ...(managedRecordId ? { guardianId: userId } : {}),
      },
    });

    keptForData = [...holdsData];
    derived = true;

    // The ordering half of Q2. ONE-TIME and conditional: `updateMany` carries
    // the `dashboardWidgetsJson IS NULL` precondition in its WHERE, so a
    // layout somebody already arranged — or a concurrent layout save that
    // lands first — leaves `count = 0` and the seed is skipped rather than
    // overwriting it. An answer set that speaks to no tile builds `null` and
    // writes nothing, which leaves the default layout in place.
    // `AnyNull`, not `JsonNull`: an unset column is a SQL NULL, which
    // `JsonNull` (a JSON `null` value) does not match — the retired step route
    // carried that filter and its seed never landed on a fresh account.
    const seededLayout = buildNeedsSeededDashboardLayout(state.needs);
    if (seededLayout) {
      const seeded = await prisma.user.updateMany({
        where: {
          id: targetId,
          dashboardWidgetsJson: { equals: Prisma.AnyNull },
        },
        data: { dashboardWidgetsJson: toJson(seededLayout) },
      });
      dashboardSeeded = seeded.count === 1;
    }

    // The managed record's own setup row: the answers it was configured
    // from, every step settled, both stamps set. Its account payload then
    // reads a finished setup rather than nine pending steps, and a guardian
    // who opens the questions from inside that record later is offered a
    // re-run, not a first run.
    if (managedRecordId) {
      // `needsJson` is the guardian's answers as given, `recordTarget`
      // "someone-else" included: from inside the child's record that reads
      // as "for somebody else", which is true of how it was set up. Nothing
      // acts on it there — the three writes refuse under a switch — so it is
      // kept as the honest record of the flow that configured the row.
      const settled = steps.map((step) => ({
        ...step,
        status: "done" as const,
      }));
      await prisma.onboardingRecord.upsert({
        where: { userId: managedRecordId },
        create: {
          userId: managedRecordId,
          needsJson: toJson(state.needs),
          stepsJson: toJson(settled),
          completedAt: now,
          modulesDerivedAt: now,
        },
        update: {
          needsJson: toJson(state.needs),
          stepsJson: toJson(settled),
          completedAt: now,
          modulesDerivedAt: now,
        },
      });
    }
  }

  const confirmed = steps.map((step) =>
    step.id === "confirm" && step.status === "pending"
      ? { ...step, status: "done" as const }
      : step,
  );
  const written = await prisma.onboardingRecord.update({
    where: { userId },
    data: {
      stepsJson: toJson(confirmed),
      // Stamped once. The derivation is latched and the stamp should be too,
      // or a replay of the confirm quietly moves the instant the setup
      // finished at.
      completedAt: record.completedAt ?? now,
      // Latched on a derivation, and on the no-record arm as well: a later
      // confirm must not apply the child's answers to the guardian either.
      ...(derived || answersForNobody ? { modulesDerivedAt: now } : {}),
    },
    select: ONBOARDING_RECORD_SELECT,
  });

  annotate({
    action: { name: "onboarding.needs.complete" },
    meta: {
      outcome: answersForNobody
        ? "no_record_for_answers"
        : derived
          ? "derived"
          : "already_derived",
      keptForData: keptForData.length,
      dashboard_seeded: dashboardSeeded,
      ...(managedRecordId ? { target: "managed_record" } : {}),
    },
  });

  return toOnboardingStateDto(written, held, offers);
}

/**
 * Confirm the flow on the server once nothing is owed (1.50).
 *
 * Called by `PATCH /api/onboarding/answers` after every write. When the
 * published state has no screen left to resume on and either stamp is still
 * missing (the record's `completedAt` or the account's
 * `onboardingCompletedAt`, the one the first-run redirect follows), it passes
 * the questions this flow does not show and the retired first-result task on
 * the ledger, stamps the account, drops the first-run cookie and runs the one
 * completion write. Returns the published state after the confirm, or `null`
 * when there was nothing to confirm.
 *
 * `managedRecordId` rides the `confirm` answer ("someone I look after" with a
 * profile created on the profile screen) and was checked by the caller before
 * anything was written.
 */
export async function confirmWhenNothingOwed(input: {
  userId: string;
  accountStamped: boolean;
  held: HeldUnitPreferences;
  plan: readonly PersonSegmentId[] | null;
  request: Request;
  managedRecordId: string | null;
}): Promise<OnboardingStateDto | null> {
  const { userId, held, request, managedRecordId } = input;
  const row = await prisma.onboardingRecord.findUnique({
    where: { userId },
    select: ONBOARDING_RECORD_SELECT,
  });
  if (!row) return null;
  const offers = await loadOnboardingOffers(userId);
  const published = toOnboardingStateDto(row, held, offers);
  const flow = { ...published, plan: input.plan };
  if (!hasEnteredOnboardingFlow({ needs: flow.needs, completedAt: null })) {
    return null;
  }
  if (resumeScreen(flow) !== null) return null;
  if (published.completedAt !== null && input.accountStamped) return null;

  // The questions this flow never shows, and the retired first-result task,
  // are passed so the completion write sees every question settled.
  let state = readOnboardingRecordState(row);
  const pass = [
    ...questionsToPassBeforeConfirm(flow),
    ...(published.steps.some(
      (step) => step.id === "first-result" && step.status === "pending",
    )
      ? (["first-result"] as const)
      : []),
  ];
  for (const step of pass) {
    state = applyOnboardingAnswer(
      state,
      { step, status: "skipped" },
      new Date(),
    );
  }
  if (pass.length > 0) {
    await prisma.onboardingRecord.update({
      where: { userId },
      data: { stepsJson: toJson(state.steps) },
    });
  }

  if (!input.accountStamped) {
    await prisma.user.update({
      where: { id: userId },
      data: { onboardingCompletedAt: new Date() },
    });
  }
  await setOnboardingPendingCookie(false);
  annotate({
    action: { name: "onboarding.needs.autoconfirm" },
    meta: { passed: pass.length },
  });
  return completeNeedsFlow(userId, held, request, managedRecordId);
}
