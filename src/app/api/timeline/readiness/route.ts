/**
 * `GET /api/timeline/readiness` — what the timeline can already show, lane by
 * lane, with one link per gap (v1.42, #613). Counts and keys, never a score.
 * The shape is `TimelineReadinessResponse` in `src/lib/day/contract.ts`.
 *
 * Gated on the opt-in `timeline` module. Contract stub: answers 501 behind
 * its admission and the gate.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "record");
  const gate = await requireModuleEnabled(user.id, "timeline");
  if (!gate.enabled) return gate.response;
  return notImplemented();
});
