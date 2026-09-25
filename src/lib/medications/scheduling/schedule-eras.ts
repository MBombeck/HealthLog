/**
 * v1.16.3 — schedule-era segmentation (effective dating).
 *
 * A wholesale schedule replace used to rewrite history: bands for PAST days
 * were minted from the CURRENT `medication_schedules` rows, so after a
 * times edit the whole old era read "missed at the new times". The write
 * path now archives each superseded schedule state as one
 * `MedicationScheduleRevision` row covering `[validFrom, validUntil)`; this
 * module turns those revisions into minting eras so every historical
 * surface (dose-history ledger, compliance tally, expected-slot counts,
 * write/edit attribution) reads a past day against the schedule that was
 * live THEN.
 *
 * Era rules:
 *   - revisions are chained: `validFrom` = previous revision's `validUntil`
 *     (or `medication.createdAt` for the first), `validUntil` = the replace
 *     instant. The LIVE rows cover `[newest validUntil, ∞)`. The first era
 *     also covers any range before its `validFrom`, so a pre-creation slot
 *     mints against the schedule that was live first.
 *   - boundary: a slot belongs to the era its ANCHOR lies in. Eras mint
 *     with an inclusive sub-range capped 1 ms short of `validUntil`, so an
 *     anchor exactly at the boundary mints in the NEXT era only. On-time /
 *     late tails are NOT clipped — a band minted near the end of an era
 *     keeps its full reach past the boundary.
 *   - `startsOn` stays the global floor for all eras (the engine applies
 *     it per occurrence); a times-only edit never moves it.
 *
 * Pure / synchronous like the band minter: revisions are pre-fetched by the
 * caller and threaded in — no DB access here.
 */
import {
  buildBandsForSchedules,
  type BandMinterMedication,
  type DoseWindowConfig,
  type ScheduleBandGroup,
} from "@/lib/medications/scheduling/band-minter";
import {
  SCHEDULE_TYPES,
  type CanonicalSchedule,
  type Occurrence,
  type RecurrenceContext,
  type ScheduleType,
} from "@/lib/medications/scheduling/recurrence";
import { normaliseDoseWindows } from "@/lib/medications/scheduling/worker-helpers";

/** The revision projection the era splitter reads (a Prisma row drops in). */
export interface ScheduleRevisionLike {
  id: string;
  /** Inclusive start of the archived era. */
  validFrom: Date;
  /** Exclusive end of the archived era (the replace instant). */
  validUntil: Date;
  /** JSON array of {@link ScheduleRevisionEntry} snapshots. */
  payload: unknown;
  /**
   * v1.16.6 — set when a correction replaced this era (the id of the
   * superseding MANUAL revision). A superseded row is an audit record,
   * not an era: the splitter skips it. Optional so pre-existing
   * callers/tests that thread plain `{id, validFrom, validUntil,
   * payload}` projections keep compiling — absent means active.
   */
  supersededByRevisionId?: string | null;
}

/**
 * One archived schedule row inside a revision's `payload` array. The write
 * path snapshots every cadence-relevant column so the era splitter can
 * rebuild a full `CanonicalSchedule`; `label` / `dose` ride along for
 * display-only consumers but never participate in the material-change
 * compare.
 */
export interface ScheduleRevisionEntry {
  timesOfDay: string[];
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  rrule: string | null;
  rollingIntervalDays: number | null;
  scheduleType: ScheduleType;
  cyclicOnWeeks: number | null;
  cyclicOffWeeks: number | null;
  doseWindows: unknown;
  label: string | null;
  dose: string | null;
  reminderGraceMinutes: number | null;
}

/** One minting era: an inclusive `[from, to]` sub-range + its schedules. */
export interface ScheduleEra {
  from: Date;
  to: Date;
  schedules: CanonicalSchedule[];
  /** True for the era backed by the live `medication_schedules` rows. */
  live: boolean;
}

/**
 * Rebuild the `CanonicalSchedule` list a revision archived. Synthetic ids
 * (`rev:<revisionId>:<idx>`) keep the engine occurrence/group plumbing
 * stable without colliding with live schedule ids. Defensive parsing: a
 * malformed payload entry degrades to an empty/cadence-less schedule the
 * band minter already treats as "no slot machinery" rather than throwing
 * on a read path.
 */
export function canonicalSchedulesFromRevision(
  revision: ScheduleRevisionLike,
  options?: { oneShot?: boolean },
): CanonicalSchedule[] {
  if (!Array.isArray(revision.payload)) return [];
  return revision.payload.map((raw, idx) => {
    const e = (raw ?? {}) as Partial<ScheduleRevisionEntry>;
    const base: CanonicalSchedule = {
      id: `rev:${revision.id}:${idx}`,
      rrule: typeof e.rrule === "string" ? e.rrule : null,
      rollingIntervalDays:
        typeof e.rollingIntervalDays === "number"
          ? e.rollingIntervalDays
          : null,
      timesOfDay: Array.isArray(e.timesOfDay)
        ? e.timesOfDay.filter((t): t is string => typeof t === "string")
        : [],
      daysOfWeek: typeof e.daysOfWeek === "string" ? e.daysOfWeek : null,
      windowStart: typeof e.windowStart === "string" ? e.windowStart : "08:00",
      windowEnd: typeof e.windowEnd === "string" ? e.windowEnd : "08:00",
      reminderGraceMinutes:
        typeof e.reminderGraceMinutes === "number"
          ? e.reminderGraceMinutes
          : null,
      scheduleType: SCHEDULE_TYPES.includes(e.scheduleType as ScheduleType)
        ? (e.scheduleType as ScheduleType)
        : "SCHEDULED",
      cyclicOnWeeks:
        typeof e.cyclicOnWeeks === "number" ? e.cyclicOnWeeks : null,
      cyclicOffWeeks:
        typeof e.cyclicOffWeeks === "number" ? e.cyclicOffWeeks : null,
      doseWindows: normaliseDoseWindows(e.doseWindows),
    };
    // A legacy daily row carrying only `windowStart` surfaces it as the
    // single time-of-day so the minter mints its daily band — the same
    // normalisation every band-building consumer applies to live rows.
    if (
      base.timesOfDay.length === 0 &&
      base.rrule === null &&
      base.rollingIntervalDays === null &&
      base.scheduleType !== "PRN" &&
      options?.oneShot !== true
    ) {
      return { ...base, timesOfDay: [base.windowStart] };
    }
    return base;
  });
}

/**
 * Segment an inclusive minting `range` into eras. Each revision interval
 * that intersects the range contributes one era with ITS archived
 * schedules; the remainder (from the newest `validUntil` onward) is the
 * live era. Eras are returned chronologically; an empty intersection is
 * dropped. With no revisions the result is a single live era covering the
 * whole range — the zero-revision path is byte-equivalent to not
 * segmenting at all.
 */
export function segmentRangeIntoEras(
  range: { from: Date; to: Date },
  revisions: ScheduleRevisionLike[],
  liveSchedules: CanonicalSchedule[],
  options?: { oneShot?: boolean },
): ScheduleEra[] {
  const eras: ScheduleEra[] = [];
  // Superseded rows are audit records, not eras — a correction took
  // their place. Skipping them here covers every era consumer (band
  // minting, occurrence counts) in one spot.
  const sorted = revisions
    .filter((r) => r.supersededByRevisionId == null)
    .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  for (const [index, revision] of sorted.entries()) {
    // The earliest era also covers the time before its `validFrom` (the
    // medication's creation): with no revision that stretch mints against
    // the live rows, so with revisions it mints against the schedule that
    // was live first. A dose recorded for a slot before the creation then
    // meets its slot either way (#1028); unclaimed pre-creation slots are
    // dropped by the ledger.
    const from =
      index === 0
        ? range.from
        : new Date(
            Math.max(revision.validFrom.getTime(), range.from.getTime()),
          );
    // Inclusive sub-range capped 1 ms short of `validUntil` — the anchor
    // boundary rule: a slot exactly at the boundary belongs to the era
    // that begins there, never to the one ending there.
    const to = new Date(
      Math.min(revision.validUntil.getTime() - 1, range.to.getTime()),
    );
    if (from.getTime() > to.getTime()) continue;
    eras.push({
      from,
      to,
      schedules: canonicalSchedulesFromRevision(revision, options),
      live: false,
    });
  }
  const liveFrom =
    sorted.length > 0
      ? new Date(
          Math.max(
            sorted[sorted.length - 1].validUntil.getTime(),
            range.from.getTime(),
          ),
        )
      : range.from;
  if (liveFrom.getTime() <= range.to.getTime()) {
    eras.push({
      from: liveFrom,
      to: range.to,
      schedules: liveSchedules,
      live: true,
    });
  }
  return eras;
}

/**
 * Era-aware drop-in for `buildBandsForSchedules`: segments the range into
 * eras and mints each era with the schedules that were live THEN,
 * concatenating the per-schedule groups. Archived-era groups carry the
 * synthetic `rev:<id>:<idx>` schedule ids. With no revisions this is a
 * plain pass-through to `buildBandsForSchedules` — every existing caller
 * keeps its exact behaviour until it threads revisions in.
 */
export function buildBandsForSchedulesWithEras(input: {
  medication: BandMinterMedication;
  schedules: CanonicalSchedule[];
  revisions: ScheduleRevisionLike[];
  ctx: RecurrenceContext;
  userTz: string;
  range: { from: Date; to: Date };
  now: Date;
  windowConfig?: DoseWindowConfig;
  intakeInstants?: Date[];
}): ScheduleBandGroup[] {
  if (input.revisions.length === 0) {
    return buildBandsForSchedules(input);
  }
  const eras = segmentRangeIntoEras(
    input.range,
    input.revisions,
    input.schedules,
    {
      oneShot: input.medication.oneShot,
    },
  );
  const groups: ScheduleBandGroup[] = [];
  for (const era of eras) {
    groups.push(
      ...buildBandsForSchedules({
        medication: input.medication,
        schedules: era.schedules,
        ctx: input.ctx,
        userTz: input.userTz,
        range: { from: era.from, to: era.to },
        now: input.now,
        windowConfig: input.windowConfig,
        intakeInstants: input.intakeInstants,
      }),
    );
  }
  return groups;
}

/**
 * Era-aware occurrence expansion for the count-shaped consumers
 * (`expectedSlotCountForDay` / `expectedSlotsBetween`): expands each era's
 * schedules over the era's sub-range via the supplied expander and returns
 * the chronological union. The expander signature matches the per-schedule
 * loop those callers already run, so the era split slots in without
 * duplicating their retro-rolling plumbing.
 */
export function occurrencesAcrossEras(
  range: { from: Date; to: Date },
  revisions: ScheduleRevisionLike[],
  liveSchedules: CanonicalSchedule[],
  expand: (schedule: CanonicalSchedule, from: Date, to: Date) => Occurrence[],
  options?: { oneShot?: boolean },
): Occurrence[] {
  const eras = segmentRangeIntoEras(range, revisions, liveSchedules, options);
  const all: Occurrence[] = [];
  for (const era of eras) {
    for (const schedule of era.schedules) {
      all.push(...expand(schedule, era.from, era.to));
    }
  }
  return all.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ────────────────────────────────────────────────────────────────────
// Write-path helpers: snapshot + material-change compare
// ────────────────────────────────────────────────────────────────────

/** The schedule-row projection the snapshot reads (a Prisma row drops in). */
export interface ScheduleSnapshotRow {
  timesOfDay: string[];
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  rrule: string | null;
  rollingIntervalDays: number | null;
  scheduleType: ScheduleType;
  cyclicOnWeeks: number | null;
  cyclicOffWeeks: number | null;
  doseWindows: unknown;
  label: string | null;
  dose: string | null;
  reminderGraceMinutes: number | null;
}

/** Snapshot one schedule row into a revision payload entry. */
export function toRevisionPayloadEntry(
  row: ScheduleSnapshotRow,
): ScheduleRevisionEntry {
  return {
    timesOfDay: [...row.timesOfDay],
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    daysOfWeek: row.daysOfWeek,
    rrule: row.rrule,
    rollingIntervalDays: row.rollingIntervalDays,
    scheduleType: row.scheduleType,
    cyclicOnWeeks: row.cyclicOnWeeks,
    cyclicOffWeeks: row.cyclicOffWeeks,
    doseWindows: row.doseWindows ?? null,
    label: row.label,
    dose: row.dose,
    reminderGraceMinutes: row.reminderGraceMinutes,
  };
}

/**
 * Normalised cadence fingerprint of one snapshot entry. Sorted
 * `timesOfDay`, normalised `doseWindows` sorted by `timeOfDay`, and only
 * the fields that change WHICH slots/bands history mints — `label` and
 * `dose` are display-only and excluded, so renaming a schedule never
 * archives a phantom revision.
 */
function cadenceFingerprint(entry: ScheduleRevisionEntry): string {
  const windows = (normaliseDoseWindows(entry.doseWindows) ?? [])
    .map((w) => `${w.timeOfDay}>${w.start}-${w.end}`)
    .sort();
  return JSON.stringify({
    timesOfDay: [...entry.timesOfDay].sort(),
    windowStart: entry.windowStart,
    windowEnd: entry.windowEnd,
    daysOfWeek: entry.daysOfWeek,
    rrule: entry.rrule,
    rollingIntervalDays: entry.rollingIntervalDays,
    scheduleType: entry.scheduleType,
    cyclicOnWeeks: entry.cyclicOnWeeks,
    cyclicOffWeeks: entry.cyclicOffWeeks,
    doseWindows: windows,
    reminderGraceMinutes: entry.reminderGraceMinutes,
  });
}

/**
 * True when the two schedule sets differ in any cadence-relevant field —
 * the gate for archiving a revision on a wholesale replace. Order- and
 * label-insensitive: a no-op edit (the editor echoing the same rows back,
 * possibly reordered or relabelled) must NOT mint a revision.
 */
export function schedulesMateriallyDiffer(
  before: ScheduleRevisionEntry[],
  after: ScheduleRevisionEntry[],
): boolean {
  if (before.length !== after.length) return true;
  const a = before.map(cadenceFingerprint).sort();
  const b = after.map(cadenceFingerprint).sort();
  return a.some((fp, i) => fp !== b[i]);
}
