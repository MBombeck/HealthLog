/**
 * `POST /api/medications/intake/bulk` — iOS SyncMode bulk backfill
 * for medication intake events.
 *
 * Mirrors the mood-entries bulk endpoint shape so the iOS sync
 * engine reuses the same retry / cursor plumbing for both.
 *
 * Body:
 *   { entries: BulkIntakeEntry[] }    — capped at 500 per call.
 *
 * Each entry:
 *   {
 *     medicationId,          — required (existing Medication row)
 *     scheduledFor,          — ISO timestamp (offset); defaults to now()
 *     takenAt?,              — ISO timestamp; omit + skipped=false = pending
 *     skipped?,              — boolean; default false
 *     idempotencyKey?,       — Medication.intake_events.idempotency_key
 *                              (existing UNIQUE column; serves as the
 *                              per-entry dedup hint)
 *   }
 *
 * Response (always 200): processed / inserted / duplicates / skipped /
 * entries[] mirroring the measurements + workouts batch envelope.
 *
 * Locked contract — see `.planning/v15-ios-handoff/06-ios-responsibilities.md`
 * §"Cumulative metrics" sibling section for the SyncMode rationale.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_ENTRIES_PER_BATCH = 500;
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkEntrySchema = z.object({
  medicationId: z.string().min(1),
  scheduledFor: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  skipped: z.boolean().optional().default(false),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const bulkPayloadSchema = z.object({
  entries: z.array(bulkEntrySchema).min(1).max(MAX_ENTRIES_PER_BATCH),
});

type EntryStatus = "inserted" | "duplicate" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `medications:intake:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "medications.intake.bulk.too_large" },
    );
  }

  const parsed = bulkPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422, {
      errorCode: "medications.intake.bulk.invalid",
    });
  }

  const { entries } = parsed.data;

  // Up-front ownership check — the user can only POST intake events
  // against medications they own. One read covers every medicationId
  // in the batch.
  const medicationIds = Array.from(new Set(entries.map((e) => e.medicationId)));
  const ownedMedications = await prisma.medication.findMany({
    where: { id: { in: medicationIds }, userId: user.id },
    select: { id: true },
  });
  const ownedSet = new Set(ownedMedications.map((m) => m.id));

  const results: EntryResult[] = [];
  let inserted = 0;
  let duplicates = 0;
  const skipped: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (!ownedSet.has(entry.medicationId)) {
      const reason = "medication_not_found";
      skipped.push({ index: i, reason });
      results.push({ index: i, status: "skipped", reason });
      continue;
    }

    try {
      const scheduledFor = entry.scheduledFor ?? new Date();
      // The idempotencyKey, when supplied, has a UNIQUE index. A
      // re-submission of the same key returns the existing row via
      // P2002 → status: "duplicate".
      const row = await prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: entry.medicationId,
          scheduledFor,
          takenAt: entry.takenAt ?? null,
          skipped: entry.skipped,
          source: "API",
          idempotencyKey: entry.idempotencyKey ?? null,
        },
      });
      inserted += 1;
      results.push({ index: i, status: "inserted", id: row.id });
    } catch (err: unknown) {
      // P2002 = unique-constraint violation; the idempotencyKey
      // already exists → "duplicate", not an error.
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        const existing = entry.idempotencyKey
          ? await prisma.medicationIntakeEvent.findUnique({
              where: { idempotencyKey: entry.idempotencyKey },
              select: { id: true },
            })
          : null;
        duplicates += 1;
        results.push({
          index: i,
          status: "duplicate",
          id: existing?.id,
        });
        continue;
      }
      const reason =
        err instanceof Error ? err.message.slice(0, 120) : "create_failed";
      skipped.push({ index: i, reason });
      results.push({ index: i, status: "skipped", reason });
    }
  }

  await auditLog("medications.intake.bulk.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
    },
  });

  annotate({
    action: { name: "medications.intake.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
    },
  });

  return apiSuccess({
    processed: entries.length,
    inserted,
    duplicates,
    skipped,
    entries: results,
  });
}
