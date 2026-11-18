/**
 * v1.40 — GET /api/ai-runs/{id}: where one background document AI run stands.
 *
 * A plain read of a row the caller queued: the run id came back in the 202
 * of the route that queued it, and the row is scoped to the record here (the
 * caller's own, or the managed profile a guardian is inside, #1403 — the same
 * people who may queue one), so another account's run (or one that never
 * existed, or one an hour past its end) is the same 404. No AI gate: serving the answer to a read the person
 * already asked for calls no model, and every capability question was asked
 * when the run was queued and again in the worker before anything left.
 *
 * `result` is the body the synchronous route answers with (by `kind`), and
 * `error` carries the code and status it would have answered with, so a
 * client handles both paths through one table.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { readAiRunForUser } from "@/lib/documents/ai-runs/store";
import { AI_RUN_ERROR_CODES } from "@/lib/documents/ai-runs/types";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("guardian", "documents");
    const { id } = await params;
    const run = await readAiRunForUser(user.id, id);
    if (!run) {
      return apiError("Run not found", 404, {
        errorCode: AI_RUN_ERROR_CODES.notFound,
      });
    }
    const response = apiSuccess(run);
    // A poll answer is for one person at one instant.
    response.headers.set("Cache-Control", "no-store");
    if (run.retryAfterMs !== null) {
      response.headers.set(
        "Retry-After",
        String(Math.max(1, Math.ceil(run.retryAfterMs / 1000))),
      );
    }
    return response;
  },
);
