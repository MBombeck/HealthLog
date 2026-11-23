import { prisma } from "@/lib/db";
import {
  enqueueSupplementNutrientRecompute,
  medicationHasComposition,
} from "@/lib/medications/ingredients/recompute-job";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { afterDoseChange } from "@/lib/medications/after-dose-change";
import {
  REOPENED_WINDOW_MS,
  reopenedEventOf,
} from "@/lib/notifications/medication-intake-recorded";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. It tombstones rather than deletes (since the
    // delegated-write release), so the history it clears is reconstructable
    // from the rows themselves.
    const { user } = await requireRecordAuth("manage", "medications");

    const { id } = await params;
    // v1.5.5 — route purge through the same ownership predicate
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

    // Tombstone, like both siblings (single-event DELETE, bulk-delete). This
    // was the one destructive verb in the intake family with nothing to
    // reconstruct from: `deleteMany` removed the rows outright, so a purge
    // fired by mistake was final, and it was invisible to `/api/sync/changes`
    // — a client offline at purge time kept every row forever, because a row
    // that no longer exists produces no tombstone to send.
    //
    // Setting `deletedAt` (+ bumping `syncVersion`) makes the rows invisible
    // to every today / compliance / list read (all of which filter
    // `deletedAt: null`) while the sync feed emits one tombstone per row. The
    // nightly tombstone purge collects them later, so nothing grows without
    // bound. Scope `deletedAt: null` so a second purge counts zero rather than
    // re-bumping rows already gone.
    //
    // No inventory refund, deliberately: the single-event and bulk deletes
    // refund because "I did not take that dose" puts the pill back in the box.
    // A purge wipes an entire history as bookkeeping, and refunding every dose
    // ever taken would inflate the current container count instead.
    // The recent takes and skips the purge removes: their slots open again
    // on the other devices (`reopenedEventOf`).
    const answered = await prisma.medicationIntakeEvent.findMany({
      where: {
        medicationId: id,
        userId: user.id,
        deletedAt: null,
        OR: [{ takenAt: { not: null } }, { skipped: true }],
        scheduledFor: { gte: new Date(Date.now() - REOPENED_WINDOW_MS) },
      },
      select: {
        id: true,
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
      },
    });
    const { count } = await prisma.medicationIntakeEvent.updateMany({
      where: { medicationId: id, userId: user.id, deletedAt: null },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });

    // v1.43 — the purged doses no longer count toward the micronutrients.
    if (await medicationHasComposition(user.id, id)) {
      await enqueueSupplementNutrientRecompute(user.id);
    }

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

    // v1.5.5 — drop the per-user medication caches so the
    // analytics + iOS today-tally + dashboard tiles converge on the
    // post-purge counts rather than reading stale values for the
    // TTL of each cache. Matches the sibling routes (POST intake,
    // PUT medication, bulk-delete) that all fire this bundle.
    invalidateUserMedications(user.id, { evict: true });

    // (#22) — silent cross-device intake sync: a purged history changes
    // the intake state the user's other iOS devices render. Coalesced
    // per user, best-effort — never affects the response.
    afterDoseChange({
      scope: "intakes",
      userId: user.id,
      originDeviceToken: request.headers.get("x-device-id"),
      recorded: answered.flatMap((row) => {
        const reopened = reopenedEventOf(row, null);
        return reopened ? [reopened] : [];
      }),
    });

    return apiSuccess({ purged: true, count });
  },
);
