import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.5.5 C-E3-3 — route purge through the same ownership predicate
    // every other `src/app/api/medications/[id]/**` handler uses. The
    // hand-rolled `findUnique + userId !== id ? 404` block returned the
    // medication row only to read its name for the audit details. The
    // audit row still wants the name; re-read it after the guard so the
    // ownership check stays the single source of truth on the 404 leak
    // shape.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const medication = await prisma.medication.findUnique({
      where: { id },
      select: { name: true },
    });

    const { count } = await prisma.medicationIntakeEvent.deleteMany({
      where: { medicationId: id, userId: user.id },
    });

    // v1.4.39 W-MED — drop every rollup row for this medication so the
    // next compliance read returns zero-filled buckets rather than the
    // last-known scheduled / taken totals for now-deleted events.
    await prisma.medicationComplianceRollup.deleteMany({
      where: { medicationId: id, userId: user.id },
    });

    await auditLog("medication.intake.purge", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        name: medication?.name ?? "",
        deletedCount: count,
      },
    });

    annotate({
      action: {
        name: "medication.intake.purge",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { purged_count: count },
    });

    // v1.5.5 F-1 C-3 — drop the per-user medication caches so the
    // analytics + iOS today-tally + dashboard tiles converge on the
    // post-purge counts rather than reading stale values for the
    // TTL of each cache. Matches the sibling routes (POST intake,
    // PUT medication, bulk-delete) that all fire this bundle.
    invalidateUserMedications(user.id);

    return apiSuccess({ purged: true, count });
  },
);
