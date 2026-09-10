/**
 * `POST /api/cycle/day-logs` — single cycle day-log capture
 * (ios-contract §2.A).
 *
 * Upserts on `(userId, source, externalId)` when an `externalId` is
 * present (the cross-device dedup key), else the canonical `(userId,
 * date)` key. `note` is encrypted at rest (`notesEncrypted`); the intent
 * fields stay queryable plaintext (they feed the rollup / correlation
 * tier). Returns the full `CycleDayLogDTO`: 201 on insert, 200 on update.
 *
 * Gated: a disabled / non-FEMALE-without-opt-in account 403s with
 * `errorCode:"cycle.disabled"` even with a valid Bearer token.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import { withIdempotency } from "@/lib/idempotency";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import {
  cycleDayLogCreateSchema,
  cycleDayLogQuerySchema,
} from "@/lib/validations/cycle";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import { findOwningCycleId } from "@/lib/cycle/cycle-attribution";
import { toCycleDayLogDTO, dayLogSymptomInclude } from "@/lib/cycle/dto";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";

export const POST = apiHandler(withIdempotency<[NextRequest]>(postDayLog));

/**
 * `GET /api/cycle/day-logs?date=YYYY-MM-DD` — the full `CycleDayLogDTO`
 * for one tz-anchored day, or `null` when nothing is logged. Lets the
 * log-day sheet pre-fill (no blank-sheet data loss) and Delete resolve the
 * row id. Gated + owner-scoped + `deletedAt:null`.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const parsed = cycleDayLogQuerySchema.safeParse({
    date: new URL(request.url).searchParams.get("date"),
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle.day-log.invalid",
    });
  }

  const row = await prisma.cycleDayLog.findFirst({
    where: { userId: user.id, date: parsed.data.date, deletedAt: null },
    include: dayLogSymptomInclude,
  });

  annotate({
    action: { name: "cycle.day-log.read", entity_type: "cycle_day_log" },
    meta: { found: row !== null },
  });

  return apiSuccess(row ? toCycleDayLogDTO(row) : null);
});

/**
 * The day-log fields a write actually carried, for the audit row. Names only:
 * every one of these is either intimate or encrypted at rest, and the audit
 * table is not a second store for either.
 */
function replacedDayLogFields(entry: Record<string, unknown>): string[] {
  const carried = ["date", "source", "externalId", "loggedAt"];
  return Object.entries(entry)
    .filter(([key, value]) => value !== undefined && !carried.includes(key))
    .map(([key]) => key)
    .sort();
}

async function postDayLog(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. The upsert replaces the day, which is what edit means
  // here; the gate below resolves `user.gender` against the RECORD, so the
  // module follows the record rather than the caller.
  const { user, actor } = await requireRecordAuth("manage", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = cycleDayLogCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    const shape = unstableExternalIdShape(rawBody);
    annotate({
      action: { name: "cycle.day-log.validation-failed" },
      meta: {
        issue_count: parsed.error.issues.length,
        ...(shape
          ? unstableExternalIdMeta("cycle.day_log.create", [shape])
          : {}),
      },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle.day-log.invalid",
    });
  }

  const entry = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  const cycleId = await findOwningCycleId(user.id, entry.date);
  let result;
  try {
    result = await upsertCycleDayLog(user.id, entry, tz, cycleId);
  } catch (err: unknown) {
    // A residual unique-constraint collision (the helper adopts the
    // canonical row on the common case) surfaces as a clean 409, never a
    // 500 (the MoodEntry conflict precedent).
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      annotate({
        action: { name: "cycle.day-log.conflict" },
        meta: { date: entry.date },
      });
      return apiError("Day-log already exists for this date", 409, {
        errorCode: "cycle.day-log.conflict",
      });
    }
    throw err;
  }

  const row = await prisma.cycleDayLog.findUniqueOrThrow({
    where: { id: result.id },
    include: dayLogSymptomInclude,
  });

  await auditLog("cycle.day-log.upsert", {
    userId: user.id,
    ipAddress: getClientIp(request),
    // C4 in this domain's shape: the date and the fields the write replaced,
    // named and never valued. This is the product's most sensitive domain and
    // §7.5's "no full-row snapshots" is at its sharpest here — a feed line
    // saying which day was rewritten is the whole requirement, and the values
    // behind it stay on the row where they are already encrypted.
    details: {
      dayLogId: result.id,
      existed: result.existed,
      date: entry.date,
      ...overwriteDetails({
        before: {},
        after: {},
        redacted: result.existed ? replacedDayLogFields(entry) : [],
      }),
    },
  });

  // A day-log write changes the cycle context the cached analytics /
  // snapshot / digest cells carry — evict the analytics bucket.
  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "cycle.day-log.upsert",
      entity_type: "cycle_day_log",
      entity_id: result.id,
    },
    meta: { existed: result.existed, source: entry.source },
  });

  return apiSuccess(toCycleDayLogDTO(row), result.existed ? 200 : 201);
}
