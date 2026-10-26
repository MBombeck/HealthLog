/**
 * `GET /api/workouts/{id}` — single-workout detail.
 *
 * v1.4.32 — paired with `GET /api/workouts` so the iOS workout-detail
 * screen + the new `/insights/workouts/[id]` web page consume one
 * canonical envelope per workout. The endpoint:
 *
 *   - Returns the canonical row when the requested id wins its
 *     duplicate cluster against the user's source-priority ladder. The
 *     cluster is resolved through the same windowed read the list uses
 *     (`src/lib/workouts/canonical-read.ts`), so the dedup contract
 *     stays in sync with the list endpoint.
 *   - When the requested id is a non-canonical twin (e.g. the user
 *     opened a deep-link to a Withings row but the cluster's winner is
 *     Apple Health), the response still resolves the requested row
 *     directly and exposes `canonicalId` pointing at the cluster
 *     winner. The web detail page can redirect via that field; the iOS
 *     client may surface it inline.
 *   - Loads the optional `WorkoutRoute` GeoJSON LineString when
 *     present. Absent for Withings-sourced workouts (Withings ships no
 *     route geometry); absent for manual entries.
 *   - Ownership-gated: a row owned by another user resolves as 404 so
 *     the existence channel never leaks.
 *
 * `DELETE /api/workouts/{id}` removes a workout entered by hand. Only a
 * `MANUAL` row: a synced workout would come back with the next sync, so
 * deleting it here would be a promise the record cannot keep. See the
 * handler below.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { readWorkoutDetail } from "@/lib/workouts/detail";
import { deleteManualWorkout } from "@/lib/workouts/delete-manual-workout";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;
    // Web always sends `compact=1` to drop the raw 30k-sample / route
    // timestamp blobs. Absent the param the response is byte-identical to
    // the v1.4.32 contract → iOS is untouched, no coordination ticket.
    const compact = request.nextUrl.searchParams.get("compact") === "1";

    annotate({ action: { name: "workouts.detail" }, meta: { workoutId: id } });

    // v1.18.0 — gate the detail surface behind the workouts module.
    const gate = await requireModuleEnabled(user.id, "workouts");
    if (!gate.enabled) return gate.response;
    // The stored Activity Insight paragraph is model text: it is read and
    // served only while `workoutInsights` is available (operator switch, the
    // AI analysis opt-out, provider presence, consent). Otherwise the row is
    // not even loaded, `aiInsight` is null, and `ai` says why.
    const ai = await aiCapabilityToServe(user.id, "workoutInsights");

    const body = await readWorkoutDetail({
      userId: user.id,
      id,
      compact,
      ai,
    });
    // Cross-user 404 guard. The user can only fetch rows they own; any
    // other id surfaces as "not found" so the existence channel stays
    // sealed.
    if (!body) {
      return apiError("Workout not found", 404);
    }
    return apiSuccess(body);
  },
);

/**
 * `DELETE /api/workouts/{id}` — remove a workout that was entered by hand.
 *
 * - Own record only: `requireAuth()` with no scope admits a cookie session or
 *   a wildcard token and refuses an acting-account carrier, the same arm the
 *   detail read above uses. A narrow token is refused.
 * - Ownership: another user's row answers 404, like the read.
 * - `MANUAL` only. Every other source is a sync, and the next sync would
 *   write the row back, so it answers 409 instead of pretending.
 * - Not module-gated: deleting is cleanup of the person's own rows, which
 *   the data layer allows whatever the module says
 *   (`module-route-gate-inventory.test.ts`).
 *
 * The workout table carries no tombstone, so the row is removed outright;
 * route, samples and insight rows cascade with it. The insight's generation
 * claim stays behind with a null workout id: it is the day's cap ledger, and
 * a delete must not hand the slot back. A personal record
 * the workout set would otherwise outlive it (the detector only ever raises
 * a stored best), so the records keyed on this workout go in the same
 * transaction and a silent detection pass re-derives the honest best.
 */
export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const outcome = await deleteManualWorkout({
      userId: user.id,
      id,
      ipAddress: getClientIp(request),
    });
    if (outcome.kind === "not_found") {
      return apiError("Workout not found", 404);
    }
    if (outcome.kind === "synced_source") {
      return apiError(
        "Only a workout entered by hand can be deleted here",
        409,
        { errorCode: "workout.delete.synced_source" },
      );
    }
    return apiSuccess({ deleted: true });
  },
);
