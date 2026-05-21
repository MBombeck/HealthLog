/**
 * POST /api/admin/backups/[id]/restore — admin-only restore from backup.
 *
 * The riskiest endpoint in the backup family. Mirroring the v1.4.14 wipe
 * scope (`DELETE /api/admin/data`), the restore replaces the **target
 * user's** personal data with the contents of the snapshot:
 *
 *   1. Decrypt + parse the `DataBackup.data` blob.
 *   2. In a single Prisma transaction:
 *      a. Delete the user's measurements, medications (cascades to
 *         schedules + intake events + telegram messages +
 *         reminder-phase configs), mood entries, notification channels,
 *         push subscriptions, telegram scheduled deletions.
 *      b. Re-create measurements, medications + schedules, intake
 *         events, mood entries from the payload.
 *   3. Outside the transaction, write `admin.backups.restore` to the
 *      AuditLog so the trail outlives the operation. Audit rows are
 *      intentionally NOT touched by the restore (same contract as the
 *      wipe).
 *
 * Triple-confirm: the request body must carry `confirm: "RESTORE"`.
 * The client also gates the form on a typed-string match so an
 * accidental click cannot fire this.
 *
 * Idempotency: wrapped in `withIdempotency()` so retries with the same
 * `Idempotency-Key` replay the original outcome instead of double-
 * restoring (unlikely in practice — the second run would be a no-op
 * because the user data already matches the backup — but this still
 * prevents two parallel admin clicks from racing through).
 *
 * Phase B1 / criterion 3 of the v1.4.15 backup-completeness work.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { decrypt } from "@/lib/crypto";
import { defaultUserIdResolver, withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import {
  parseBackupPayload,
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup";
import { recomputeUserMoodRollups } from "@/lib/mood/rollups";
import {
  recomputeUserMedicationCompliance,
  MEDICATION_COMPLIANCE_BACKFILL_DAYS,
} from "@/lib/medications/compliance-rollups";
import { recomputeUserRollups } from "@/lib/measurements/rollups";

export const dynamic = "force-dynamic";

interface RestoreResponse {
  restored: true;
  summary: BackupSummary;
  cleared: {
    measurements: number;
    medications: number;
    intakeEvents: number;
    moodEntries: number;
    notificationChannels: number;
    pushSubscriptions: number;
    telegramScheduledDeletions: number;
  };
}

/**
 * Maps a measurement-type string from the backup back into the
 * Prisma enum literal. Backups are written from `enum MeasurementType`
 * (Postgres-mapped to lowercase column type), so the round-trip is
 * normally identity. But the schema is a `passthrough` schema so a
 * malformed type slips through Zod — guard it explicitly here so the
 * restore fails fast instead of erroring deep in `prisma.create()`.
 */
const MEASUREMENT_TYPES = new Set([
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
  // ── v1.4.23 Apple Health additions ──
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "BODY_TEMPERATURE",
]);

const MEASUREMENT_SOURCES = new Set([
  "MANUAL",
  "WITHINGS",
  "IMPORT",
  "APPLE_HEALTH",
]);
const INTAKE_SOURCES = new Set(["WEB", "API", "REMINDER", "IMPORT"]);

const handler = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;
    annotate({ action: { name: "admin.backups.restore" }, meta: { id } });

    let body: { confirm?: string } = {};
    try {
      body = (await request.json()) as { confirm?: string };
    } catch {
      return apiError("Invalid JSON body", 400);
    }

    if (body.confirm !== "RESTORE") {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "missing_confirmation", backupId: id },
      });
      return apiError(
        "Confirmation token missing — body must include confirm: 'RESTORE'",
        422,
      );
    }

    const backup = await prisma.dataBackup.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true } } },
    });
    if (!backup) {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "not_found", backupId: id },
      });
      throw new HttpError(404, "Backup not found");
    }

    let plaintext: string;
    try {
      plaintext = decrypt(backup.data);
    } catch (err) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: err instanceof Error ? err.message : "decrypt_failed",
        },
      });
      return apiError("Failed to decrypt backup payload", 500);
    }

    let payload;
    try {
      payload = parseBackupPayload(plaintext);
    } catch (err) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: "schema_invalid",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return apiError("Backup payload failed schema validation", 500);
    }

    // The target of the restore is whoever the backup is for, NOT the
    // admin running the operation. Make sure that user still exists —
    // an upload referencing a since-deleted user would otherwise leave
    // the operation half-done.
    const ownerId = payload.userId;
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, username: true },
    });
    if (!owner) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "owner_not_found",
        },
      });
      return apiError(
        `Backup owner '${ownerId}' no longer exists in this DB`,
        422,
      );
    }

    // Audit the *intent* before the transaction begins so the trail
    // describing "an admin is about to restore <user>" survives even
    // if the operation crashes midway.
    await auditLog("admin.backups.restore.start", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId,
        ownerUsername: owner.username,
        snapshotExportedAt: payload.exportedAt,
      },
    });

    // Pre-validate enum values OUTSIDE the transaction so a malformed
    // payload doesn't half-wipe the user before failing the create
    // step. Cheap up-front guard.
    for (const m of payload.measurements) {
      if (!MEASUREMENT_TYPES.has(m.type)) {
        await auditLog("admin.backups.restore.failed", {
          userId: admin.id,
          ipAddress: getClientIp(request),
          details: {
            backupId: id,
            ownerId,
            reason: "unknown_measurement_type",
            type: m.type,
          },
        });
        return apiError(`Unknown measurement type in backup: '${m.type}'`, 422);
      }
      if (m.source && !MEASUREMENT_SOURCES.has(m.source)) {
        await auditLog("admin.backups.restore.failed", {
          userId: admin.id,
          ipAddress: getClientIp(request),
          details: {
            backupId: id,
            ownerId,
            reason: "unknown_measurement_source",
            source: m.source,
          },
        });
        return apiError(
          `Unknown measurement source in backup: '${m.source}'`,
          422,
        );
      }
    }
    for (const e of payload.intakeEvents) {
      if (e.source && !INTAKE_SOURCES.has(e.source)) {
        await auditLog("admin.backups.restore.failed", {
          userId: admin.id,
          ipAddress: getClientIp(request),
          details: {
            backupId: id,
            ownerId,
            reason: "unknown_intake_source",
            source: e.source,
          },
        });
        return apiError(`Unknown intake source in backup: '${e.source}'`, 422);
      }
    }

    let cleared: RestoreResponse["cleared"];
    try {
      cleared = await prisma.$transaction(async (tx) => {
        // ── delete-then-recreate, mirroring the wipe scope plus mood ──
        // Order matters: child rows first (intake events / schedules
        // cascade via FK, but we delete them explicitly to capture the
        // count for the audit trail). Telegram-reminder messages cascade
        // off `medication`, so the medication delete sweeps them.
        const intake = await tx.medicationIntakeEvent.deleteMany({
          where: { userId: ownerId },
        });
        const meds = await tx.medication.deleteMany({
          where: { userId: ownerId },
        });
        const measurements = await tx.measurement.deleteMany({
          where: { userId: ownerId },
        });
        const moods = await tx.moodEntry.deleteMany({
          where: { userId: ownerId },
        });
        // v1.4.39 W-MOOD — wipe the persisted mood rollup partition
        // for this owner so the next analytics read doesn't surface
        // pre-restore daily means. The fold below mints fresh rows
        // from the restored mood entries.
        await tx.moodEntryRollup.deleteMany({ where: { userId: ownerId } });
        // v1.4.39.1 — wipe the persisted measurement rollup partition
        // for the same reason. Pre-fix the partition kept the previous
        // owner's daily means even after the underlying measurements
        // were replaced — the chart's `source=rollup` fast-path could
        // surface a stale 30-day mean built from rows that no longer
        // existed. The fold below mints fresh rows from the restored
        // measurement set.
        await tx.measurementRollup.deleteMany({ where: { userId: ownerId } });
        const channels = await tx.notificationChannel.deleteMany({
          where: { userId: ownerId },
        });
        const subs = await tx.pushSubscription.deleteMany({
          where: { userId: ownerId },
        });
        const tgDel = await tx.telegramScheduledDeletion.deleteMany({
          where: { userId: ownerId },
        });

        // ── re-create from payload ──
        if (payload.measurements.length > 0) {
          await tx.measurement.createMany({
            data: payload.measurements.map((m) => ({
              userId: ownerId,
              type: m.type as never, // already enum-validated above
              value: m.value,
              unit: m.unit,
              source: (m.source ?? "MANUAL") as never,
              measuredAt: new Date(m.measuredAt),
              notes: m.notes ?? null,
            })),
            // Backups can replay the same data — the unique
            // (userId, type, measuredAt, source) constraint catches
            // accidental dupes. `skipDuplicates` keeps the restore
            // idempotent across retries instead of throwing.
            skipDuplicates: true,
          });
        }

        // Medications + schedules — restore one at a time so we can
        // wire schedules to their parent's freshly-generated id, AND
        // build a name → id map for the intake events that follow.
        const medByName = new Map<string, string>();
        for (const m of payload.medications) {
          const created = await tx.medication.create({
            data: {
              userId: ownerId,
              name: m.name,
              dose: m.dose,
              active: m.active ?? true,
              schedules: {
                create: m.schedules.map((s) => ({
                  windowStart: s.windowStart,
                  windowEnd: s.windowEnd,
                  label: s.label ?? null,
                  dose: s.dose ?? null,
                })),
              },
            },
          });
          // First write wins on duplicate names — keeps the round-trip
          // deterministic against the restore-from-our-own-download case.
          if (!medByName.has(m.name)) medByName.set(m.name, created.id);
        }

        // Intake events — only restore the ones whose `medication` name
        // resolved against a row we just created. Orphans (medications
        // that were deleted before the snapshot but still referenced by
        // intake events) are dropped silently — the alternative would
        // be an FK-violation crash, which is worse than a slightly
        // smaller history.
        if (payload.intakeEvents.length > 0) {
          const rows = payload.intakeEvents
            .map((e) => {
              const medId = medByName.get(e.medication);
              if (!medId) return null;
              return {
                userId: ownerId,
                medicationId: medId,
                scheduledFor: new Date(e.scheduledFor),
                takenAt: e.takenAt ? new Date(e.takenAt) : null,
                skipped: e.skipped ?? false,
                source: (e.source ?? "WEB") as never,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (rows.length > 0) {
            await tx.medicationIntakeEvent.createMany({ data: rows });
          }
        }

        if (payload.moodEntries.length > 0) {
          await tx.moodEntry.createMany({
            data: payload.moodEntries.map((e) => ({
              userId: ownerId,
              date: e.date,
              mood: e.mood,
              score: e.score,
              tags: e.tags ?? null,
              source: e.source ?? "MOODLOG",
              moodLoggedAt: new Date(e.loggedAt),
            })),
            skipDuplicates: true,
          });
        }

        return {
          measurements: measurements.count,
          medications: meds.count,
          intakeEvents: intake.count,
          moodEntries: moods.count,
          notificationChannels: channels.count,
          pushSubscriptions: subs.count,
          telegramScheduledDeletions: tgDel.count,
        };
      });
    } catch (err) {
      // Scrub the raw Prisma / driver error from the wire response —
      // even on an admin endpoint, leaking column names, constraint
      // names or query fragments lowers the cost of a future supply-
      // chain attack against this surface. The verbose text still
      // lands in the audit row (admin-readable) and the Wide Event
      // (operator-readable), so root-cause investigation is unaffected.
      const verbose = err instanceof Error ? err.message : String(err);
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "transaction_failed",
          message: verbose,
        },
      });
      annotate({ meta: { restoreFailReason: verbose } });
      return apiError("Restore failed", 500);
    }

    // v1.4.39.1 — re-fold the persistent measurement rollup tier from
    // the just-restored measurements. Pre-fix the restore left the
    // rollup table empty for the owner, so the dashboard chart's
    // `source=rollup` fast-path silently returned zero buckets until
    // the next worker boot ran the backfill discovery — multi-hour
    // window of empty charts for the operator-restored account. Runs
    // outside the transaction (the 5-year fold would otherwise hold a
    // long write lock) and is best-effort so a populator hiccup never
    // undoes the restore. The boot-time backfill is the safety net.
    if (payload.measurements.length > 0) {
      try {
        await recomputeUserRollups(ownerId);
      } catch (err) {
        annotate({
          meta: {
            measurement_rollup_restore_failed: true,
            measurement_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // v1.4.39 W-MOOD — re-fold the mood rollup tier from the just-
    // restored entries. Runs outside the transaction so the (5-year)
    // fold can't hold a long write lock; best-effort so a populator
    // hiccup doesn't undo the restore. The boot-time backfill is the
    // safety net — if this fails the next worker boot mints the rows.
    if (payload.moodEntries.length > 0) {
      try {
        await recomputeUserMoodRollups(ownerId, { granularities: ["DAY"] });
      } catch (err) {
        annotate({
          meta: {
            mood_rollup_restore_failed: true,
            mood_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // v1.4.39 W-MED — re-fold the medication-compliance rollup tier
    // from the restored intake events. The medication delete inside the
    // transaction already cascaded the existing rollup partition for
    // this owner via the FK, so the fold mints fresh rows. Boot-time
    // backfill is the safety net if this best-effort call fails.
    if (payload.intakeEvents.length > 0) {
      try {
        const restoreUser = await prisma.user.findUnique({
          where: { id: ownerId },
          select: { timezone: true },
        });
        await recomputeUserMedicationCompliance(
          ownerId,
          MEDICATION_COMPLIANCE_BACKFILL_DAYS,
          restoreUser?.timezone ?? null,
        );
      } catch (err) {
        annotate({
          meta: {
            medication_compliance_rollup_restore_failed: true,
            medication_compliance_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    const summary = summarizeBackup(payload);

    await auditLog("admin.backups.restore", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId,
        ownerUsername: owner.username,
        cleared,
        restored: {
          measurements: summary.measurements,
          medications: summary.medications,
          intakeEvents: summary.intakeEvents,
          moodEntries: summary.moodEntries,
        },
      },
    });

    const response: RestoreResponse = {
      restored: true,
      summary,
      cleared,
    };
    return apiSuccess(response);
  },
);

// `withIdempotency` wraps the apiHandler so a duplicate retry with the
// same `Idempotency-Key` replays the original 200 instead of executing
// the destructive transaction twice. The default resolver picks up
// either the cookie session OR a Bearer token; for an admin endpoint
// only cookie sessions ever get past `requireAdmin()` upstream, but
// keeping the default keeps the contract uniform.
export const POST = withIdempotency(handler, async () => {
  return defaultUserIdResolver();
});
