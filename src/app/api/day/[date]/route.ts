/**
 * `GET /api/day/{date}` — one local day across the record (v1.42, #613): what
 * ran through it, the readings in its window, what happened on it, and the
 * few deterministic observations worth a second look. The shape is
 * `DayResponse` in `src/lib/day/contract.ts`.
 *
 * Core, not a module: the day opens for every account. Sections of a
 * switched-off module are left out; a section the caller's grant does not
 * cover is named in `sections` and not read.
 *
 * Contract stub: answers 501 behind its admission. It declares the whole
 * record for now, the posture every cross-section read in the tree has; a
 * scoped grant is refused until the loader narrows each section to the
 * grant's domains and the admission is reviewed for that.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const GET = apiHandler(async () => {
  await requireRecordAuth("read", "record");
  return notImplemented();
});
