/**
 * `GET /api/timeline?zoom=&from=&to=&values=` — the record laid out over the
 * years (v1.42, #613): lanes of conditions, medications, visits, documents and
 * life events, the standing items without a start, and monthly value series.
 * The shape is `TimelineResponse` in `src/lib/day/contract.ts`.
 *
 * Gated on the opt-in `timeline` module. Contract stub: answers 501 behind
 * its admission and the gate. Like the day, it declares the whole record
 * until each lane is narrowed to the grant's domains.
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
