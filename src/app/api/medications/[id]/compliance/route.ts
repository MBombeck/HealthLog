import { prisma } from "@/lib/db";
import { COURSES_COMPLIANCE_SELECT } from "@/lib/analytics/compliance";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  buildCompliancePayload,
  complianceCacheKey,
  type CompliancePayload,
} from "@/lib/medications/compliance-payload";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Builder-internal sentinel for "no such medication for this caller".
 * Thrown from inside the cache builder so a rejected build is never
 * persisted; the handler maps it onto the canonical 404 envelope (the
 * same "Medication not found" shape `assertMedicationOwnership` mints,
 * so the existence channel stays sealed).
 */
class MedicationNotFoundError extends Error {
  constructor() {
    super("Medication not found");
  }
}

export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    // The per-user budget is generous — it only caps a runaway client
    // loop (the cards read the batched `/api/medications/compliance`
    // sibling; this endpoint serves the detail page).
    const rl = await checkRateLimit(
      `medication-compliance:${user.id}`,
      60,
      60_000,
    );
    if (!rl.allowed) {
      return apiError("Too many compliance requests. Please retry later.", 429);
    }

    const userTz = user.timezone || DEFAULT_TIMEZONE;

    // Read-through the per-user compliance cache (15 min fresh TTL +
    // SWR window). The ownership guard and the medication read live
    // INSIDE the builder: the cache key is `${userId}|${medicationId}|…`,
    // so a warm or stale hit is by construction a payload this caller
    // already built for a medication they own — re-running the guard on
    // every hit only re-paid two row reads per card. A cross-user id
    // misses this user's prefix, runs the builder, and 404s there.
    //
    // Interactive intake / medication writes EVICT the `${userId}|`
    // prefix via `invalidateUserMedications({ evict: true })`, so a warm
    // entry can only be stale relative to wall-clock drift, never to the
    // user's own action; background sync paths mark the bucket stale and
    // the SWR read serves the prior payload while one coalesced rebuild
    // warms a fresh one.
    let payload: CompliancePayload;
    try {
      payload = await cachedSwr(
        caches.medicationCompliance as ServerCache<CompliancePayload>,
        complianceCacheKey(user.id, id, userTz),
        async () => {
          const medication = await prisma.medication.findUnique({
            where: { id },
            include: {
              schedules: true,
              // v1.16.3 — archived schedule eras for era-aware compliance.
              scheduleRevisions: { orderBy: { validFrom: "asc" } },
              // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
              pauseEras: { select: { pausedAt: true, resumedAt: true } },
              // v1.40 (#1024) — the courses, so a gap between two expects nothing.
              courses: COURSES_COMPLIANCE_SELECT,
            },
          });
          // Privacy gate — same sealed 404 for "absent" and "not yours".
          if (!medication || medication.userId !== user.id) {
            throw new MedicationNotFoundError();
          }
          return buildCompliancePayload(medication, user.id, userTz);
        },
        annotate,
      );
    } catch (err) {
      if (err instanceof MedicationNotFoundError) {
        return apiError("Medication not found", 404);
      }
      throw err;
    }

    annotate({
      action: {
        name: "medication.compliance",
        entity_type: "medication",
        entity_id: id,
      },
      meta: payload.applicable
        ? {
            compliance7: payload.compliance7!.rate,
            compliance30: payload.compliance30!.rate,
            complianceShortDays: payload.complianceDisplay!.shortDays,
            complianceLongDays: payload.complianceDisplay!.longDays,
          }
        : {
            complianceApplicable: false,
            complianceNotApplicableReason: payload.notApplicableReason,
          },
    });

    return apiSuccess(payload);
  },
);
