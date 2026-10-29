/**
 * The boot discovery of the maintenance group: the duplicate dose-slot
 * cleanup, the encryption backfills, the thumbnail backfill, the marked
 * document index retry, the air-quality history, the fold repair and the
 * purge that waits for it, the GeoLite2 fetch, and the detached climb
 * backfill. Each pass is idempotent across boots; the heavy ones start past
 * the boot storm.
 */
import { BOOT_BACKFILL_STAGGER_SECONDS } from "@/lib/jobs/reminder/shared";

import type { BootDiscovery } from "./define-job";

export const MAINTENANCE_DISCOVERY: readonly BootDiscovery[] = [
  {
    name: "intake-slot-dedup",
    run: async () =>
      (
        await import("@/lib/medications/intake-slot-dedup")
      ).enqueueBootTimeIntakeSlotDedup(),
  },
  // The heavy loads start after the boot storm; the daily ticks pass no
  // offset and stay immediate.
  {
    name: "note-encryption-backfill",
    run: async () =>
      (
        await import("@/lib/jobs/note-encryption-backfill")
      ).enqueueBootTimeNoteEncryptionBackfill(
        BOOT_BACKFILL_STAGGER_SECONDS * 5,
      ),
  },
  {
    name: "med-notes-encryption-backfill",
    run: async () =>
      (
        await import("@/lib/jobs/med-notes-encryption-backfill")
      ).enqueueBootTimeMedNotesEncryptionBackfill(),
  },
  {
    name: "free-text-encryption-backfill",
    run: async () =>
      (
        await import("@/lib/jobs/free-text-encryption-backfill")
      ).enqueueBootTimeFreeTextEncryptionBackfill(
        BOOT_BACKFILL_STAGGER_SECONDS * 6,
      ),
  },
  {
    name: "document-thumbnail-backfill",
    run: async () => {
      const { enqueued } = await (
        await import("@/lib/jobs/document-thumbnail-backfill")
      ).enqueueBootTimeThumbnailBackfill();
      return { enqueued };
    },
  },
  // Only the documents a migration marked; a boot with none costs one query.
  {
    name: "document-index-retry",
    run: async () =>
      (
        await import("@/lib/jobs/document-index-retry")
      ).enqueueBootTimeIndexRetry(),
  },
  {
    name: "environment-aq-history",
    run: async () =>
      (
        await import("@/lib/jobs/environment-air-quality-history")
      ).enqueueBootTimeAirQualityHistory(BOOT_BACKFILL_STAGGER_SECONDS * 7),
  },
  // Once per account; the purge below waits for it.
  {
    name: "measurement-fold-repair",
    run: async () =>
      (
        await import("@/lib/jobs/measurement-fold-repair")
      ).enqueueBootTimeMeasurementFoldRepair(),
  },
  // Converges to nothing once the misdated values are moved; a boot with
  // none costs one query.
  {
    name: "lab-document-date-repair",
    run: async () =>
      (
        await import("@/lib/jobs/lab-document-date-repair")
      ).enqueueBootTimeLabDocumentDateRepair(),
  },
  // Self-limiting and idempotent; a boot with no backlog costs one query.
  {
    name: "compaction-tombstone-purge",
    run: async () => {
      const { enqueued } = await (
        await import("@/lib/jobs/compaction-tombstone-purge")
      ).enqueueBootTimeCompactionTombstonePurge();
      return { enqueued };
    },
  },
  // Only with a MaxMind key, egress allowed and no offline database present.
  {
    name: "geolite2-fetch",
    run: async () => {
      const { enqueued } = await (
        await import("@/lib/jobs/geolite2-fetch")
      ).enqueueGeolite2FetchBootDiscovery();
      return { enqueued };
    },
  },
  // Detached: reads one track at a time with a pause between batches and
  // resumes from its cursor on the next boot; a finished pass returns at once.
  {
    name: "workout-climb-backfill",
    run: async () =>
      (
        await import("@/lib/jobs/reminder/climb-backfill-at-boot")
      ).startClimbBackfill(),
  },
];
