import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { prisma, toJson } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  ONBOARDING_GOAL_SLUGS,
  buildGoalSeededDashboardLayout,
} from "@/lib/onboarding/goals";

/**
 * v1.4.25 W14b — POST /api/onboarding/step.
 *
 * Persists the user's progress through the rebuilt
 * `/onboarding/[step]` wizard. Body: `{ step: number }` where `step`
 * is 1..4. The endpoint enforces a strict step-by-step contract:
 *
 *   - Submitted step must equal `current + 1` (no skipping ahead).
 *   - Submitting step 4 marks completion — `onboardingCompletedAt`
 *     flips from null to NOW() in the same write and the
 *     `hl_onboarding` proxy cookie is cleared.
 *   - Already-completed users (`onboardingCompletedAt != null`)
 *     receive a 409. Replays must call this endpoint only while the
 *     wizard is in-progress.
 *
 * Companion to:
 *   - `GET ` not implemented (the User row is already loaded into
 *     every server-rendered step page).
 *   - `POST /api/onboarding/complete` remains the legacy v1.4.20
 *     completion path used by the old single-file wizard; the new
 *     flow uses this endpoint with `step: 4` instead.
 *
 * Rate limit: 30 writes / 10 min / user — generous for a 4-step flow
 * but tight enough to defang a stuck retry loop.
 */

const stepBodySchema = z.object({
  step: z.number().int().min(1).max(4),
  // v1.17.1 — optional goal slugs from the GoalsChipPicker (step 2
  // submit). Validated against the closed slug enum so an unknown slug
  // 422s; deduped + capped at the full set size. Persisted to
  // `User.onboardingGoals` (field-by-field, no mass assignment) and on
  // completion (step 4) seeds the dashboard layout when the user never
  // customized it. Omitted leaves the stored goals untouched.
  goals: z
    .array(z.enum(ONBOARDING_GOAL_SLUGS))
    .max(ONBOARDING_GOAL_SLUGS.length)
    .optional(),
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "onboarding.step" } });

  const rl = await checkRateLimit(
    `onboarding-step:${user.id}`,
    30,
    10 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many onboarding writes, try again later", 429, {
      errorCode: "onboarding.step.rateLimited",
    });
  }

  const { data: body, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = stepBodySchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "validation_failed" },
    });
    return apiError("Invalid step payload", 422, {
      errorCode: "onboarding.step.invalid",
    });
  }
  const { step, goals } = parsed.data;

  // Re-fetch the fresh User row so concurrent step submissions in
  // separate tabs can't race past each other — the session.user
  // snapshot might be a request-old.
  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      onboardingStep: true,
      onboardingCompletedAt: true,
    },
  });
  if (!fresh) {
    return apiError("User not found", 404, {
      errorCode: "onboarding.user.notFound",
    });
  }

  if (fresh.onboardingCompletedAt) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "already_completed" },
    });
    return apiError("Onboarding already completed", 409, {
      errorCode: "onboarding.step.completed",
    });
  }

  const current = fresh.onboardingStep;
  if (step !== current + 1) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "out_of_order", current, requested: step },
    });
    return apiError(`Step out of order — current step is ${current}`, 409, {
      errorCode: "onboarding.step.outOfOrder",
    });
  }

  const completing = step === 4;

  // Conditional update — the WHERE clause re-asserts the
  // precondition we read above so the write can only land on a row
  // whose state still matches what we validated. Two parallel tabs
  // both reading `onboardingStep = 2` and both POSTing `step: 3`
  // would otherwise both succeed (the read-then-write race); with
  // this guard exactly one update sees `count = 1`, the second sees
  // `count = 0` and returns 409. `onboardingCompletedAt: null` also
  // catches a race with `POST /api/onboarding/complete`. Migration
  // 0060 (v1.4.25 W21) backfilled NULL → 0 and flipped the column
  // to NOT NULL, so the legacy null branch this code carried before
  // is dropped — every row now matches the strict-equality form.
  const claimed = await prisma.user.updateMany({
    where: {
      id: user.id,
      onboardingCompletedAt: null,
      onboardingStep: { in: [current] },
    },
    // Field-by-field assembly — no mass assignment. `goals` only
    // lands when the client sent it (the step-2 submit); it is already
    // validated against the closed slug enum by the Zod schema, so the
    // array reaching Prisma can never contain an out-of-set value.
    data: {
      onboardingStep: step,
      ...(completing ? { onboardingCompletedAt: new Date() } : {}),
      ...(goals !== undefined ? { onboardingGoals: goals } : {}),
    },
  });
  if (claimed.count !== 1) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "concurrent_write", current, requested: step },
    });
    return apiError(
      "Onboarding step changed concurrently, refresh and retry",
      409,
      { errorCode: "onboarding.step.concurrent" },
    );
  }
  const updated = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      onboardingStep: true,
      onboardingCompletedAt: true,
    },
  });

  let goalsSeeded = false;
  if (completing) {
    // Mirror /api/onboarding/complete — clear the proxy-readable
    // pending cookie so the next navigation drops the /onboarding
    // redirect immediately.
    await setOnboardingPendingCookie(false);

    // v1.17.1 — seed the dashboard from the stored goal selection.
    // ONE-TIME, gated on `dashboardWidgetsJson == null` so a user who
    // already arranged tiles is never clobbered. The seed promotes the
    // goal-mapped tiles to the top and forces them visible; an empty /
    // general-wellness-only selection produces null and leaves the
    // column untouched (default layout). The resulting layout is what
    // both the web dashboard and the iOS widgets contract read —
    // server-authoritative, no client recompute.
    const seedRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { onboardingGoals: true, dashboardWidgetsJson: true },
    });
    if (seedRow && seedRow.dashboardWidgetsJson == null) {
      const seededLayout = buildGoalSeededDashboardLayout(
        seedRow.onboardingGoals,
      );
      if (seededLayout) {
        // updateMany so the `dashboardWidgetsJson: null` precondition
        // rides in the WHERE clause — a concurrent Settings → Dashboard
        // save that lands first leaves `count = 0` and the seed is
        // skipped rather than overwriting the user's fresh layout.
        const seeded = await prisma.user.updateMany({
          where: {
            id: user.id,
            dashboardWidgetsJson: { equals: Prisma.JsonNull },
          },
          data: { dashboardWidgetsJson: toJson(seededLayout) },
        });
        goalsSeeded = seeded.count === 1;
      }
    }
  }

  await auditLog("onboarding.step", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      step,
      completed: completing,
    },
  });

  annotate({
    action: { name: "onboarding.step" },
    meta: {
      outcome: completing ? "completed" : "advanced",
      step,
      ...(goals !== undefined ? { goals_count: goals.length } : {}),
      ...(completing ? { goals_seeded: goalsSeeded } : {}),
    },
  });

  return apiSuccess({
    step: updated.onboardingStep,
    onboardingCompletedAt: updated.onboardingCompletedAt,
  });
});
