/**
 * The two counts the navigation shows (#1113): doses due now and check-ups
 * due now, for one account, in one cheap read.
 *
 * Doses: the active, tracked medications and their dose ledgers for today,
 * read in one batch (`dose-state/ledger.ts`), each slot resolved by the dose
 * resolver (`resolveLedgerSlot`): a dose counts when it is `due` or
 * `overdue`, the same answer the today list, the card and every device give.
 * A slot the person snoozed is held, as the today list shows it. Nothing is
 * minted: the today list's projection writes rows, this only reads, and the
 * ledger places a slot whether or not its row exists yet.
 *
 * Check-ups: the reminders the digest's rail reads (enabled, not deleted, no
 * booked visit, due before the end of the local day), kept when they are due
 * now by `isCheckupDueNow`, the rule the rail uses.
 */
import { prisma } from "@/lib/db";
import {
  DOSE_LEDGER_MEDICATION_INCLUDE,
  loadDoseLedgers,
} from "@/lib/medications/dose-state/ledger";
import { resolveLedgerSlot } from "@/lib/medications/dose-state/resolve";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import {
  SNOOZE_ANCHOR_INCLUDE,
  slotsHeldBySnooze,
  snoozeAnchor,
} from "@/lib/medications/snooze-scope";
import { isCheckupDueNow } from "@/lib/measurement-reminders/due-now";
import { getUserTodayBounds } from "@/lib/tz/local-day";

export interface NavCounts {
  dosesDue: number;
  checkupsDue: number;
}

/** How far back a ledger reads so a rolling cadence finds its anchor. */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

async function countDosesDue(
  userId: string,
  userTz: string,
  now: Date,
  todayStart: Date,
  todayEndExclusive: Date,
): Promise<number> {
  const medications = await prisma.medication.findMany({
    where: { userId, active: true, ...TRACKED_INTAKE_WHERE },
    include: { ...DOSE_LEDGER_MEDICATION_INCLUDE, ...SNOOZE_ANCHOR_INCLUDE },
  });
  if (medications.length === 0) return 0;
  const ledgers = await loadDoseLedgers({
    userId,
    userTz,
    now,
    ledgers: medications.map((medication) => ({
      medication,
      from: new Date(todayStart.getTime() - LOOKBACK_MS),
      to: todayEndExclusive,
    })),
  });
  let count = 0;
  for (const medication of medications) {
    const rows = (ledgers.get(medication.id)?.rows ?? []).filter(
      (row) =>
        row.kind === "slot" &&
        row.at.getTime() >= todayStart.getTime() &&
        row.at.getTime() < todayEndExclusive.getTime(),
    );
    const held = slotsHeldBySnooze({
      snoozedUntil: medication.snoozedUntil,
      snoozedAt: snoozeAnchor(medication),
      schedules: medication.schedules,
      slotInstants: rows.map((row) => row.at),
      tz: userTz,
      now,
    });
    for (const row of rows) {
      if (held.has(row.at.getTime())) continue;
      const state = resolveLedgerSlot(row, now)?.state;
      if (state === "due" || state === "overdue") count += 1;
    }
  }
  return count;
}

async function countCheckupsDue(
  userId: string,
  userTz: string,
  now: Date,
  todayEndExclusive: Date,
): Promise<number> {
  const reminders = await prisma.measurementReminder.findMany({
    // A booked visit's one-shot reminder rides this engine with
    // `origin: ENCOUNTER`; it is not a check-up
    // (`encounter-reminder-exclusion.test.ts`).
    where: {
      userId,
      enabled: true,
      deletedAt: null,
      origin: { not: "ENCOUNTER" },
      nextDueAt: { not: null, lt: todayEndExclusive },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    select: {
      origin: true,
      intervalDays: true,
      rrule: true,
      anchorDate: true,
      notifyHour: true,
      lastSatisfiedAt: true,
      createdAt: true,
      nextDueAt: true,
    },
  });
  return reminders.filter((row) => isCheckupDueNow(row, userTz, now)).length;
}

export async function loadNavCounts(
  userId: string,
  userTz: string,
  now: Date,
): Promise<NavCounts> {
  const { start, end } = getUserTodayBounds(now, userTz);
  const todayEndExclusive = new Date(end.getTime() + 1);
  const [dosesDue, checkupsDue] = await Promise.all([
    countDosesDue(userId, userTz, now, start, todayEndExclusive),
    countCheckupsDue(userId, userTz, now, todayEndExclusive),
  ]);
  return { dosesDue, checkupsDue };
}
