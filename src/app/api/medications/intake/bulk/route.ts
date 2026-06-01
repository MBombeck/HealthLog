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
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  recomputeMedicationComplianceForDay,
  dayKeyForScheduledFor,
} from "@/lib/rollups/medication-compliance-rollups";
import {
  applyCanonicalSlotWrite,
  resolveSlotInstantForWrite,
} from "@/lib/medications/scheduling/slot-upsert";

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

// v1.8.2 — `updated` joins the per-entry status vocabulary: a write that
// snaps onto an existing scheduled-slot row (e.g. the pending REMINDER
// row) updates it in place rather than inserting. The iOS sync engine
// treats `updated` the same as `inserted` for cursor advancement — both
// mean "the server accepted this entry and produced a row id".
type EntryStatus = "inserted" | "updated" | "duplicate" | "skipped";
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
    // v1.4.43 W6 — bulk intake ingest; preserve the existing
    // `medications.intake.bulk.invalid` errorCode meta so the iOS
    // Sync engine's retry classifier still branches on it. Audit
    // breadcrumb keyed `medications.intake.bulk.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.bulk.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "medications.intake.bulk.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
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
  let updated = 0;
  let duplicates = 0;
  const skipped: Array<{ index: number; reason: string }> = [];
  // v1.4.39 W-MED — collect distinct `(medicationId, dayKey)` pairs
  // touched by the batch so one rollup recompute fires per pair after
  // all inserts complete. Per-row recompute would balloon a 500-entry
  // batch into 500 sequential rollup hits.
  const touchedDays = new Map<string, { medicationId: string; dayKey: string }>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (!ownedSet.has(entry.medicationId)) {
      const reason = "medication_not_found";
      skipped.push({ index: i, reason });
      results.push({ index: i, status: "skipped", reason });
      continue;
    }

    try {
      const incomingScheduledFor =
        entry.scheduledFor ?? entry.takenAt ?? new Date();

      // v1.8.2 — source-agnostic slot snap. iOS posts the "Genommen"
      // reminder action here (source API); without this it inserted a
      // SECOND row for a slot already carrying the projector/worker's
      // pending REMINDER row (the unique key includes `source`, and the
      // iOS-vs-server `scheduledFor` drifts by a minute). Snap onto the
      // canonical slot instant and update the existing row in place.
      const canonicalSlot = await resolveSlotInstantForWrite({
        userId: user.id,
        medicationId: entry.medicationId,
        userTz: user.timezone,
        incoming: incomingScheduledFor,
      });

      const scheduledFor = canonicalSlot ?? incomingScheduledFor;

      // C2 — classify the incoming write. An offline-sync replay echoes a
      // PENDING projection (no `takenAt`, `skipped:false`) for a slot the
      // user may already have actioned; that echo must NEVER clear a
      // recorded `takenAt`. An explicit `takenAt` or `skipped:true` is a
      // real user action and applies last-write-wins.
      const isExplicitTaken = !entry.skipped && entry.takenAt !== undefined;
      const isExplicitSkip = entry.skipped === true;

      if (canonicalSlot) {
        // Scheduled dose — converge onto the one canonical slot row through
        // the shared upsert: H1 deterministic selection, C2 no-downgrade
        // guard, and a C1 race-safe create that re-finds + updates on a
        // P2002 collision rather than misclassifying it as a duplicate and
        // dropping the dose.
        const applied = await applyCanonicalSlotWrite({
          client: prisma,
          userId: user.id,
          medicationId: entry.medicationId,
          canonicalSlot,
          takenAt: entry.takenAt ?? null,
          skipped: entry.skipped,
          isExplicitTaken,
          isExplicitSkip,
          idempotencyKey: entry.idempotencyKey ?? null,
          createSource: "API",
        });
        if (applied.noDowngradeNoOp) {
          // C2 — pending echo onto an already-actioned slot. Report it as a
          // duplicate so the iOS cursor advances WITHOUT downgrading the
          // recorded dose.
          duplicates += 1;
          results.push({ index: i, status: "duplicate", id: applied.row.id });
        } else if (applied.outcome === "updated") {
          updated += 1;
          results.push({ index: i, status: "updated", id: applied.row.id });
        } else {
          inserted += 1;
          results.push({ index: i, status: "inserted", id: applied.row.id });
        }
      } else {
        // Unscheduled / PRN — insert. The idempotencyKey, when supplied,
        // has a UNIQUE index; a re-submission returns the existing row via
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
      }
      const dayKey = dayKeyForScheduledFor(scheduledFor, user.timezone);
      touchedDays.set(`${entry.medicationId}|${dayKey}`, {
        medicationId: entry.medicationId,
        dayKey,
      });
    } catch (err: unknown) {
      // P2002 = unique-constraint violation. Two shapes reach here:
      //   1. an idempotencyKey collision on the unscheduled/PRN insert →
      //      "duplicate" (the canonical-slot path already absorbs its own
      //      same-slot P2002 race inside `applyCanonicalSlotWrite`);
      //   2. a same-slot collision on the unscheduled insert. In both
      //      cases we surface the existing row id so the cursor advances.
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
      updated,
      duplicates,
      skipped: skipped.length,
    },
  });

  annotate({
    action: { name: "medications.intake.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      updated,
      duplicates,
      skipped: skipped.length,
    },
  });

  // v1.4.34 IW-G — bust per-user medications + compliance + achievement
  // caches when at least one row landed so the next read reflects the
  // ingested batch.
  if (inserted > 0 || updated > 0) {
    invalidateUserMedications(user.id);
  }

  // v1.4.39 W-MED — refresh one rollup row per distinct
  // `(medicationId, dayKey)` touched by the batch. Best-effort: failures
  // are swallowed by the helper's `recomputeMedicationComplianceForEvent`
  // wrapper, but bulk callers wrap recompute directly to keep the
  // tight ingest loop unaffected by populator issues.
  for (const { medicationId, dayKey } of touchedDays.values()) {
    try {
      await recomputeMedicationComplianceForDay(
        user.id,
        medicationId,
        dayKey,
        user.timezone,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      annotate({
        meta: {
          medication_compliance_rollup_bulk_failed: true,
          medication_compliance_rollup_bulk_error: message,
          medication_compliance_rollup_medication: medicationId,
          medication_compliance_rollup_day: dayKey,
        },
      });
    }
  }

  return apiSuccess({
    processed: entries.length,
    inserted,
    updated,
    duplicates,
    skipped,
    entries: results,
  });
}
