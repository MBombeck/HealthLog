/**
 * v1.39 (C1) — `PATCH /api/onboarding/answers`.
 *
 * One step at a time, saved the moment it is answered, so leaving the flow and
 * coming back resumes where it stopped (design spec §Principles 4). The body
 * names the step and either its answer or a deliberate skip; the union in
 * `src/lib/validations/onboarding-needs.ts` is what makes "skipped, and here is
 * the answer anyway" unrepresentable.
 *
 * Idempotent: the state is computed by a pure function from the stored row and
 * the body, so sending the same step twice writes the same value twice and the
 * second write changes nothing a reader can see. The one instant that could
 * drift — the first-result completion stamp — is kept from the existing row
 * rather than re-taken.
 *
 * `requireAuth()` rather than `requireRecordAuth`: this route writes the
 * CALLER's own record and refuses outright while the session is acting on
 * somebody else's (403 `sharing.not_permitted`), at every grant level. The
 * storage is keyed by record so a guardian running a managed profile's setup
 * has a row to write, but the route into it belongs with the rest of the
 * managed-record configuration (#939 / C2), not here — a delegable declaration
 * is a reviewed entry in the sharing surface guard, not a default.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { prisma, toJson } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { applyOnboardingAnswer } from "@/lib/onboarding/needs-apply";
import {
  ONBOARDING_RECORD_SELECT,
  readOnboardingRecordState,
  toOnboardingStateDto,
} from "@/lib/onboarding/needs-store";
import { checkRateLimit } from "@/lib/rate-limit";
import { onboardingAnswerSchema } from "@/lib/validations/onboarding-needs";

export const dynamic = "force-dynamic";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "onboarding.answer.save" } });

  const rl = await checkRateLimit(
    `onboarding-answers:${user.id}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "onboarding.answer.save" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many onboarding writes, try again later", 429, {
      errorCode: "onboarding.answers.rateLimited",
    });
  }

  const { data: body, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = onboardingAnswerSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "onboarding.answer.save" },
      meta: { outcome: "validation_failed" },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "onboarding.answers.invalid",
    });
  }
  const answer = parsed.data;

  const existing = await prisma.onboardingRecord.findUnique({
    where: { userId: user.id },
    select: ONBOARDING_RECORD_SELECT,
  });
  const next = applyOnboardingAnswer(
    readOnboardingRecordState(existing),
    answer,
    new Date(),
  );

  // The unit answers are the one step whose consequence lives outside this
  // table: `User.glucoseUnit` and `User.unitPreference` are what every display
  // surface already reads, so the flow writes them rather than inventing a
  // second source of truth. What is kept beside them in `needs.units` is the
  // answer as given, so a restart can show it back without re-deriving it from
  // a column Settings may have changed since.
  if (answer.step === "units" && answer.status !== "skipped") {
    const data: { glucoseUnit?: string; unitPreference?: string } = {};
    if (answer.units.glucoseUnit) data.glucoseUnit = answer.units.glucoseUnit;
    if (answer.units.unitPreference) {
      data.unitPreference = answer.units.unitPreference;
    }
    if (Object.keys(data).length > 0) {
      await prisma.user.update({ where: { id: user.id }, data });
    }
  }

  const written = await prisma.onboardingRecord.upsert({
    where: { userId: user.id },
    // Field-by-field, never a spread of the parsed body: the three columns are
    // the pure function's output, and nothing the client sent reaches Prisma
    // without passing through it.
    create: {
      userId: user.id,
      needsJson: toJson(next.needs),
      stepsJson: toJson(next.steps),
      firstResultJson: next.firstResult ? toJson(next.firstResult) : undefined,
    },
    update: {
      needsJson: toJson(next.needs),
      stepsJson: toJson(next.steps),
      ...(next.firstResult
        ? { firstResultJson: toJson(next.firstResult) }
        : {}),
    },
    select: ONBOARDING_RECORD_SELECT,
  });

  annotate({
    action: { name: "onboarding.answer.save" },
    meta: {
      step: answer.step,
      status: answer.status === "skipped" ? "skipped" : "done",
    },
  });

  return apiSuccess({ onboarding: toOnboardingStateDto(written) });
});
