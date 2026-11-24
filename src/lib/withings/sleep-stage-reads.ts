/**
 * What the Withings sleep sync learned reading each night's stage timeline,
 * kept on `WithingsConnection.sleepStageReads`.
 *
 * Two facts per night, keyed by its unix span (`"<start>:<end>"`):
 *
 *   - `empty`: reads that answered without a single stage. A tracker that
 *     never stages a night (a nap, a watch without stages) used to be read
 *     again on every run for as long as the night stayed in the 30-day
 *     window. After {@link SLEEP_STAGE_MAX_EMPTY_READS} such answers it is
 *     no longer read, except by a full sync or while Withings marks it
 *     changed.
 *   - `failed`: the night's last read errored. It is read first next run.
 *   - `failures`: reads that errored. A night Withings answers with an error
 *     every time is given up after {@link SLEEP_STAGE_MAX_FAILED_READS} of
 *     them, like an unstaged one: otherwise it held the failed-first slot and
 *     failed the leg on every run for as long as it stayed in the window.
 *
 * Versioned and validated on read: anything that is not the current shape
 * reads as no record at all, which is the behaviour before the record
 * existed.
 */

export const SLEEP_STAGE_MAX_EMPTY_READS = 3;
export const SLEEP_STAGE_MAX_FAILED_READS = 3;

export interface SleepStageNightRecord {
  empty: number;
  failed: boolean;
  failures: number;
}

/** A night the sync no longer reads outside a full sync. */
export function isSleepNightGivenUp(
  night: SleepStageNightRecord | undefined,
): boolean {
  return (
    night !== undefined &&
    (night.empty >= SLEEP_STAGE_MAX_EMPTY_READS ||
      night.failures >= SLEEP_STAGE_MAX_FAILED_READS)
  );
}

export type SleepStageReads = Map<string, SleepStageNightRecord>;

export function sleepNightKey(night: {
  startdate: number;
  enddate: number;
}): string {
  return `${night.startdate}:${night.enddate}`;
}

export function parseSleepStageReads(raw: unknown): SleepStageReads {
  const out: SleepStageReads = new Map();
  if (raw === null || typeof raw !== "object") return out;
  const record = raw as { v?: unknown; nights?: unknown };
  if (record.v !== 1) return out;
  if (record.nights === null || typeof record.nights !== "object") return out;
  for (const [key, value] of Object.entries(record.nights)) {
    if (!/^\d+:\d+$/.test(key)) continue;
    if (value === null || typeof value !== "object") continue;
    const { empty, failed, failures } = value as {
      empty?: unknown;
      failed?: unknown;
      failures?: unknown;
    };
    const count = (n: unknown) =>
      typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
    out.set(key, {
      empty: count(empty),
      failed: failed === true,
      failures: count(failures),
    });
  }
  return out;
}

type SerialisedNight = { empty: number; failed?: true; failures?: number };

export function serialiseSleepStageReads(reads: SleepStageReads): {
  v: 1;
  nights: Record<string, SerialisedNight>;
} {
  const nights: [string, SerialisedNight][] = [];
  for (const [key, night] of reads) {
    if (night.empty === 0 && !night.failed && night.failures === 0) continue;
    const out: SerialisedNight = { empty: night.empty };
    if (night.failed) out.failed = true;
    if (night.failures > 0) out.failures = night.failures;
    nights.push([key, out]);
  }
  return { v: 1, nights: Object.fromEntries(nights) };
}

/** The outcome of one night's read in this run. */
export type SleepStageReadOutcome = "staged" | "empty" | "failed";

/**
 * The record after this run: each read night's outcome applied, and every
 * night that is no longer in the summary window dropped.
 */
export function nextSleepStageReads(
  previous: SleepStageReads,
  outcomes: ReadonlyMap<string, SleepStageReadOutcome>,
  windowNightKeys: ReadonlySet<string>,
): SleepStageReads {
  const next: SleepStageReads = new Map();
  for (const [key, night] of previous) {
    if (windowNightKeys.has(key)) next.set(key, { ...night });
  }
  for (const [key, outcome] of outcomes) {
    const prior = next.get(key) ?? { empty: 0, failed: false, failures: 0 };
    if (outcome === "staged") next.delete(key);
    else if (outcome === "failed") {
      next.set(key, {
        ...prior,
        failed: true,
        failures: prior.failures + 1,
      });
    } else next.set(key, { ...prior, empty: prior.empty + 1, failed: false });
  }
  return next;
}
