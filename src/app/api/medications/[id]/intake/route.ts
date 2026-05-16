import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import {
  intakeSchema,
  listIntakeEventsSchema,
} from "@/lib/validations/medication";
import { withIdempotency } from "@/lib/idempotency";
import { consumeOneDose } from "@/lib/medications/inventory/service";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
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
    return apiError(parsed.error.issues[0].message, 422);
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
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { limit, offset, sortBy, sortDir } = parsed.data;
    const where = { medicationId: id, userId: user.id };

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
      meta: { medication_id: id, total },
    });

    return apiSuccess({ events, meta: { total, limit, offset } });
  },
);
