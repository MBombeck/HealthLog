/**
 * The one-time climb backfill for workouts stored with a track but no
 * elevation (`workouts/climb-backfill.ts`), started at boot and left to run
 * detached: it reads one track at a time with a pause between batches and
 * resumes from its cursor on the next boot, so it never holds the boot or the
 * heap. A finished pass returns at once.
 */
import { trackBackgroundTask } from "@/lib/logging/background-tasks";

import { workerLog } from "./shared";

export async function startClimbBackfill(): Promise<void> {
  trackBackgroundTask(
    (async () => {
      const [{ prisma }, { runWorkoutClimbBackfill }] = await Promise.all([
        import("@/lib/db"),
        import("@/lib/workouts/climb-backfill"),
      ]);
      const result = await runWorkoutClimbBackfill({ prisma });
      if (result.scanned > 0) {
        workerLog(
          "info",
          `[workout-climb-backfill] scanned=${result.scanned} filled=${result.filled} done=${result.done}`,
        );
      }
    })().catch((err) => {
      workerLog(
        "error",
        "[workout-climb-backfill] failed; the next boot resumes from the cursor",
        err,
      );
    }),
  );
}
