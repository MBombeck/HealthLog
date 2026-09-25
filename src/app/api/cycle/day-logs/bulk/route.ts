/**
 * `POST /api/cycle/day-logs/bulk` — Outbox / HealthKit drain
 * (ios-contract §2.B / §3).
 *
 * The route iOS's Outbox flushes to. Per-entry UPSERT keyed on the
 * NULL-distinct `(userId, source, externalId)` (or `(userId, date)`
 * when no externalId). Capped at 500, wrapped in `withIdempotency`,
 * rate-limited `cycle:day-logs:bulk:{userId}` 60/min. Always 200; each
 * entry carries `{ index, status, id?, externalId?, reason? }` where
 * status is `inserted` | `duplicate` | `updated` | `skipped`. `updated`
 * = an externalId re-post that changed a field; `duplicate` = an
 * unchanged re-post.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import {
  cycleBulkSchema,
  MAX_CYCLE_BULK_ENTRIES,
} from "@/lib/validations/cycle";
import {
  classifyExternalId,
  unstableExternalIdMeta,
  UNSTABLE_EXTERNAL_ID_REASON,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";

const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

type EntryStatus = "inserted" | "duplicate" | "updated" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  id?: string;
  externalId?: string;
  reason?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `cycle:day-logs:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 2 * 1024 * 1024,
  });
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_CYCLE_BULK_ENTRIES
  ) {
    return apiError(
      `Batch exceeds the ${MAX_CYCLE_BULK_ENTRIES}-entry limit`,
      422,
      { errorCode: "cycle.bulk.too_large" },
    );
  }

  const parsed = cycleBulkSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "cycle.bulk.validation-failed" },
      meta: { issue_count: sanitiseZodIssues(parsed.error.issues).length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle.bulk.invalid",
    });
  }

  const { entries } = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  // Hoist cycle attribution + the invariant encryption flag out of the loop:
  // load the user's cycle start dates once and resolve the owning span in
  // memory (latest start <= date), instead of a findOwningCycleId query per
  // entry (up to 500) + a profile read per entry (QA M-3 / round-1 N+1).
  const cycleRows = await prisma.menstrualCycle.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: { startDate: "asc" },
    select: { id: true, startDate: true },
  });
  const owningCycleId = (date: string): string | null => {
    let id: string | null = null;
    for (const c of cycleRows) {
      if (c.startDate <= date) id = c.id;
      else break;
    }
    return id;
  };
  const encryptSensitive = gate.profile.sensitiveCategoryEncryption;

  const results: EntryResult[] = [];
  let inserted = 0;
  let updated = 0;
  let duplicates = 0;
  let skipped = 0;
  const unstableShapes: UnstableExternalIdShape[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // The `(userId, source, externalId)` upsert key is only idempotent
    // while the id is STABLE across client launches. An id that rotates
    // per process (an object description carrying a memory address)
    // never matches its own earlier row, so every re-post mints another
    // day log. Refused per entry — one bad row must not stop the rest of
    // the batch landing.
    const unstable =
      entry.externalId === undefined
        ? null
        : classifyExternalId(entry.externalId);
    if (unstable) {
      unstableShapes.push(unstable);
      skipped += 1;
      results.push({
        index: i,
        status: "skipped",
        reason: UNSTABLE_EXTERNAL_ID_REASON,
        externalId: entry.externalId,
      });
      continue;
    }

    try {
      const cycleId = owningCycleId(entry.date);
      const r = await upsertCycleDayLog(
        user.id,
        entry,
        tz,
        cycleId,
        encryptSensitive,
      );

      let status: EntryStatus;
      if (!r.existed) {
        status = "inserted";
        inserted += 1;
      } else if (r.changed) {
        status = "updated";
        updated += 1;
      } else {
        status = "duplicate";
        duplicates += 1;
      }

      results.push({
        index: i,
        status,
        id: r.id,
        ...(entry.externalId ? { externalId: entry.externalId } : {}),
      });
    } catch (err: unknown) {
      // Map to a stable closed set of reason codes — never echo the raw
      // driver message (it can carry column / constraint / value fragments).
      // `annotate` meta is NOT run through the central redactor (only
      // setError/setHttp are), so the raw message must not be attached here:
      // record the stable code + the Prisma error code only (QA M-sec1).
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      const reason =
        code === "P2002"
          ? "constraint"
          : code === "P2003"
            ? "constraint"
            : "upsert_failed";
      annotate({
        action: { name: "cycle.bulk.entry-failed" },
        meta: {
          index: i,
          reason,
          error_code: typeof code === "string" ? code : "unknown",
        },
      });
      skipped += 1;
      results.push({
        index: i,
        status: "skipped",
        reason,
        ...(entry.externalId ? { externalId: entry.externalId } : {}),
      });
    }
  }

  await auditLog("cycle.bulk.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted,
      updated,
      duplicates,
      skipped,
    },
  });

  // Landed rows change the cycle context the cached analytics / snapshot /
  // digest cells carry — evict the analytics bucket.
  if (inserted > 0 || updated > 0) {
    invalidateUserHealthContext(user.id);
  }

  annotate({
    action: { name: "cycle.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      updated,
      duplicates,
      skipped,
      ...(unstableShapes.length > 0
        ? unstableExternalIdMeta("cycle.day_log.bulk", unstableShapes)
        : {}),
    },
  });

  const response = apiSuccess({
    processed: entries.length,
    inserted,
    updated,
    duplicates,
    skipped,
    entries: results,
  });
  // `upsert_failed` is a write that did not happen, not a verdict on the
  // entry, and the client sends it again. `no-store` keeps the idempotency
  // layer from caching this answer, so a retry under the same key writes
  // instead of replaying the failure.
  if (results.some((r) => r.reason === "upsert_failed")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
