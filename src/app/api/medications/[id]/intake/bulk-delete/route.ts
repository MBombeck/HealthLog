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
} from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { bulkDeleteIntakeEventsSchema } from "@/lib/validations/medication";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
} from "@/lib/rollups/medication-compliance-rollups";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

// v1.5.5 F-1 H-6 — match the glp1 POST shape so a caller firing
// repeated 500-id bulk deletes cannot pin the per-dayKey recompute
// path. 30/min/user is generous for a hand-driven multi-select and
// tight enough to cut off the spam case.
const BULK_DELETE_RATE_LIMIT = 30;
const BULK_DELETE_WINDOW_MS = 60_000;

/**
 * v1.5.5 D-3 §9.5 + §11 — bulk-delete N intake rows in one transaction
 * so the detail-page intake-history preview can offer multi-select →
 * Löschen without the user firing N concurrent DELETEs from the
 * client. The endpoint:
 *
 *   - Asserts medication ownership via the shared helper (so the 404
 *     leak shape stays identical across `[id]/**`).
 *   - Loads only the (id, scheduledFor) for events that match the body
 *     ids AND the asserted (user, medication) tuple. Ids that don't
 *     match are silently dropped — the client surface is "delete these
 *     rows from this medication" and an attacker-supplied id from
 *     another medication never deletes anything.
 *   - Runs `deleteMany` scoped by the user-and-medication predicate.
 *   - Recomputes the compliance rollup once per affected dayKey (not
 *     once per event), so the rollup tier converges after a 14-row
 *     bulk delete in at most 14 SQL trips and usually 1-3.
 *   - Audits the bulk action with the deleted count.
 *
 * Failure modes:
 *
 *   - 401 unauthenticated — caught by `requireAuth`.
 *   - 404 unknown / not-owned medication — `assertMedicationOwnership`.
 *   - 422 malformed body — Zod via `returnAllZodIssues`.
 *   - 200 with `{ deleted: number }` on success; `deleted` reports the
 *     real `deleteMany` count so the client can show a precise toast.
 */
export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    // v1.5.5 F-1 H-6 — per-user cap matches the glp1 POST so a caller
    // firing repeated 500-id bulk deletes cannot pin the per-dayKey
    // recompute path.
    const rl = await checkRateLimit(
      `medication-intake-bulk-delete:${user.id}`,
      BULK_DELETE_RATE_LIMIT,
      BULK_DELETE_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many requests", 429, {
        headers: rateLimitHeaders(rl),
      });
    }

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;
    const parsed = bulkDeleteIntakeEventsSchema.safeParse(body);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422);
    }
    const { eventIds } = parsed.data;

    // Tz the rollups are anchored on. The detail-page caller persists
    // intakes through the same hook, so reading `user.timezone` here
    // matches the write-path's recompute call.
    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { timezone: true },
    });
    const tz = userRow?.timezone ?? null;

    // Read the dayKeys of every row we're about to remove so the
    // post-delete recompute knows which day-buckets need to converge.
    // Scope by (user, medication) so a leaked id from another
    // medication's history never affects this bulk action.
    const targetRows = await prisma.medicationIntakeEvent.findMany({
      where: {
        id: { in: eventIds },
        userId: user.id,
        medicationId: id,
      },
      select: { id: true, scheduledFor: true },
    });

    if (targetRows.length === 0) {
      return apiSuccess({ deleted: 0 });
    }

    const dayKeysToRefresh = new Set<string>();
    for (const row of targetRows) {
      dayKeysToRefresh.add(dayKeyForScheduledFor(row.scheduledFor, tz));
    }

    const { count } = await prisma.medicationIntakeEvent.deleteMany({
      where: {
        id: { in: targetRows.map((r) => r.id) },
        userId: user.id,
        medicationId: id,
      },
    });

    // Best-effort rollup refresh — one trip per unique dayKey so a
    // 14-row delete spanning two days closes in two SQL trips. The
    // helper is idempotent and the catch swallows transient
    // populator failures (same contract as the single-event delete).
    for (const dayKey of dayKeysToRefresh) {
      try {
        await recomputeMedicationComplianceForDay(user.id, id, dayKey, tz);
      } catch (err) {
        annotate({
          action: {
            name: "medications.intake.bulk-delete.recompute-failed",
            entity_type: "medication",
            entity_id: id,
          },
          meta: {
            day_key: dayKey,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    await auditLog("medication.intake.bulk_delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        requestedCount: eventIds.length,
        deletedCount: count,
      },
    });

    annotate({
      action: {
        name: "medications.intake.bulk-delete",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { deleted_count: count, day_buckets: dayKeysToRefresh.size },
    });

    invalidateUserMedications(user.id);

    return apiSuccess({ deleted: count });
  },
);
