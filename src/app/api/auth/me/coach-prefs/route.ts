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
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
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
    select: { coachPrefsJson: true },
  });
  return apiSuccess(parseCoachPrefs(row?.coachPrefsJson));
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(422, "coach-prefs.body.invalid_json");
  }

  const parsed = coachPrefsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.coach-prefs.put.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    throw new HttpError(422, "coach-prefs.body.invalid_shape");
  }

  // Persist the canonical defaulted form so the column shape stays
  // stable regardless of which subset of keys the caller supplied.
  //
  // v1.4.36 W3 T3 — mirror the excludeMetrics list onto the dedicated
  // `insightsExcludeMetrics` column so the Insights generator and
  // Coach snapshot share a single source of truth. Keeps the user's
  // privacy contract symmetric across the two surfaces without
  // requiring a separate Insights settings sheet.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      coachPrefsJson: parsed.data,
      insightsExcludeMetrics: parsed.data.excludeMetrics,
    },
  });

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
  return apiSuccess(parsed.data);
});
