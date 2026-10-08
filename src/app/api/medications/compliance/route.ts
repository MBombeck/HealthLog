import pLimit from "p-limit";
import { z } from "zod/v4";

import { COURSES_COMPLIANCE_SELECT } from "@/lib/analytics/compliance";
import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccessWithMeta,
  returnAllZodIssues,
} from "@/lib/api-response";
import {
  aggregateCompliance,
  buildCompliancePayload,
  complianceCacheKey,
  type CompliancePayload,
} from "@/lib/medications/compliance-payload";
import { COMPLIANCE_REPORT_DAYS } from "@/lib/analytics/compliance";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * Batched card-compliance read: one round trip for every medication the
 * caller owns, replacing the per-card fan-out over
 * `GET /api/medications/{id}/compliance` (one request per card, ~1 s
 * cold each). The per-medication payload still builds and caches through
 * the SAME `medicationCompliance` cells the per-id route reads, so this
 * read warms the detail page (and vice versa) and both invalidate
 * together on a write.
 *
 * The heavy `dailyCompliance` heatmap map is intentionally NOT on this
 * wire shape — the cards render rates / streak / display block only; the
 * detail page keeps the per-id route for the grid.
 */
/**
 * `?days=N` adds a `complianceN` block per medication and to the account
 * aggregate, for a report that covers its own window rather than the fixed 7
 * and 30 days. Only the windows the ledger serves are accepted; anything else
 * is a 422, never a silently rounded window.
 */
const querySchema = z.object({
  days: z
    .enum(COMPLIANCE_REPORT_DAYS.map(String) as [string, ...string[]])
    .transform(Number)
    .optional(),
});

export const GET = apiHandler(async (request: Request) => {
  const { user, actor } = await requireRecordAuth("read", "medications");

  const query = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) return returnAllZodIssues(query.error, 422);
  const days = query.data.days as
    (typeof COMPLIANCE_REPORT_DAYS)[number] | undefined;

  // v1.36.0 — the bucket keys on the ACTOR while everything below it scopes to
  // the record. Two reasons, and both are the same reason from opposite ends:
  // a delegate hammering this route must burn their own allowance rather than
  // locking the owner out of their own cabinet, and switching records must not
  // hand the same caller a fresh allowance. `user.id` would get both wrong.
  const rl = await checkRateLimit(
    `medication-compliance-summary:${actor.id}`,
    30,
    60_000,
  );
  if (!rl.allowed) {
    return apiError("Too many compliance requests. Please retry later.", 429);
  }

  const userTz = user.timezone || DEFAULT_TIMEZONE;

  // Same ordering as the medications list so the page's card order and
  // this payload walk the same sequence.
  const medications = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications carry no compliance entry:
    // the cards/table render a last-taken presentation for them instead
    // of rates, and an empty expected set must not read as 0% or 100%.
    where: { userId: user.id, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    include: {
      schedules: true,
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      // v1.40 (#1024) — the courses, so a gap between two expects nothing.
      courses: COURSES_COMPLIANCE_SELECT,
    },
    orderBy: { createdAt: "desc" },
  });

  // Bounded fan-out: each cold cell costs one bounded intake read + one
  // band-expansion pass. Three at a time keeps a many-meds account from
  // stampeding the pool while bounding the cold wall-clock — the client
  // reads this through the shared fetch wrapper's 15 s default timeout,
  // and a strictly sequential walk over a large cabinet could outlive it
  // on a cold cache. Warm / stale cells return without touching the
  // database at all; `Promise.all` keeps the response in list order.
  const limit = pLimit(3);
  const results = await Promise.all(
    medications.map((medication) =>
      limit(async () => {
        const payload = await cachedSwr(
          caches.medicationCompliance as ServerCache<CompliancePayload>,
          complianceCacheKey(user.id, medication.id, userTz),
          () => buildCompliancePayload(medication, user.id, userTz),
          annotate,
        );
        return { payload, medicationId: medication.id };
      }),
    ),
  );

  // A cell cached before the report windows existed carries none; it reads
  // as the not-applicable placeholder until its next rebuild rather than
  // failing the whole read.
  const windowFor = (payload: CompliancePayload, n: number) =>
    payload.reportWindows?.[n as keyof CompliancePayload["reportWindows"]];

  const items = results.map(({ payload, medicationId }) => ({
    medicationId,
    applicable: payload.applicable,
    notApplicableReason: payload.notApplicableReason,
    compliance7: payload.compliance7,
    compliance30: payload.compliance30,
    ...(days !== undefined && days !== 30
      ? { [`compliance${days}`]: windowFor(payload, days) ?? null }
      : {}),
    complianceDisplay: payload.complianceDisplay,
  }));

  // The account-wide figure the widget ring and the report show, built only
  // from medications whose adherence means something (`applicable`).
  const applicable = results
    .map((r) => r.payload)
    .filter((payload) => payload.applicable);
  const reportWindow =
    days !== undefined && days !== 30
      ? applicable.map((payload) => windowFor(payload, days))
      : [];
  const aggregate =
    applicable.length === 0
      ? null
      : {
          compliance7: aggregateCompliance(
            applicable.map((p) => p.compliance7),
          ),
          compliance30: aggregateCompliance(
            applicable.map((p) => p.compliance30),
          ),
          ...(days !== undefined && days !== 30
            ? {
                [`compliance${days}`]: reportWindow.every(Boolean)
                  ? aggregateCompliance(
                      reportWindow as NonNullable<
                        (typeof reportWindow)[number]
                      >[],
                    )
                  : null,
              }
            : {}),
          medicationCount: applicable.length,
        };

  annotate({
    action: { name: "medication.compliance_summary.read" },
    meta: { count: items.length, days: days ?? null },
  });

  return apiSuccessWithMeta(items, {
    aggregate,
    ...(days !== undefined ? { days } : {}),
  });
});
