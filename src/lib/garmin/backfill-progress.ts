/**
 * The `garminBackfillProgress` column: how far the Garmin history backfill
 * has got, carried from one slice to the next.
 *
 * Each resource is walked from the day the backfill began (`anchor`) back
 * toward the start of the account's history, one window at a time; after a
 * window is written its start becomes the resource's `before`, so a slice
 * that stops (its budget, a rate limit, a failed window) loses at most the
 * window it was in. The menstrual cycle is walked cycle by cycle instead, its
 * `before` being the day before the last cycle it read.
 *
 * Where history starts is learned: the daily summaries and the activities
 * are walked first, back to `GARMIN_HISTORY_FLOOR`, and the oldest day either
 * returned (`oldestSeen`) becomes `historyStart`. The other resources stop a
 * week before it, so an account with three years of history costs three
 * years of requests, not eighteen.
 *
 * Read leniently: a malformed entry is dropped and that resource starts over
 * from the anchor, which is safe because every write is keyed.
 */
import { z } from "zod";

/** Garmin Connect went live in 2008; nothing it holds is older. */
export const GARMIN_HISTORY_FLOOR = "2008-01-01";

export const GARMIN_BACKFILL_STEPS = [
  "daily",
  "activities",
  "sleep",
  "hrv",
  "weight",
  "cycle",
] as const;

export type GarminBackfillStep = (typeof GARMIN_BACKFILL_STEPS)[number];

export interface GarminBackfillStepState {
  /** Upper bound (YYYY-MM-DD) of the next window to read. */
  before: string;
  done?: boolean;
  windows?: number;
}

export interface GarminBackfillProgress {
  anchor: string;
  oldestSeen?: string;
  /** Learned once both probes are done; null when they found nothing. */
  historyStart?: string | null;
  steps: Partial<Record<GarminBackfillStep, GarminBackfillStepState>>;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const stateSchema = z.object({
  before: day,
  done: z.boolean().optional().catch(undefined),
  windows: z.number().int().min(0).optional().catch(undefined),
});

export function readGarminBackfillProgress(
  value: unknown,
): GarminBackfillProgress | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const anchor = day.safeParse(raw.anchor);
  if (!anchor.success) return null;
  const rawSteps =
    raw.steps && typeof raw.steps === "object"
      ? (raw.steps as Record<string, unknown>)
      : {};
  const steps: GarminBackfillProgress["steps"] = {};
  for (const name of GARMIN_BACKFILL_STEPS) {
    const parsed = stateSchema.safeParse(rawSteps[name]);
    if (!parsed.success) continue;
    steps[name] = {
      before: parsed.data.before,
      ...(parsed.data.done ? { done: true } : {}),
      ...(parsed.data.windows !== undefined
        ? { windows: parsed.data.windows }
        : {}),
    };
  }
  const oldestSeen = day.safeParse(raw.oldestSeen);
  const historyStart =
    raw.historyStart === null ? null : day.safeParse(raw.historyStart);
  return {
    anchor: anchor.data,
    ...(oldestSeen.success ? { oldestSeen: oldestSeen.data } : {}),
    ...(historyStart === null
      ? { historyStart: null }
      : historyStart.success
        ? { historyStart: historyStart.data }
        : {}),
    steps,
  };
}

export function garminBackfillProgressJson(progress: GarminBackfillProgress) {
  return {
    anchor: progress.anchor,
    ...(progress.oldestSeen ? { oldestSeen: progress.oldestSeen } : {}),
    ...(progress.historyStart !== undefined
      ? { historyStart: progress.historyStart }
      : {}),
    steps: Object.fromEntries(
      Object.entries(progress.steps).map(([name, s]) => [
        name,
        {
          before: s!.before,
          ...(s!.done ? { done: true } : {}),
          ...(s!.windows !== undefined ? { windows: s!.windows } : {}),
        },
      ]),
    ),
  };
}

/** Share of the walk done, 0..1, for the card's progress line. */
export function garminBackfillShare(
  progress: GarminBackfillProgress | null,
): number {
  if (!progress) return 0;
  const done = GARMIN_BACKFILL_STEPS.filter(
    (s) => progress.steps[s]?.done,
  ).length;
  return done / GARMIN_BACKFILL_STEPS.length;
}
