/**
 * v1.4.23 H4 — per-user Coach prompt-tuning preferences.
 *
 *  GET  /api/auth/me/coach-prefs  — returns the parsed prefs (defaults
 *                                   when the row is null).
 *  PUT  /api/auth/me/coach-prefs  — replaces the persisted prefs with
 *                                   the supplied shape; the body is
 *                                   validated against
 *                                   `coachPrefsSchema` and persisted as
 *                                   the canonical defaulted form so a
 *                                   future schema migration doesn't
 *                                   need to back-fill missing keys.
 *
 * Bearer-auth + cookie-auth both work via the shared `requireAuth()`
 * helper. The Coach prompt builder + snapshot builder both read this
 * row on every turn — there's no caching layer to invalidate.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import {
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import {
  coachPrefsSchema,
  parseCoachPrefs,
} from "@/lib/validations/coach-prefs";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.coach-prefs.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { coachPrefsJson: true, updatedAt: true },
  });
  const prefs = parseCoachPrefs(row?.coachPrefsJson);
  // v1.32.22 (M4) — a never-saved user gets the PURE default with NO token
  // (mirrors the insights-layout never-saved GET). There is nothing to guard
  // against yet, and the first save is just the tokenless unconditional write.
  // A saved row carries `updatedAt` (additive sibling key; the prefs shape is a
  // fixed key set, so it cannot collide) so the client can echo it.
  if (row?.coachPrefsJson == null) {
    return apiSuccess(prefs);
  }
  return apiSuccess({ ...prefs, updatedAt: row.updatedAt?.toISOString() });
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400, {
      errorCode: "coach-prefs.body.invalid_json",
    });
  }

  // v1.32.22 (M4) — pull the optimistic-concurrency base token off before the
  // parse. This is a full-replace endpoint, so the classic two-tab / two-device
  // stale-replace clobbers silently: the form was hydrated from a GET minutes
  // ago. The token closes that window.
  const taken = takeBaseToken(body ?? {});
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;

  const parsed = coachPrefsSchema.safeParse(taken.rest ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.coach-prefs.put.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    // The dotted token keeps its place in `error` — clients already match on it
    // there — while `meta.errorCode` publishes it in the field a machine code
    // belongs in, and `details.issues` names the fields that were refused.
    return apiValidationError(
      "coach-prefs.body.invalid_shape",
      sanitiseZodIssues(parsed.error.issues),
      422,
      { errorCode: "coach-prefs.body.invalid_shape" },
    );
  }

  // Persist the canonical defaulted form so the column shape stays
  // stable regardless of which subset of keys the caller supplied.
  //
  // v1.4.36 W3 T3 — mirror the excludeMetrics list onto the dedicated
  // `insightsExcludeMetrics` column so the Insights generator and
  // Coach snapshot share a single source of truth. Keeps the user's
  // privacy contract symmetric across the two surfaces without
  // requiring a separate Insights settings sheet.
  // v1.32.22 (M4) — the guarded write covers BOTH columns in one conditional
  // update so the mirror-column contract (v1.4.36 W3 T3) stays unsplittable: a
  // 409 leaves `coachPrefsJson` AND `insightsExcludeMetrics` untouched together.
  const guarded = await guardedUserUpdate({
    userId: user.id,
    base,
    data: {
      coachPrefsJson: parsed.data,
      insightsExcludeMetrics: parsed.data.excludeMetrics,
    },
    conflict: {
      action: "auth.me.coach-prefs.conflict",
      errorCode: "coach_prefs_conflict",
      message: "Coach preferences changed since they were loaded",
    },
  });
  if ("conflict" in guarded) return guarded.conflict;

  annotate({
    action: { name: "auth.me.coach-prefs.put" },
    meta: {
      tone: parsed.data.tone,
      verbosity: parsed.data.verbosity,
      excludeCount: parsed.data.excludeMetrics.length,
      showEvidence: parsed.data.showEvidenceByDefault,
      // v1.7.0 — `null` when the caller left `dataClusters` absent
      // (legacy defaults stay in force); otherwise the selected count.
      clusterCount: parsed.data.dataClusters?.length ?? null,
    },
  });
  return apiSuccess({ ...parsed.data, updatedAt: guarded.updatedAt });
});
