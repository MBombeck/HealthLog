/**
 * GET /api/insights/pulse/intraday?date=YYYY-MM-DD
 *
 * The on-demand read for the intraday pulse / tension layer (S11). Returns one
 * local day's 10-minute mean heart-rate shape plus, when every confidence gate
 * holds, a single cautious elevated-at-rest ("tension") window. Computed from
 * raw samples via the read-swap pattern — NOT persisted as 10-min rollups for
 * all history.
 *
 * Cookie OR Bearer auth via `requireAuth()`; `userId` is narrowed from the
 * resolved session — never a body field. Pulse is a core vital, so no module
 * gates it; the `insights` module is the AI analysis opt-out, and this read
 * calls no model. The
 * `date` defaults to the user's local today; anything but a `YYYY-MM-DD`
 * literal is a 422 via `returnAllZodIssues`. The frontend day navigator
 * pages this same route backward through prior days — a day outside
 * `DENSE_INTRADAY_RETENTION_DAYS` (`dense-intraday-retention.ts`) reads back
 * at the coarser hourly grain instead of an empty series; the response's
 * `resolution` field tells the caller which.
 */
import { z } from "zod";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { userDayKey } from "@/lib/tz/format";
import { annotate } from "@/lib/logging/context";
import { loadIntradayPulse } from "@/lib/analytics/intraday-pulse-io";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const GET = apiHandler(async (req: Request) => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined,
  });
  if (!parsed.success) return returnAllZodIssues(parsed.error);

  const timezone = await resolveUserTimezone(user.id);
  const dateKey = parsed.data.date ?? userDayKey(new Date(), timezone);

  const result = await loadIntradayPulse(user.id, timezone, dateKey);

  annotate({
    action: { name: "insights.pulse.intraday" },
    meta: {
      buckets: result.series.length,
      baseline_source: result.baselineSource,
      tension: result.tension !== null,
      resolution: result.resolution,
    },
  });

  return apiSuccess(result);
});
