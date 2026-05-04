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
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postIntake),
);

async function postIntake(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuth();

  const { id } = await params;
  const medication = await prisma.medication.findUnique({ where: { id } });
  if (!medication || medication.userId !== user.id) {
    return apiError("Medication not found", 404);
  }

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

  await auditLog("medication.intake", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { medicationId: id, eventId: event.id, skipped },
  });

  annotate({
    action: {
      name: "medication.intake",
      entity_type: "intake_event",
      entity_id: event.id,
    },
    meta: { medication_id: id, skipped },
  });

  return apiSuccess(event, 201);
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const medication = await prisma.medication.findUnique({ where: { id } });
    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

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
