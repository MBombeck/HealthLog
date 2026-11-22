/**
 * GET /api/medications/resolved-slots?from=&to=
 *   → every scheduled dose of the record's active medications over the
 *     window, per medication, each with its resolved state.
 *
 * One request for what the native client read one medication at a time from
 * `GET /api/medications/{id}/dose-history`, to plan the reminders of
 * medications that do not run daily. The slots and states come from the same
 * dose ledger and resolver as the history and the today list
 * (`dose-state/resolved-slots.ts`); the statement count does not grow with
 * the number of medications.
 *
 * Auth, scope, rate limit and caching follow `dose-history`: a read over the
 * `medications` section of the record the request resolves (a delegate or a
 * guardian reads the owner's), 60 requests a minute per actor, no server
 * cache. The window is at most 14 days; without one it is two days back to
 * eight days ahead.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { isoDateTime } from "@/lib/validations/datetime";
import {
  readResolvedSlots,
  RESOLVED_SLOTS_MAX_DAYS,
} from "@/lib/medications/dose-state/resolved-slots";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACK_MS = 2 * DAY_MS;
const DEFAULT_AHEAD_MS = 8 * DAY_MS;

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

const querySchema = z
  .object({
    from: isoDateTime()
      .transform((s) => new Date(s))
      .optional(),
    to: isoDateTime()
      .transform((s) => new Date(s))
      .optional(),
  })
  .refine((q) => !q.from || !q.to || q.to.getTime() >= q.from.getTime(), {
    message: "`to` must be on or after `from`",
    path: ["to"],
  })
  .refine(
    (q) =>
      !q.from ||
      !q.to ||
      q.to.getTime() - q.from.getTime() <= RESOLVED_SLOTS_MAX_DAYS * DAY_MS,
    {
      message: `The window may span at most ${RESOLVED_SLOTS_MAX_DAYS} days`,
      path: ["to"],
    },
  );

/** The window: as named, or around now; one bound alone keeps 10 days. */
function windowOf(q: { from?: Date; to?: Date }, now: Date) {
  const span = DEFAULT_BACK_MS + DEFAULT_AHEAD_MS;
  if (q.from && q.to) return { from: q.from, to: q.to };
  if (q.from) return { from: q.from, to: new Date(q.from.getTime() + span) };
  if (q.to) return { from: new Date(q.to.getTime() - span), to: q.to };
  return {
    from: new Date(now.getTime() - DEFAULT_BACK_MS),
    to: new Date(now.getTime() + DEFAULT_AHEAD_MS),
  };
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, actor } = await requireRecordAuth("read", "medications");

  const rl = await checkRateLimit(
    `medication-resolved-slots:${actor.id}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many requests", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const now = new Date();
  const { from, to } = windowOf(parsed.data, now);
  const medications = await readResolvedSlots({
    userId: user.id,
    userTz: user.timezone || DEFAULT_TIMEZONE,
    from,
    to,
    now,
  });

  annotate({
    action: { name: "medication.resolved_slots" },
    meta: {
      medication_count: medications.length,
      slot_count: medications.reduce((n, m) => n + m.slots.length, 0),
    },
  });

  return apiSuccess({
    from: from.toISOString(),
    to: to.toISOString(),
    medications,
  });
});
