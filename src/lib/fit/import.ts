/**
 * One activity file, from its uploaded bytes to stored workouts.
 *
 *   unwrap   `.fit`, `.fit.gz` or the one-member ZIP (`./container.ts`)
 *   decode   structural scan with caps and both checksums, then the decoder
 *            in strict-checksum mode (`./parse.ts`)
 *   map      sessions, record series and, on opt-in, the GPS track
 *            (`./map.ts`)
 *   check    every workout through the batch schema (`createWorkoutSchema`),
 *            the same gate a phone's workout passes
 *   write    the shared workout ingest with `twins: "adopt"`: a session
 *            already stored from another source (Garmin, Apple Health,
 *            Strava, an earlier file of the same ride) gains the file's
 *            series and track instead of being stored twice
 *
 * Rows are written under `source = IMPORT` with the external id
 * `fit:<sha-256 of the FIT bytes, 40 hex>:<session start, epoch s>`, so the
 * same file imported again, bare or zipped, is recognised by its own key and
 * changes nothing.
 */
import { createHash } from "node:crypto";

import { prisma } from "@/lib/db";
import {
  ingestWorkoutBatch,
  type WorkoutBatchResult,
} from "@/lib/workouts/batch-ingest/ingest";
import type { WorkoutEntry } from "@/lib/workouts/batch-ingest/entries";
import { createWorkoutSchema } from "@/lib/validations/workout";

import { unwrapFitUpload, type FitContainer } from "./container";
import { mapFitActivity, type FitWorkoutDraft } from "./map";
import { decodeFitFile } from "./parse";

/** The audit action of a FIT import's workout write. */
export const FIT_IMPORT_AUDIT_ACTION = "workout.fit.import";

/** What the import card shows. Counts only, never a value from the file. */
export interface FitImportResult {
  container: FitContainer;
  /** Sessions in the file that became a workout entry. */
  sessions: number;
  /** Sessions that could not be read (no start, no duration, a bad value). */
  sessionsSkipped: number;
  /** New workouts stored. */
  imported: number;
  /** Stored workouts that gained the file's series or track. */
  merged: number;
  /** Sessions already stored with everything the file adds. */
  alreadyPresent: number;
  /** Sessions with a heart-rate, speed, power or cadence series. */
  withSeries: number;
  /** Sessions with a GPS track that the account keeps. */
  withRoute: number;
}

export function fitExternalId(
  fitSha256: string,
  sessionStartMs: number,
): string {
  return `fit:${fitSha256.slice(0, 40)}:${Math.floor(sessionStartMs / 1000)}`;
}

/**
 * Validate the drafts through the workout schema. A draft the schema refuses
 * is dropped and counted; the map has already range-checked every field, so
 * this is the gate that keeps the FIT path from ever storing what the batch
 * route would not.
 */
export function validateFitDrafts(drafts: readonly FitWorkoutDraft[]): {
  entries: WorkoutEntry[];
  invalid: number;
} {
  const entries: WorkoutEntry[] = [];
  let invalid = 0;
  for (const draft of drafts) {
    const parsed = createWorkoutSchema.safeParse(draft);
    if (parsed.success) entries.push(parsed.data);
    else invalid += 1;
  }
  return { entries, invalid };
}

function countStatuses(result: WorkoutBatchResult) {
  let imported = 0;
  let merged = 0;
  let alreadyPresent = 0;
  for (const entry of result.entries) {
    if (!entry) continue;
    if (entry.status === "inserted") imported += 1;
    else if (entry.status === "enriched") merged += 1;
    else if (entry.status === "duplicate" || entry.status === "updated") {
      alreadyPresent += 1;
    }
  }
  return { imported, merged, alreadyPresent };
}

export async function importFitUpload(input: {
  userId: string;
  upload: Buffer;
  now?: Date;
}): Promise<FitImportResult> {
  const { fit, container } = unwrapFitUpload(input.upload);
  const { decoded } = await decodeFitFile(fit);
  const sha = createHash("sha256").update(fit).digest("hex");

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { sourcePriorityJson: true, storeWorkoutRoutes: true },
  });
  const keepRoutes = user?.storeWorkoutRoutes === true;

  const mapped = mapFitActivity(decoded, {
    externalIdFor: (startMs) => fitExternalId(sha, startMs),
    keepRoutes,
    now: input.now,
  });
  const { entries, invalid } = validateFitDrafts(mapped.drafts);
  const base = {
    container,
    sessions: entries.length,
    sessionsSkipped: mapped.sessionsSkipped + invalid,
    withSeries: entries.filter((e) => e.samples).length,
    withRoute: entries.filter((e) => e.route).length,
  };
  if (entries.length === 0) {
    return { ...base, imported: 0, merged: 0, alreadyPresent: 0 };
  }

  const result = await ingestWorkoutBatch({
    userId: input.userId,
    scoped: false,
    keepRoutes,
    sourcePriorityJson: user?.sourcePriorityJson ?? null,
    workouts: entries,
    refusedSampleIndices: new Set(),
    ipAddress: null,
    sourceOverride: "IMPORT",
    twins: "adopt",
    auditAction: FIT_IMPORT_AUDIT_ACTION,
  });
  return { ...base, ...countStatuses(result) };
}
