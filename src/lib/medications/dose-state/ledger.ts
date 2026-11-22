/**
 * The dose ledger of one medication over a window: every expected slot with
 * its band and status, and every off-schedule take, from the same band
 * minter and attribution the compliance rate and the reminder worker use.
 *
 * Split out of `GET /api/medications/{id}/dose-history` so every reader that
 * needs the state of a dose (the history, the today list, the card's current
 * dose) reads one ledger rather than re-deriving windows of its own. The
 * resolved per-slot state lives in `./resolve.ts`.
 */
import {
  complianceMintWindow,
  COURSES_COMPLIANCE_SELECT,
  slotInsideCourses,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import {
  type BandFamily,
  type BandMinterMedication,
} from "@/lib/medications/scheduling/band-minter";
import { buildBandsForSchedulesWithEras } from "@/lib/medications/scheduling/schedule-eras";
import {
  reconstructDoseHistory,
  type DoseHistoryRow,
  type HistoryIntake,
} from "@/lib/medications/scheduling/dose-history";
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { dueSchedules } from "@/lib/medications/intake-tracking";
import { MEDICATION_SCHEDULE_ORDER } from "@/lib/medications/read-order";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the ledger needs of the medication row. */
export const DOSE_LEDGER_MEDICATION_INCLUDE = {
  schedules: { orderBy: MEDICATION_SCHEDULE_ORDER },
  // Archived schedule eras: past days mint against the schedule live THEN.
  scheduleRevisions: { orderBy: { validFrom: "asc" } },
  // Every course's slots, the same ones the compliance rate counts.
  courses: COURSES_COMPLIANCE_SELECT,
} satisfies Prisma.MedicationInclude;

export type DoseLedgerMedication = Prisma.MedicationGetPayload<{
  include: typeof DOSE_LEDGER_MEDICATION_INCLUDE;
}>;

export interface DoseLedger {
  rows: DoseHistoryRow[];
  bands: SlotBand[];
  family: BandFamily;
  /** The read horizon: `to`, or later for a dose recorded ahead of its slot. */
  horizon: Date;
  /** The latest take the cadence re-anchors on (a rolling grid), or null. */
  lastIntakeAt: Date | null;
}

/** What the window read selects of each intake row. */
const WINDOW_INTAKE_SELECT = {
  id: true,
  medicationId: true,
  scheduledFor: true,
  takenAt: true,
  skipped: true,
  autoMissed: true,
  // USER_PIN rows bind by anchor in the read ledger.
  attributionSource: true,
  // Per-intake dose override for the ledger's deviation hint.
  doseTaken: true,
  // Write provenance so the client can label how
  // each dose was recorded (Web / API / Reminder / Import / AppleHealth).
  source: true,
  // The history labels an automatically recorded dose.
  autoRecorded: true,
} satisfies Prisma.MedicationIntakeEventSelect;

type WindowIntake = Prisma.MedicationIntakeEventGetPayload<{
  select: typeof WINDOW_INTAKE_SELECT;
}>;

interface WindowIntakes {
  events: WindowIntake[];
  /** The latest take before the window, or null. */
  anchorBefore: Date | null;
}

/**
 * The intakes each window needs, for many medications in two queries: the
 * rows anchored in a window or taken in it (a late take on an older slot is
 * an intake instant of the window), and of all the rows before it only the
 * latest take, the anchor a rolling grid re-starts from and the last intake
 * when none falls in the window. Earlier takes place no slot in the window.
 * The whole history used to be read on every open, so a medication taken for
 * years read thousands of rows to show at most a year.
 *
 * One read for every medication, from the earliest window start: the today
 * list resolved fifteen medications in nineteen round trips one after the
 * other. Each medication's own window is then cut from the shared rows, and
 * its anchor is the later of the shared anchor (before the earliest start)
 * and the latest take between the earliest start and its own.
 */
async function readWindowIntakesBatch(
  userId: string,
  windows: ReadonlyArray<{ medicationId: string; from: Date }>,
): Promise<Map<string, WindowIntakes>> {
  const out = new Map<string, WindowIntakes>();
  if (windows.length === 0) return out;
  const ids = [...new Set(windows.map((w) => w.medicationId))];
  const earliest = new Date(Math.min(...windows.map((w) => w.from.getTime())));
  const [events, anchors] = await Promise.all([
    prisma.medicationIntakeEvent.findMany({
      where: {
        medicationId: ids.length === 1 ? ids[0] : { in: ids },
        userId,
        deletedAt: null,
        OR: [
          { scheduledFor: { gte: earliest } },
          { takenAt: { gte: earliest } },
        ],
      },
      orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
      select: WINDOW_INTAKE_SELECT,
    }),
    // The newest take before the earliest start, per medication: one index
    // probe each on `(user_id, medication_id, taken_at)`.
    ids.length === 1
      ? anchorOfOne(userId, ids[0]!, earliest)
      : prisma.$queryRaw<Array<{ medicationId: string; takenAt: Date }>>`
      SELECT m.id AS "medicationId", e.taken_at AS "takenAt"
      FROM unnest(${ids}::text[]) AS m(id)
      CROSS JOIN LATERAL (
        SELECT taken_at
        FROM medication_intake_events
        WHERE user_id = ${userId}
          AND medication_id = m.id
          AND deleted_at IS NULL
          AND skipped = false
          AND scheduled_for < ${earliest}
          AND taken_at < ${earliest}
        ORDER BY taken_at DESC
        LIMIT 1
      ) e
    `,
  ]);
  const anchorByMedication = new Map(
    anchors.map((a) => [a.medicationId, a.takenAt]),
  );
  const eventsByMedication = new Map<string, WindowIntake[]>();
  for (const e of events) {
    // One medication's read is keyed by it alone (`medicationId` equality).
    const key = ids.length === 1 ? ids[0]! : e.medicationId;
    const list = eventsByMedication.get(key);
    if (list) list.push(e);
    else eventsByMedication.set(key, [e]);
  }
  for (const { medicationId, from } of windows) {
    const rows = eventsByMedication.get(medicationId) ?? [];
    const f = from.getTime();
    let anchor = anchorByMedication.get(medicationId)?.getTime() ?? null;
    const inWindow: WindowIntake[] = [];
    for (const e of rows) {
      const t = e.takenAt?.getTime() ?? null;
      if (e.scheduledFor.getTime() >= f || (t !== null && t >= f)) {
        inWindow.push(e);
      } else if (!e.skipped && t !== null && (anchor === null || t > anchor)) {
        anchor = t;
      }
    }
    out.set(medicationId, {
      events: inWindow,
      anchorBefore: anchor === null ? null : new Date(anchor),
    });
  }
  return out;
}

/** The newest take of one medication before `from`, as the batch reads it. */
async function anchorOfOne(
  userId: string,
  medicationId: string,
  from: Date,
): Promise<Array<{ medicationId: string; takenAt: Date }>> {
  const row = await prisma.medicationIntakeEvent.findFirst({
    where: {
      medicationId,
      userId,
      deletedAt: null,
      skipped: false,
      scheduledFor: { lt: from },
      takenAt: { lt: from },
    },
    orderBy: [{ takenAt: "desc" }, { id: "desc" }],
    select: { takenAt: true },
  });
  return row?.takenAt ? [{ medicationId, takenAt: row.takenAt }] : [];
}

export interface DoseLedgerInput {
  medication: DoseLedgerMedication;
  from: Date;
  to: Date;
}

/**
 * The ledgers of many medications, by medication id, from two queries
 * whatever their number. Every reader that needs the dose state of more
 * than one medication goes through here, never through a loop of
 * `loadDoseLedger`.
 */
export async function loadDoseLedgers(input: {
  userId: string;
  userTz: string;
  now: Date;
  ledgers: readonly DoseLedgerInput[];
}): Promise<Map<string, DoseLedger>> {
  const reads = await readWindowIntakesBatch(
    input.userId,
    input.ledgers.map((l) => ({ medicationId: l.medication.id, from: l.from })),
  );
  const out = new Map<string, DoseLedger>();
  for (const l of input.ledgers) {
    const read = reads.get(l.medication.id) ?? {
      events: [],
      anchorBefore: null,
    };
    out.set(
      l.medication.id,
      composeDoseLedger({
        medication: l.medication,
        userTz: input.userTz,
        from: l.from,
        to: l.to,
        now: input.now,
        ...read,
      }),
    );
  }
  return out;
}

/** The ledger of `medication` over `[from, to]`. */
export async function loadDoseLedger(input: {
  medication: DoseLedgerMedication;
  userId: string;
  userTz: string;
  from: Date;
  to: Date;
  now: Date;
}): Promise<DoseLedger> {
  const ledgers = await loadDoseLedgers({
    userId: input.userId,
    userTz: input.userTz,
    now: input.now,
    ledgers: [input],
  });
  return ledgers.get(input.medication.id) as DoseLedger;
}

/** The ledger from its intakes: pure, no database. */
function composeDoseLedger(input: {
  medication: DoseLedgerMedication;
  userTz: string;
  from: Date;
  to: Date;
  now: Date;
  events: WindowIntake[];
  anchorBefore: Date | null;
}): DoseLedger {
  const { medication, userTz, from, to, now, events, anchorBefore } = input;

  const mapped = events.map((e) => ({
    id: e.id,
    scheduledFor: e.scheduledFor,
    takenAt: e.takenAt,
    skipped: e.skipped,
    autoMissed: e.autoMissed,
    pinned: e.attributionSource === "USER_PIN",
    doseTaken: e.doseTaken,
    source: e.source,
    autoRecorded: e.autoRecorded,
  }));

  const lastIntakeAt = lastNonSkippedTakenAt([
    ...mapped,
    ...(anchorBefore ? [{ takenAt: anchorBefore, skipped: false }] : []),
  ]);

  // A dose may be recorded before its slot's own time: the dose window opens
  // up to two hours early, and a skip can be logged ahead. Such a row is
  // stored on the slot's anchor, which still lies after `to`, so a window
  // that ends at `to` dropped a dose the user had just recorded until the
  // slot's clock time passed (#1028). Extend the read horizon to the latest
  // anchor of a recorded row (taken or skipped) within a day of `to`, and no
  // further: pending reminder rows record nothing and never stretch it.
  const horizon = new Date(
    mapped.reduce((latest, e) => {
      const t = e.scheduledFor.getTime();
      const recorded = e.skipped || (e.takenAt !== null && e.takenAt <= to);
      return recorded && t > latest && t <= to.getTime() + DAY_MS ? t : latest;
    }, to.getTime()),
  );

  // Mint over the span of every course and keep only the
  // slots on a course day, the rule the compliance ledger applies, so the
  // history lists exactly the misses the rate counts.
  const courseCtx = {
    startsOn: medication.startsOn,
    endsOn: medication.endsOn,
    timeZone: userTz,
    courses: medication.courses,
  };
  const mintWindow = complianceMintWindow(courseCtx);
  const bandMedication: BandMinterMedication = {
    id: medication.id,
    startsOn: mintWindow.startsOn,
    endsOn: mintWindow.endsOn,
    oneShot: medication.oneShot,
    createdAt: medication.createdAt,
  };
  const ctx = buildRecurrenceContext({
    medication: { ...bandMedication, endedAt: medication.endedAt },
    userTz,
    lastIntakeAt,
  });
  // A legacy daily schedule carrying only `windowStart` surfaces it as the
  // single time-of-day so the minter mints its daily band (mirrors the
  // compliance route + the ledger tally).
  // With intake tracking off the live era expects
  // nothing: the ledger shows the doses that were recorded and the slots
  // of archived eras, never a missed slot minted from the record.
  const canonicalSchedules = dueSchedules(medication).map((s) => {
    const canonical = buildCanonicalSchedule(s as WorkerScheduleRow);
    if (
      canonical.timesOfDay.length === 0 &&
      canonical.rrule === null &&
      canonical.rollingIntervalDays === null &&
      canonical.scheduleType !== "PRN" &&
      !medication.oneShot
    ) {
      return { ...canonical, timesOfDay: [canonical.windowStart] };
    }
    return canonical;
  });

  // Rolling cadences anchor their retrospective grid AT each logged intake.
  const intakeInstants = mapped
    .filter((e) => !e.skipped && e.takenAt !== null && e.takenAt <= to)
    .map((e) => e.takenAt as Date)
    .concat(anchorBefore ? [anchorBefore] : [])
    .sort((a, b) => a.getTime() - b.getTime());

  const groups = buildBandsForSchedulesWithEras({
    medication: bandMedication,
    schedules: canonicalSchedules,
    revisions: medication.scheduleRevisions ?? [],
    ctx,
    userTz,
    range: { from, to: horizon },
    now,
    intakeInstants,
  });
  const bands: SlotBand[] = [];
  let family: BandFamily = "none";
  for (const g of groups) {
    if (g.hasExpectedSlots) {
      bands.push(...g.bands.filter((b) => slotInsideCourses(courseCtx, b.at)));
      if (family === "none") family = g.family;
    }
  }

  // Intakes whose slot anchor falls in the window. An ad-hoc take buckets on
  // its real time, but the ledger reads `scheduledFor` for the membership
  // partition, so filter on the stored anchor (a take snapped to an
  // out-of-window slot is excluded, matching the compliance read).
  const historyIntakes: HistoryIntake[] = mapped
    .filter((e) => e.scheduledFor >= from && e.scheduledFor <= horizon)
    .map((e) => ({
      id: e.id,
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed,
      pinned: e.pinned,
      doseTaken: e.doseTaken,
      source: e.source,
      autoRecorded: e.autoRecorded,
    }));

  const rows = reconstructDoseHistory(
    bands,
    historyIntakes,
    now,
    medication.createdAt,
  );

  return { rows, bands, family, horizon, lastIntakeAt };
}
