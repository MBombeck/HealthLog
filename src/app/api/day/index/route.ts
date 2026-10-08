/**
 * `GET /api/day/index?from=&to=` — which days in a window hold anything, and
 * which of them carry a notable observation (v1.42, #613). Feeds the row of
 * day dots under a chart and the day links in lists; at most
 * `DAY_INDEX_MAX_SPAN_DAYS` days per call. The shape is `DayIndexResponse` in
 * `src/lib/day/contract.ts`.
 *
 * Contract stub: answers 501 behind the same admission as the day itself.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const GET = apiHandler(async () => {
  await requireRecordAuth("read", "record");
  return notImplemented();
});
