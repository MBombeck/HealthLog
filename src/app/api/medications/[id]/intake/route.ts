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
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
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
  } else {
    // Server-side dedup: prevent double-logging within 60 seconds
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

  const [event] = await prisma.$transaction([
    prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: id,
        scheduledFor: scheduledFor ?? takenAt ?? new Date(),
        takenAt: skipped ? null : (takenAt ?? new Date()),
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

  // v1.4.25 W19b — pen-inventory dose decrement. Only fires for
  // non-skipped intakes; a skipped event is not a consumption event.
  // No-op when the medication has no tracked pens (most non-GLP-1
  // meds). Failures here must never block the intake write, so
  // errors are swallowed and logged — the intake is the source of
  // truth, the inventory is an opt-in companion.
  let inventoryOutcome: Awaited<ReturnType<typeof consumeOneDose>> = null;
  if (!skipped) {
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
    const where = { medicationId: id, userId: user.id, ...statusFilter };

    const [events, total] = await Promise.all([
      prisma.medicationIntakeEvent.findMany({
        where,
        orderBy: { [sortBy]: sortDir },
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
