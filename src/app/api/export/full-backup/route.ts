/**
 * GET /api/export/full-backup
 *
 * v1.4.16 phase B7. Single-file user-scoped JSON dump that matches the
 * canonical `backupPayloadSchema` (see `src/lib/validations/backup.ts`)
 * — same shape the pg-boss `data-backup` worker writes weekly, so a
 * user can hand this file to an admin and `POST /api/admin/backups/upload`
 * accepts it without further conversion.
 *
 * Response is `application/json` with an attachment filename ending in
 * `.json` so the browser writes a `.json` file even though the route
 * segment doesn't carry the extension.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h).
 * Audit: `user.export.full-backup` with the row counts.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { BACKUP_SCHEMA_VERSION } from "@/lib/validations/backup";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.full-backup" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  const [measurements, medications, intakeEvents, moodEntries] =
    await Promise.all([
      prisma.measurement.findMany({
        // v1.4.41 W-DELETED-2 — soft-deleted rows are excluded from the
        // user-initiated backup bundle so the round-trip via admin
        // restore does not resurrect deleted measurements.
        where: { userId: user.id, deletedAt: null },
        orderBy: { measuredAt: "desc" },
      }),
      // Explicit `select` on the schedule columns — see the matching
      // comment in `medications/route.ts` for the rationale (the
      // integration testbed has an unmigrated `days_of_week` column on
      // the schema branch we ship alongside).
      prisma.medication.findMany({
        where: { userId: user.id },
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
      }),
      prisma.medicationIntakeEvent.findMany({
        where: { userId: user.id },
        include: { medication: { select: { name: true } } },
        orderBy: { scheduledFor: "desc" },
      }),
      prisma.moodEntry.findMany({
        where: { userId: user.id },
        orderBy: { moodLoggedAt: "desc" },
      }),
    ]);

  // Shape mirrors the pg-boss `data-backup` worker exactly so the same
  // `parseBackupPayload()` validator round-trips both blobs. Keep these
  // two writers in sync — `src/lib/jobs/reminder-worker.ts` is the
  // canonical reference.
  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    userId: user.id,
    measurements: measurements.map((m) => ({
      type: m.type,
      value: m.value,
      unit: m.unit,
      measuredAt: m.measuredAt.toISOString(),
      source: m.source,
      notes: m.notes,
    })),
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      active: m.active,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
        dose: s.dose,
      })),
    })),
    intakeEvents: intakeEvents.map((e) => ({
      medication: e.medication.name,
      scheduledFor: e.scheduledFor.toISOString(),
      takenAt: e.takenAt?.toISOString() ?? null,
      skipped: e.skipped,
      source: e.source,
    })),
    moodEntries: moodEntries.map((e) => ({
      date: e.date,
      mood: e.mood,
      score: e.score,
      tags: e.tags,
      source: e.source,
      loggedAt: e.moodLoggedAt.toISOString(),
    })),
  };

  await auditLog("user.export.full-backup", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      counts: {
        measurements: measurements.length,
        medications: medications.length,
        intakeEvents: intakeEvents.length,
        moodEntries: moodEntries.length,
      },
    },
  });

  annotate({
    meta: {
      export_measurements_count: measurements.length,
      export_medications_count: medications.length,
      export_intake_count: intakeEvents.length,
      export_mood_count: moodEntries.length,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  // Stream the JSON directly (NOT wrapped in the apiSuccess envelope) so
  // the file is a self-contained backup — admin upload + restore expect
  // the raw payload, not `{ data: { ... } }`.
  return new NextResponse(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="healthlog-backup-${user.id}-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
