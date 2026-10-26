/**
 * v1.16.5 — schedule-era management for the Zeitplan tab.
 *
 *   GET  /api/medications/[id]/schedule-revisions
 *     - lists the medication's archived schedule eras (newest first)
 *       plus `currentSince`, the instant the LIVE plan took over (the
 *       newest revision's `validUntil`, or `medication.createdAt` when
 *       no era has been archived yet).
 *
 *   POST /api/medications/[id]/schedule-revisions
 *     - appends a MANUAL era for pre-tracking history ("dosed at
 *       07:00/19:00 from March to June"). Validation: the era must end
 *       at or before the start of the live era and must not overlap
 *       any existing revision. The snapshot payload mirrors what the
 *       write-path archive mints (`FREQ=DAILY`, window pulled to the
 *       min/max of the times) so the era minter — ledger, compliance,
 *       cadence chips — reads it like any other revision.
 *
 * Auth: cookie-session or Bearer, resolved through `requireRecordAuth`; the
 *   medication is
 * verified to belong to the caller before any read or write. Deleting
 * a manual era lives in the `[revisionId]` sub-route.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { scheduleRevisionCreateSchema } from "@/lib/validations/schedule-revision";
import {
  toRevisionPayloadEntry,
  type ScheduleRevisionEntry,
} from "@/lib/medications/scheduling/schedule-eras";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Display projection of one archived schedule row. Defensive parsing —
 * a malformed payload entry degrades to an empty summary instead of
 * throwing on a read path (mirrors `canonicalSchedulesFromRevision`).
 */
function summariseEntries(payload: unknown): Array<{
  timesOfDay: string[];
  label: string | null;
  dose: string | null;
  scheduleType: string;
}> {
  if (!Array.isArray(payload)) return [];
  return payload.map((raw) => {
    const e = (raw ?? {}) as Partial<ScheduleRevisionEntry>;
    return {
      timesOfDay: Array.isArray(e.timesOfDay)
        ? e.timesOfDay.filter((t): t is string => typeof t === "string")
        : [],
      label: typeof e.label === "string" ? e.label : null,
      dose: typeof e.dose === "string" ? e.dose : null,
      scheduleType:
        typeof e.scheduleType === "string" ? e.scheduleType : "SCHEDULED",
    };
  });
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      select: { createdAt: true },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }

    const revisions = await prisma.medicationScheduleRevision.findMany({
      // Superseded rows are audit records behind a correction — the
      // timeline shows the corrected state, like every era consumer.
      where: { medicationId: id, supersededByRevisionId: null },
      orderBy: [{ validFrom: "desc" }, { id: "desc" }],
      select: {
        id: true,
        validFrom: true,
        validUntil: true,
        source: true,
        payload: true,
      },
    });

    // The live plan has been current since the newest archived era
    // ended; with no archive it has been current since creation.
    const currentSince =
      revisions.length > 0
        ? revisions.reduce(
            (latest, r) => (r.validUntil > latest ? r.validUntil : latest),
            revisions[0].validUntil,
          )
        : med.createdAt;

    annotate({
      action: {
        name: "medication.schedule_revisions.list",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { revision_count: revisions.length },
    });

    return apiSuccess({
      currentSince: currentSince.toISOString(),
      revisions: revisions.map((r) => ({
        id: r.id,
        validFrom: r.validFrom.toISOString(),
        validUntil: r.validUntil.toISOString(),
        source: r.source,
        entries: summariseEntries(r.payload),
      })),
    });
  },
);

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Archiving a schedule era the compliance engine reads:
    // additive, audited, and reversible through the DELETE beside it.
    const { user } = await requireRecordAuth("manage", "medications");
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      select: { createdAt: true },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }

    const parsed = await parseJsonBody(request, scheduleRevisionCreateSchema, {
      maxBytes: 16 * 1024,
      input: (body) => body ?? {},
    });
    if (!parsed.ok) return parsed.error;

    const validFrom = new Date(parsed.data.validFrom);
    const validUntil = new Date(parsed.data.validUntil);

    // Sanity floor — a fat-fingered year ("0203") would otherwise mint
    // an era the timeline renders as antiquity.
    if (validFrom.getUTCFullYear() < 1900) {
      return apiError("validFrom must be a date after 1900", 422);
    }

    // Snapshot entry shaped exactly like the write-path archive: daily
    // recurrence at the given times, window pulled to their min/max.
    // The schema already deduped + sorted the times.
    const times = parsed.data.timesOfDay;
    const entry = toRevisionPayloadEntry({
      timesOfDay: times,
      windowStart: times[0],
      windowEnd: times[times.length - 1],
      daysOfWeek: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
      label: null,
      dose: null,
      reminderGraceMinutes: null,
    });

    // Validate-then-write under a per-medication row lock: two
    // concurrent era writes used to both pass the overlap check against
    // the same snapshot and both insert. `FOR UPDATE` on the medication
    // row serialises every era write for this medication; the reads run
    // through the same `tx` so they see the locked state.
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM medications
        WHERE id = ${id}
        FOR UPDATE
      `;

      const existing = await tx.medicationScheduleRevision.findMany({
        where: { medicationId: id, supersededByRevisionId: null },
        select: { validFrom: true, validUntil: true },
      });

      // "Before the current plan": the live era began at the newest
      // active `validUntil`, and never earlier than `createdAt` — the
      // era splitter reads `[newest validUntil, ∞)`, or the whole range
      // when no revision exists. Allowing a manual era to reach past
      // that instant would let the manual snapshot swallow tracked live
      // history and re-score compliance against the wrong plan.
      const liveBoundary = existing.reduce(
        (latest, r) => (r.validUntil > latest ? r.validUntil : latest),
        med.createdAt,
      );
      if (validUntil.getTime() > liveBoundary.getTime()) {
        return {
          ok: false,
          error: "A manual era must end before the current plan begins",
        } as const;
      }

      // No overlap with any active interval `[validFrom, validUntil)`.
      const overlaps = existing.some(
        (r) =>
          validFrom.getTime() < r.validUntil.getTime() &&
          validUntil.getTime() > r.validFrom.getTime(),
      );
      if (overlaps) {
        return {
          ok: false,
          error: "The era overlaps an existing schedule era",
        } as const;
      }

      const revision = await tx.medicationScheduleRevision.create({
        data: {
          medicationId: id,
          validFrom,
          validUntil,
          source: "MANUAL",
          payload: [entry] as unknown as Prisma.InputJsonValue,
        },
        select: {
          id: true,
          validFrom: true,
          validUntil: true,
          source: true,
          payload: true,
        },
      });
      return { ok: true, revision } as const;
    });

    if (!outcome.ok) {
      return apiError(outcome.error, 422);
    }
    const revision = outcome.revision;

    await auditLog("medication.schedule_revision.created", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, revisionId: revision.id },
    });

    annotate({
      action: {
        name: "medication.schedule_revision.manual_created",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        revision_id: revision.id,
        era_days: Math.round(
          (validUntil.getTime() - validFrom.getTime()) / 86_400_000,
        ),
      },
    });

    // v1.16.9 — an era write re-segments the bands every cached payload
    // (list next-due, compliance cells, dashboard tally) was built on;
    // hard-evict so the next read reflects the new history immediately.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess(
      {
        id: revision.id,
        validFrom: revision.validFrom.toISOString(),
        validUntil: revision.validUntil.toISOString(),
        source: revision.source,
        entries: summariseEntries(revision.payload),
      },
      201,
    );
  },
);
