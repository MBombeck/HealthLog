/**
 * GET    /api/coach/about-me/questions — pending clarifying questions.
 * DELETE /api/coach/about-me/questions — dismiss one (body
 *        `{ question }`) or all (empty body / `{}`).
 *
 * v1.16.0 — the Coach composer renders the pending questions as
 * tappable suggestion chips. Tapping a chip inserts the question into
 * the composer AND dismisses it here; the small ✕ on a chip dismisses
 * without inserting. The questions are user-visible suggestion text
 * only — stored encrypted, scoped to the caller, never interpreted
 * server-side beyond exact-match removal.
 */
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import {
  getPendingQuestionsForUser,
  PENDING_QUESTION_MAX_CHARS,
  setPendingQuestionsForUser,
} from "@/lib/ai/coach/about-me";
import { requireModuleEnabled } from "@/lib/modules/gate";

const dismissSchema = z
  .object({
    /** Exact question text to dismiss. Omitted = dismiss all. */
    question: z.string().max(PENDING_QUESTION_MAX_CHARS).optional(),
  })
  .strict();

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  // v1.18.0 — Coach module gate (operator availability + disableCoach).
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;
  const questions = await getPendingQuestionsForUser(user.id);
  annotate({
    action: { name: "coach.about_me.questions.get" },
    meta: { count: questions.length },
  });
  return apiSuccess({ questions });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  // v1.18.0 — Coach module gate (operator availability + disableCoach).
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(req, dismissSchema, {
    maxBytes: 4 * 1024,
    input: (body) => body ?? {},
  });
  if (!parsed.ok) return parsed.error;

  const current = await getPendingQuestionsForUser(user.id);
  const remaining =
    parsed.data.question === undefined
      ? []
      : current.filter((q) => q !== parsed.data.question);
  await setPendingQuestionsForUser(user.id, remaining);

  annotate({
    action: { name: "coach.about_me.questions.dismissed" },
    meta: { before: current.length, after: remaining.length },
  });

  return apiSuccess({ questions: remaining });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
