/**
 * Handlers of the three converging encryption backfills: the mood and
 * measurement notes, the medication notes, and the remaining free text (Coach
 * titles, custom-metric notes, practitioner contacts, workout tracks). A job
 * with a `userId` migrates that account; the daily tick (no `userId`) re-runs
 * the boot discovery and fans out one job per account still holding a
 * readable value. The registry binds them (`registry/maintenance.ts`).
 */
import type { Job } from "pg-boss";

import {
  enqueueBootTimeFreeTextEncryptionBackfill,
  runFreeTextEncryptionBackfillForUser,
  type FreeTextEncryptionBackfillPayload,
} from "@/lib/jobs/free-text-encryption-backfill";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  enqueueBootTimeMedNotesEncryptionBackfill,
  runMedNotesEncryptionBackfillForUser,
  type MedNotesEncryptionBackfillPayload,
} from "@/lib/jobs/med-notes-encryption-backfill";
import {
  enqueueBootTimeNoteEncryptionBackfill,
  runNoteEncryptionBackfillForUser,
  type NoteEncryptionBackfillPayload,
} from "@/lib/jobs/note-encryption-backfill";
import { recordError } from "@/lib/jobs/worker-status";

import { workerLog } from "./shared";

export async function handleNoteEncryptionBackfill(
  jobs: Job<Partial<NoteEncryptionBackfillPayload>>[],
): Promise<JobOutcome> {
  let users = 0;
  let discoveryEnqueued = 0;
  let discoverySkipped = 0;
  // The discovery helper returns its error instead of throwing, so a failed
  // fan-out would otherwise leave no trace on the job at all.
  let discoveryFailed = 0;
  let measurements = 0;
  let moodEntries = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    if (!userId) {
      const result = await enqueueBootTimeNoteEncryptionBackfill();
      discoveryEnqueued += result.enqueued;
      discoverySkipped += result.skipped;
      if (result.error) discoveryFailed++;
      workerLog(
        "info",
        `[note-encryption-backfill] daily discovery enqueued=${result.enqueued} skipped=${result.skipped}${result.error ? ` error=${result.error}` : ""}`,
      );
      continue;
    }
    try {
      const { measurementsMigrated, moodEntriesMigrated } =
        await runNoteEncryptionBackfillForUser(userId);
      users++;
      measurements += measurementsMigrated;
      moodEntries += moodEntriesMigrated;
      workerLog(
        "info",
        `[note-encryption-backfill] user=${userId} measurements=${measurementsMigrated} moodEntries=${moodEntriesMigrated}`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[note-encryption-backfill] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    jobs: jobs.length,
    users,
    discovery_enqueued: discoveryEnqueued,
    discovery_skipped: discoverySkipped,
    discovery_failed: discoveryFailed,
    measurements_migrated: measurements,
    mood_entries_migrated: moodEntries,
  });
}

export async function handleMedNotesEncryptionBackfill(
  jobs: Job<Partial<MedNotesEncryptionBackfillPayload>>[],
): Promise<JobOutcome> {
  let users = 0;
  let discoveryEnqueued = 0;
  let discoverySkipped = 0;
  let discoveryFailed = 0;
  let sideEffects = 0;
  let doseChanges = 0;
  let inventoryItems = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    if (!userId) {
      const result = await enqueueBootTimeMedNotesEncryptionBackfill();
      discoveryEnqueued += result.enqueued;
      discoverySkipped += result.skipped;
      if (result.error) discoveryFailed++;
      workerLog(
        "info",
        `[med-notes-encryption-backfill] daily discovery enqueued=${result.enqueued} skipped=${result.skipped}${result.error ? ` error=${result.error}` : ""}`,
      );
      continue;
    }
    try {
      const {
        sideEffectsMigrated,
        doseChangesMigrated,
        inventoryItemsMigrated,
      } = await runMedNotesEncryptionBackfillForUser(userId);
      users++;
      sideEffects += sideEffectsMigrated;
      doseChanges += doseChangesMigrated;
      inventoryItems += inventoryItemsMigrated;
      workerLog(
        "info",
        `[med-notes-encryption-backfill] user=${userId} sideEffects=${sideEffectsMigrated} doseChanges=${doseChangesMigrated} inventoryItems=${inventoryItemsMigrated}`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[med-notes-encryption-backfill] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    jobs: jobs.length,
    users,
    discovery_enqueued: discoveryEnqueued,
    discovery_skipped: discoverySkipped,
    discovery_failed: discoveryFailed,
    side_effects_migrated: sideEffects,
    dose_changes_migrated: doseChanges,
    inventory_items_migrated: inventoryItems,
  });
}

export async function handleFreeTextEncryptionBackfill(
  jobs: Job<Partial<FreeTextEncryptionBackfillPayload>>[],
): Promise<JobOutcome> {
  let users = 0;
  let discoveryEnqueued = 0;
  let discoverySkipped = 0;
  let discoveryFailed = 0;
  let titles = 0;
  let notes = 0;
  let contacts = 0;
  let routes = 0;
  let appointmentAddresses = 0;
  let contactAudits = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    if (!userId) {
      const result = await enqueueBootTimeFreeTextEncryptionBackfill();
      discoveryEnqueued += result.enqueued;
      discoverySkipped += result.skipped;
      if (result.error) discoveryFailed++;
      workerLog(
        "info",
        `[free-text-encryption-backfill] daily discovery enqueued=${result.enqueued} skipped=${result.skipped}${result.error ? ` error=${result.error}` : ""}`,
      );
      continue;
    }
    try {
      const {
        conversationTitlesMigrated,
        metricNotesMigrated,
        practitionerContactsMigrated,
        routeGeometriesMigrated,
        appointmentAddressesCleared,
        contactAuditRowsScrubbed,
      } = await runFreeTextEncryptionBackfillForUser(userId);
      users++;
      titles += conversationTitlesMigrated;
      notes += metricNotesMigrated;
      contacts += practitionerContactsMigrated;
      routes += routeGeometriesMigrated;
      appointmentAddresses += appointmentAddressesCleared;
      contactAudits += contactAuditRowsScrubbed;
      workerLog(
        "info",
        `[free-text-encryption-backfill] user=${userId} titles=${conversationTitlesMigrated} notes=${metricNotesMigrated} contacts=${practitionerContactsMigrated} routes=${routeGeometriesMigrated} appointment_addresses=${appointmentAddressesCleared} contact_audits=${contactAuditRowsScrubbed}`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[free-text-encryption-backfill] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    jobs: jobs.length,
    users,
    discovery_enqueued: discoveryEnqueued,
    discovery_skipped: discoverySkipped,
    discovery_failed: discoveryFailed,
    conversation_titles_migrated: titles,
    metric_notes_migrated: notes,
    practitioner_contacts_migrated: contacts,
    route_geometries_migrated: routes,
    appointment_addresses_cleared: appointmentAddresses,
    contact_audit_rows_scrubbed: contactAudits,
  });
}
