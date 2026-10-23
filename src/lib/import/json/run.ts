/**
 * One JSON import (`POST /api/import`): the measurement rows, then the mood
 * rows, then the rollup and status tails, the wide event and the audit row.
 * Deduplicates via unique constraints: existing records are skipped or, with
 * an external id, updated in place.
 */
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { unstableExternalIdMeta } from "@/lib/validations/external-id";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import type { DroppedLinkKeys } from "@/lib/mood/tag-links";

import {
  importJsonMeasurements,
  type JsonImportMeasurement,
} from "./measurements";
import { importJsonMoodEntries, type JsonImportMoodEntry } from "./mood";
import { newJsonImportTally, type JsonImportTally } from "./tally";

export async function runJsonImport(input: {
  userId: string;
  measurements: JsonImportMeasurement[] | undefined;
  moodEntries: JsonImportMoodEntry[] | undefined;
  ipAddress: string | null;
}): Promise<
  Pick<JsonImportTally, "stats" | "writeFailed"> & {
    droppedLinkKeys: DroppedLinkKeys;
  }
> {
  const { userId } = input;
  const tally = newJsonImportTally();

  const written = input.measurements?.length
    ? await importJsonMeasurements(userId, input.measurements, tally)
    : { touched: [], inserted: [] };

  void emitInsertedMeasurementArrivals(
    userId,
    written.inserted,
    "json_import",
  ).catch(() => {});
  void maybeEnqueueMorningRefresh(
    userId,
    written.inserted
      .filter((row) => row.type === "SLEEP_DURATION")
      .map((row) => row.measuredAt),
  ).catch(() => {});

  if (!tally.writeFailed && input.moodEntries?.length) {
    await importJsonMoodEntries(userId, input.moodEntries, tally);
  }

  // One bounded re-fold per import is cheaper than firing N per-row hooks.
  // The mood rollup tier is keyed on the user + day; the fold materialises
  // every touched day from the entries just written. Best-effort: an
  // importer hiccup must not surface as a 5xx, the rollup is a cache tier.
  if (tally.stats.moodEntries > 0) {
    try {
      await recomputeUserMoodRollups(userId, { granularities: ["DAY"] });
    } catch (err) {
      annotate({
        meta: {
          mood_rollup_import_failed: true,
          mood_rollup_import_error:
            err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // Refresh the persistent measurement rollup table for every distinct
  // (type, day) the import touched (collapsed, so a 10 000-row restore pays
  // at most ~N recomputes) and re-warm the touched types' status
  // assessments. Best-effort: a populator hiccup never fails the importer.
  await afterMeasurementMutation(userId, written.touched, {
    // A file the person chose to import: a deliberate act, narrated like a
    // hand entry rather than held to the sync gap.
    source: "manual",
    label: "import",
  });

  annotate({
    meta: {
      import_stats: tally.stats,
      import_dropped_link_keys:
        tally.droppedTagKeys.size + tally.droppedFactorKeys.size,
      ...(tally.unstableShapes.length > 0
        ? unstableExternalIdMeta("import.json", tally.unstableShapes)
        : {}),
    },
  });

  try {
    await auditLog("import.upload", {
      userId,
      ipAddress: input.ipAddress,
      details: tally.stats,
    });
  } catch (err) {
    if (!tally.writeFailed) throw err;
    annotate({ meta: { import_audit_failed: true } });
  }

  return {
    stats: tally.stats,
    writeFailed: tally.writeFailed,
    droppedLinkKeys: {
      droppedTagKeys: [...tally.droppedTagKeys].sort(),
      droppedFactorKeys: [...tally.droppedFactorKeys].sort(),
    },
  };
}
