import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  intakeSchema,
  listIntakeEventsSchema,
} from "@/lib/validations/medication";
import { withIdempotency } from "@/lib/idempotency";
import { consumeOneDose } from "@/lib/medications/inventory/service";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import {
  applyCanonicalSlotWrite,
  resolveSlotInstantForWrite,
} from "@/lib/medications/scheduling/slot-upsert";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postIntake),
);

async function postIntake(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuth();

  const { id } = await params;
  // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
  const guard = await assertMedicationOwnership(id, user.id);
  if (guard) return guard;

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = intakeSchema.safeParse({
    ...(body as Record<string, unknown>),
    medicationId: id,
  });
  if (!parsed.success) {
    // v1.4.43 W6 — per-med intake POST hot path; multi-issue 422 +
    // audit breadcrumb keyed `medications.intake.create.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.create.validation-failed" },
      meta: { issue_count: issues.length, medication_id: id },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; the
    // intake payload carries `idempotencyKey` (opaque caller string).
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "medications.intake.create.validation-failed",
          details: JSON.stringify({
            issues: auditIssues,
            medicationId: id,
          }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { scheduledFor, takenAt, skipped, idempotencyKey } = parsed.data;

  const resolvedTakenAt = skipped ? null : (takenAt ?? new Date());
  const incomingScheduledFor = scheduledFor ?? takenAt ?? new Date();
  // C2 — the per-med route only ever carries an explicit user gesture:
  // `resolvedTakenAt` is `now()` for any non-skip POST (there is no
  // "mark pending" write on this route), so a non-skip is an explicit
  // taken and a `skipped:true` body is an explicit skip. Neither is a
  // pending projection echo, so the no-downgrade guard never trips here —
  // it is the bulk/sync route that replays pending echoes. The flags are
  // threaded through so the shared upsert applies last-write-wins.
  const isExplicitTaken = !skipped;
  const isExplicitSkip = skipped === true;

  // v1.8.2 — source-agnostic slot snap. A twice-daily med carries a
  // pending REMINDER row the projector/worker minted at the canonical
  // `localHmAsUtc` slot instant. Without this, a manual "Genommen" write
  // (source WEB) inserted a SECOND row for the slot because the unique
  // key includes `source` and the iOS-vs-server `scheduledFor` can drift
  // by a minute — inflating compliance to 100% and suppressing the
  // "take now" prompt for a dose the user hadn't taken. Snap the write
  // to the canonical slot and update the existing row in place.
  //
  // Resolved BEFORE the idempotency/dedup window so a scheduled dose
  // routes through the slot upsert (which is itself the dedup): the
  // legacy 60-second window would otherwise short-circuit by returning
  // the slot's pending REMINDER row WITHOUT applying the user's takenAt.
  const canonicalSlot = await resolveSlotInstantForWrite({
    userId: user.id,
    medicationId: id,
    userTz: user.timezone,
    incoming: incomingScheduledFor,
  });

  // Idempotency check (explicit key or server-side dedup window)
  if (idempotencyKey) {
    const existing = await prisma.medicationIntakeEvent.findFirst({
      where: {
        idempotencyKey,
        userId: user.id,
        medicationId: id,
      },
    });
    if (existing) {
      return apiSuccess(existing);
    }
  } else if (!canonicalSlot) {
    // Unscheduled / PRN only — the slot upsert handles dedup for
    // scheduled doses by collapsing onto the canonical slot row.
    // Server-side dedup: prevent double-logging within 60 seconds.
    const recentDuplicate = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId: user.id,
        medicationId: id,
        skipped,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (recentDuplicate) {
      return apiSuccess(recentDuplicate);
    }
  }

  let event;
  // v1.8.2 reconcile — whether this write moved the slot pending→taken.
  // Only that transition decrements pen inventory (M2). For the
  // unscheduled/PRN branch a non-skip write always records a fresh dose,
  // so it consumes when not skipped.
  let consumedTransition = !skipped;
  if (canonicalSlot) {
    // Scheduled dose — converge onto the one canonical slot row regardless
    // of `source` (the pending REMINDER row, or any prior row for this
    // slot) through the shared upsert: H1 deterministic selection, C2
    // no-downgrade guard, and a C1 race-safe create that re-finds + updates
    // on a P2002 collision rather than 500-ing or duplicating.
    const applied = await applyCanonicalSlotWrite({
      client: prisma,
      userId: user.id,
      medicationId: id,
      canonicalSlot,
      takenAt: resolvedTakenAt,
      skipped,
      isExplicitTaken,
      isExplicitSkip,
      idempotencyKey: idempotencyKey ?? null,
      createSource: "WEB",
    });
    event = applied.row;
    consumedTransition = applied.consumedTransition;
    // Reset the snooze when a dose is actually recorded (not on a
    // no-downgrade no-op, which left the prior taken row untouched).
    if (!skipped && !applied.noDowngradeNoOp) {
      await prisma.medication.update({
        where: { id },
        data: { snoozedUntil: null },
      });
    }
  } else {
    // Unscheduled / PRN / off-slot — keep the original insert behaviour.
    [event] = await prisma.$transaction([
      prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: id,
          scheduledFor: incomingScheduledFor,
          takenAt: resolvedTakenAt,
          skipped,
          source: "WEB",
          idempotencyKey: idempotencyKey ?? null,
        },
      }),
      // Reset snooze when medication is taken
      ...(!skipped
        ? [
            prisma.medication.update({
              where: { id },
              data: { snoozedUntil: null },
            }),
          ]
        : []),
    ]);
  }

  // v1.4.25 W19b — pen-inventory dose decrement. Only fires for
  // non-skipped intakes; a skipped event is not a consumption event.
  // No-op when the medication has no tracked pens (most non-GLP-1
  // meds). Failures here must never block the intake write, so
  // errors are swallowed and logged — the intake is the source of
  // truth, the inventory is an opt-in companion.
  //
  // v1.8.2 M2 — gate on an ACTUAL pending→taken transition. An idempotent
  // re-post of an already-taken slot updates the row in place but must NOT
  // decrement again, else a repeated iOS sync drifts the GLP-1 pen count
  // down on every replay. `consumedTransition` is false when the slot was
  // already taken (or on a no-downgrade no-op).
  let inventoryOutcome: Awaited<ReturnType<typeof consumeOneDose>> = null;
  if (!skipped && consumedTransition) {
    try {
      inventoryOutcome = await consumeOneDose({
        userId: user.id,
        medicationId: id,
        intakeAt: event.takenAt ?? event.scheduledFor,
      });
    } catch (err) {
      annotate({
        action: { name: "medication.inventory.consume_error" },
        meta: {
          medication_id: id,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  await auditLog("medication.intake", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      medicationId: id,
      eventId: event.id,
      skipped,
      ...(inventoryOutcome
        ? {
            inventoryItemId: inventoryOutcome.itemId,
            inventoryChange: inventoryOutcome.change,
          }
        : {}),
    },
  });

  annotate({
    action: {
      name: "medication.intake",
      entity_type: "intake_event",
      entity_id: event.id,
    },
    meta: {
      medication_id: id,
      skipped,
      ...(inventoryOutcome
        ? {
            inventory_item_id: inventoryOutcome.itemId,
            inventory_change: inventoryOutcome.change,
          }
        : {}),
    },
  });

  // v1.4.34 IW-G — bust per-user medications + compliance + achievement
  // caches so the next read reflects the dose event.
  invalidateUserMedications(user.id);

  // v1.4.39 W-MED — refresh the persistent compliance rollup for the
  // affected day. The hook is best-effort; failures annotate but never
  // block the user's POST response.
  await recomputeMedicationComplianceForEvent({
    userId: user.id,
    medicationId: id,
    scheduledFor: event.scheduledFor,
    tz: user.timezone,
  });

  // v1.5.0 — one-shot lifecycle reconciliation. A `oneShot` medication
  // has at most one live intake; the helper re-reads the most recent
  // non-skipped intake and flips `active` to match. Idempotent on
  // non-one-shot medications (the underlying updateMany is gated by
  // `oneShot:true`). The flip runs AFTER the intake row is committed
  // so a flaky write never deactivates a medication that didn't
  // actually receive its dose.
  const reconcileAction = await reconcileOneShotState(prisma, id, user.id);
  if (reconcileAction !== "noop") {
    invalidateUserMedications(user.id);
  }

  return apiSuccess(event, 201);
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listIntakeEventsSchema.safeParse(searchParams);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422 + audit breadcrumb keyed
      // `medications.intake.list.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.list.validation-failed" },
        meta: { issue_count: issues.length, medication_id: id },
      });
      // v1.4.49 — strip `message` from the audit-ledger row.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "medications.intake.list.validation-failed",
            details: JSON.stringify({
              issues: auditIssues,
              medicationId: id,
            }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
    }

    const { limit, offset, sortBy, sortDir, status } = parsed.data;

    // v1.4.37 W3 — translate the optional `status` filter into a Prisma
    // `where` fragment. Default `status:"all"` keeps the contract
    // byte-stable for the iOS Swift client and the dashboard tiles that
    // were on the wire before this knob existed. The detail-page
    // IntakeHistoryListV2 component opts into `status:"completed"` so
    // ambiguous "missed / never confirmed" rows
    // (`takenAt IS NULL AND skipped = false`) stay out of the user-facing
    // table — they were the source of the v1.4.36 regression where rows
    // with no takenAt rendered an "Eingenommen" chip.
    const statusFilter =
      status === "taken"
        ? { takenAt: { not: null }, skipped: false }
        : status === "skipped"
          ? { skipped: true }
          : status === "completed"
            ? {
                OR: [
                  { takenAt: { not: null }, skipped: false },
                  { skipped: true },
                ],
              }
            : {};
    // v1.7.0 sync — exclude tombstoned rows from the per-medication
    // intake history list + its count.
    const where = {
      medicationId: id,
      userId: user.id,
      deletedAt: null,
      ...statusFilter,
    };

    // v1.7.0 O-1 — pin NULLS LAST on the `takenAt` sort. Skipped rows
    // carry `takenAt: null`; under a bare `desc` collation Postgres
    // emits NULLS FIRST, floating skipped/planned rows to the top of
    // the history view. Pinning them last keeps the descending order
    // reading today → yesterday → … with real timestamps first. Other
    // sort columns are non-null so they keep the simple shape.
    const orderBy =
      sortBy === "takenAt"
        ? { takenAt: { sort: sortDir, nulls: "last" as const } }
        : { [sortBy]: sortDir };

    const [events, total] = await Promise.all([
      prisma.medicationIntakeEvent.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
      }),
      prisma.medicationIntakeEvent.count({ where }),
    ]);

    annotate({
      action: { name: "medication.intake.list" },
      meta: { medication_id: id, total, status },
    });

    return apiSuccess({ events, meta: { total, limit, offset } });
  },
);
