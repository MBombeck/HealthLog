/**
 * GET /api/export/medications
 *
 * v1.4.16 phase B7. Per-type CSV download for the consolidated
 * `/settings/export` UI. Always includes the medication list; appends
 * a `# Intake history` block when `?intake=true` (the default — the
 * UI toggle is checked by default so a stripped-down export is opt-in).
 *
 * `?medicationId=<id>` scopes the export to a single medication (its row
 * plus, when intake is on, only that medication's intake log) — the
 * per-medication advanced sheet uses it so the export mirrors the
 * per-medication import beside it. Omitted, the export spans every
 * medication (the `/settings/export` card). The id is always narrowed by
 * `userId`, so a foreign id resolves to no medication and 404s.
 *
 * Response is `text/csv` with an attachment filename ending in `.csv`.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h) so the user can't
 *   sidestep the global cap by hitting per-type endpoints in parallel.
 * Audit: `user.export.medications` with the resolved filter + intake flag.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  toCSV,
  formatMedicationsForExport,
  formatIntakeEventsForExport,
} from "@/lib/export";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.medications" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  const params = new URL(request.url).searchParams;
  const includeIntake = params.get("intake") !== "false";
  const medicationId = params.get("medicationId") || undefined;
  const sinceRaw = params.get("since");
  const untilRaw = params.get("until");
  const since = sinceRaw ? safeDate(sinceRaw) : undefined;
  const until = untilRaw ? safeDate(untilRaw) : undefined;

  // Explicit `select` on the schedule columns we actually format. The
  // integration testbed has an unmigrated `medication_schedules.days_of_week`
  // column on this branch (sibling work added the field to the schema
  // without a matching migration); a wildcard `include: { schedules: true }`
  // would 500 on the missing column. Pin the columns instead — the export
  // shape doesn't need every future field anyway.
  const [medications, userTz] = await Promise.all([
    prisma.medication.findMany({
      where: medicationId
        ? { userId: user.id, id: medicationId }
        : { userId: user.id },
      select: {
        name: true,
        dose: true,
        active: true,
        schedules: {
          select: {
            windowStart: true,
            windowEnd: true,
            label: true,
            dose: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    resolveUserTimezone(user.id),
  ]);

  // A scoped export for an id the caller doesn't own resolves to no row
  // (the `where` is narrowed by userId) — surface that as 404 rather than
  // streaming an empty CSV.
  if (medicationId && medications.length === 0) {
    return apiError("Medication not found", 404);
  }

  const sections: string[] = [
    "# Medications",
    toCSV(formatMedicationsForExport(medications)),
  ];
  let intakeCount = 0;

  if (includeIntake) {
    const where: {
      userId: string;
      deletedAt: null;
      medicationId?: string;
      scheduledFor?: { gte?: Date; lte?: Date };
    } = {
      userId: user.id,
      // v1.7.0 sync — exclude tombstoned rows from the export.
      deletedAt: null,
    };
    if (medicationId) where.medicationId = medicationId;
    if (since || until) {
      where.scheduledFor = {};
      if (since) where.scheduledFor.gte = since;
      if (until) where.scheduledFor.lte = until;
    }
    const events = await prisma.medicationIntakeEvent.findMany({
      where,
      include: { medication: { select: { name: true } } },
      orderBy: { scheduledFor: "desc" },
    });
    intakeCount = events.length;
    sections.push("# Intake history");
    sections.push(toCSV(formatIntakeEventsForExport(events, userTz)));
  }

  const body = sections.join("\n\n");

  await auditLog("user.export.medications", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      medicationCount: medications.length,
      intakeCount,
      includeIntake,
      medicationId: medicationId ?? null,
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
    },
  });

  annotate({
    meta: {
      export_medications_count: medications.length,
      export_intake_count: intakeCount,
      export_include_intake: includeIntake,
      export_medication_scoped: Boolean(medicationId),
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="healthlog-medications-${user.id}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});

function safeDate(value: string): Date | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
