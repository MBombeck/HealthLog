/**
 * v1.23 — shared builder for the user-scoped full-backup payload.
 *
 * Extracted so both the plaintext `GET /api/export/full-backup` route and the
 * passphrase-encrypted `POST /api/export/encrypted` route emit the byte-for-byte
 * same shape — the one that the pg-boss `data-backup` worker writes and that
 * `parseBackupPayload()` round-trips on admin restore. Keep this writer in sync
 * with the `data-backup` worker (`src/lib/jobs/reminder-worker.ts`).
 *
 * The decrypted notes are surfaced here (the backup is the human-readable
 * artefact); an admin restore re-encrypts them on re-insert.
 */
import { Buffer } from "node:buffer";
import type { PrismaClient } from "@/generated/prisma/client";
import { readNote } from "@/lib/crypto/note-cipher";
import { iterateMeasurementPages } from "@/lib/export/paged-measurements";
import { BACKUP_SCHEMA_VERSION } from "@/lib/validations/backup";
import { buildCycleBackupSection } from "@/lib/cycle/backup";
import {
  buildRecordsBackupSection,
  countRecordsBackupSection,
  type RecordsBackupCounts,
} from "@/lib/export/records-backup";

export interface FullBackupCounts extends RecordsBackupCounts {
  measurements: number;
  medications: number;
  intakeEvents: number;
  moodEntries: number;
  cycles: number;
  cycleDayLogs: number;
}

export interface FullBackupResult {
  payload: Record<string, unknown>;
  counts: FullBackupCounts;
}

export interface FullBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
  exportedAt?: Date;
}
/**
 * Build the canonical full-backup payload for `userId`. Portable exports omit
 * tombstones and document ciphertext; disaster-recovery payloads preserve
 * both so weekly and off-host snapshots share one restorable wire format.
 */
export async function buildFullBackupPayload(
  prisma: PrismaClient,
  userId: string,
  options: FullBackupOptions = {},
): Promise<FullBackupResult> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const [
    appSettings,
    measurements,
    medications,
    intakeEvents,
    moodEntries,
    cycle,
    records,
  ] = await Promise.all([
    disasterRecovery
      ? prisma.appSettings.findUnique({ where: { id: "singleton" } })
      : Promise.resolve(null),
    (async () => {
      const rows: Array<Record<string, unknown>> = [];
      const pages = iterateMeasurementPages(
        prisma,
        disasterRecovery ? { userId } : { userId, deletedAt: null },
        {
          id: true,
          type: true,
          value: true,
          valueMin: true,
          valueMax: true,
          unit: true,
          measuredAt: true,
          source: true,
          notes: true,
          notesEncrypted: true,
          externalId: true,
          externalSourceVersion: true,
          glucoseContext: true,
          sleepStage: true,
          rhythmClassification: true,
          deviceType: true,
          syncVersion: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      );
      for await (const page of pages) {
        for (const measurement of page) {
          rows.push(
            disasterRecovery
              ? {
                  id: measurement.id,
                  type: measurement.type,
                  value: measurement.value,
                  valueMin: measurement.valueMin,
                  valueMax: measurement.valueMax,
                  unit: measurement.unit,
                  measuredAt: measurement.measuredAt.toISOString(),
                  source: measurement.source,
                  notes: measurement.notes,
                  notesEncrypted: measurement.notesEncrypted
                    ? Buffer.from(measurement.notesEncrypted).toString("base64")
                    : null,
                  externalId: measurement.externalId,
                  externalSourceVersion: measurement.externalSourceVersion,
                  glucoseContext: measurement.glucoseContext,
                  sleepStage: measurement.sleepStage,
                  rhythmClassification: measurement.rhythmClassification,
                  deviceType: measurement.deviceType,
                  syncVersion: measurement.syncVersion,
                  deletedAt: measurement.deletedAt?.toISOString() ?? null,
                  createdAt: measurement.createdAt.toISOString(),
                  updatedAt: measurement.updatedAt.toISOString(),
                }
              : {
                  id: measurement.id,
                  type: measurement.type,
                  value: measurement.value,
                  unit: measurement.unit,
                  measuredAt: measurement.measuredAt.toISOString(),
                  source: measurement.source,
                  notes: readNote(
                    measurement.notesEncrypted,
                    measurement.notes,
                  ),
                  deletedAt: measurement.deletedAt?.toISOString() ?? null,
                },
          );
        }
      }
      return rows;
    })(),
    prisma.medication.findMany({
      where: { userId },
      include: { schedules: true },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      include: { medication: { select: { name: true } } },
      orderBy: { scheduledFor: "desc" },
    }),
    prisma.moodEntry.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { moodLoggedAt: "desc" },
      include: {
        tagLinks: {
          where: { rating: { not: null } },
          select: {
            rating: true,
            moodTag: { select: { key: true } },
          },
        },
      },
    }),
    buildCycleBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
    buildRecordsBackupSection(prisma, userId, {
      purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    }),
  ]);

  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: (options.exportedAt ?? new Date()).toISOString(),
    userId,
    appSettings:
      disasterRecovery && appSettings
        ? {
            ...appSettings,
            adminCodexTokenExpiresAt:
              appSettings.adminCodexTokenExpiresAt?.toISOString() ?? null,
            adminCodexConnectedAt:
              appSettings.adminCodexConnectedAt?.toISOString() ?? null,
            documentQuotaBytes: appSettings.documentQuotaBytes.toString(),
          }
        : null,
    measurements,
    medications: medications.map((m) => ({
      ...(disasterRecovery
        ? {
            id: m.id,
            treatmentClass: m.treatmentClass,
            dosesPerUnit: m.dosesPerUnit,
            unitsPerDose: m.unitsPerDose.toString(),
            notificationsEnabled: m.notificationsEnabled,
            pausedAt: m.pausedAt?.toISOString() ?? null,
            snoozedUntil: m.snoozedUntil?.toISOString() ?? null,
            startsOn: m.startsOn?.toISOString() ?? null,
            endsOn: m.endsOn?.toISOString() ?? null,
            oneShot: m.oneShot,
            asNeeded: m.asNeeded,
            deliveryForm: m.deliveryForm,
            trackInjectionSites: m.trackInjectionSites,
            allowedInjectionSites: m.allowedInjectionSites,
            liveActivityEnabled: m.liveActivityEnabled,
            criticalAlarmEnabled: m.criticalAlarmEnabled,
            atcCode: m.atcCode,
            rxNormCode: m.rxNormCode,
            lowStockNotifiedAt: m.lowStockNotifiedAt?.toISOString() ?? null,
            lowStockNotifiedThresholdDays: m.lowStockNotifiedThresholdDays,
            reorderLeadDays: m.reorderLeadDays,
            externalSource: m.externalSource,
            externalId: m.externalId,
            createdAt: m.createdAt.toISOString(),
            updatedAt: m.updatedAt.toISOString(),
          }
        : {}),
      name: m.name,
      dose: m.dose,
      active: m.active,
      schedules: m.schedules.map((s) => ({
        ...(disasterRecovery
          ? {
              id: s.id,
              daysOfWeek: s.daysOfWeek,
              timesOfDay: s.timesOfDay,
              reminderGraceMinutes: s.reminderGraceMinutes,
              rrule: s.rrule,
              rollingIntervalDays: s.rollingIntervalDays,
              scheduleType: s.scheduleType,
              cyclicOnWeeks: s.cyclicOnWeeks,
              cyclicOffWeeks: s.cyclicOffWeeks,
              doseWindows: s.doseWindows,
            }
          : {}),
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
        dose: s.dose,
      })),
    })),
    intakeEvents: intakeEvents.map((e) => ({
      ...(disasterRecovery
        ? {
            id: e.id,
            medicationId: e.medicationId,
            autoMissed: e.autoMissed,
            attributionSource: e.attributionSource,
            idempotencyKey: e.idempotencyKey,
            createdAt: e.createdAt.toISOString(),
            injectionSite: e.injectionSite,
            doseTaken: e.doseTaken,
            inventoryConsumption: e.inventoryConsumption,
            externalId: e.externalId,
            updatedAt: e.updatedAt.toISOString(),
            syncVersion: e.syncVersion,
            deletedAt: e.deletedAt?.toISOString() ?? null,
          }
        : {}),
      medication: e.medication.name,
      scheduledFor: e.scheduledFor.toISOString(),
      takenAt: e.takenAt?.toISOString() ?? null,
      skipped: e.skipped,
      source: e.source,
    })),
    moodEntries: moodEntries.map((e) => ({
      id: e.id,
      date: e.date,
      mood: e.mood,
      score: e.score,
      tags: e.tags,
      source: e.source,
      loggedAt: e.moodLoggedAt.toISOString(),
      externalId: e.externalId,
      deletedAt: e.deletedAt?.toISOString() ?? null,
      factors: e.tagLinks.map((link) => ({
        key: link.moodTag.key,
        rating: link.rating!,
      })),
    })),
    cycleProfile: cycle.cycleProfile,
    cycles: cycle.cycles,
    cycleDayLogs: cycle.cycleDayLogs,
    // v1.28 backup-completeness — the domains the pre-existing shape never
    // covered. `manifest` discloses the two deliberate exclusions (document
    // binaries, workout GPS/sample time series) inline in the file itself,
    // not just in the export UI copy.
    labResults: records.labResults,
    biomarkers: records.biomarkers,
    illnessEpisodes: records.illnessEpisodes,
    allergies: records.allergies,
    familyHistory: records.familyHistory,
    workouts: records.workouts,
    documents: records.documents,
    manifest: records.manifest,
  };

  return {
    payload,
    counts: {
      measurements: measurements.length,
      medications: medications.length,
      intakeEvents: intakeEvents.length,
      moodEntries: moodEntries.length,
      cycles: cycle.cycles.length,
      cycleDayLogs: cycle.cycleDayLogs.length,
      ...countRecordsBackupSection(records),
    },
  };
}
