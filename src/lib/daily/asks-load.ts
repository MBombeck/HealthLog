/**
 * The two reads the ask policy (`asks.ts`) needs beyond the digest's own
 * inputs: which of today's dose candidates are held by a running snooze, and
 * which admin question is open for this admin. Both fail soft: an ask is
 * never worth a failed digest.
 */
import type { SessionUser } from "@/lib/auth/session-user";
import { prisma } from "@/lib/db";
import { readServerSetupState } from "@/lib/admin/server-setup-store";
import type { AdminAskKind } from "@/lib/daily/asks";
import { askLaterKey } from "@/lib/daily/ask-intents";
import { userDayKey } from "@/lib/tz/format";
import { doseWindowItemKey } from "@/lib/daily/priority-item-key";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import { annotate } from "@/lib/logging/context";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import {
  SNOOZE_ANCHOR_INCLUDE,
  slotsHeldBySnooze,
  snoozeAnchor,
} from "@/lib/medications/snooze-scope";

/**
 * The admin question the start-page notice names: the unfinished server
 * setup first, else the undecided push relay. Null once the admin set the
 * notice aside.
 */
async function readAdminAsk(userId: string): Promise<AdminAskKind | null> {
  const state = await readServerSetupState(userId);
  if (!state.offered || !state.noticePending) return null;
  if (state.completedAt === null) return "server_setup";
  // 1.50 — "Not now" in the setup's relay step is an answer for the
  // dashboard: the question stays on the admin start page and in Admin ›
  // Setup, and does not come back here.
  const relayStep = state.steps.find((step) => step.id === "relay");
  return relayStep?.status === "skipped" ? null : "push_relay";
}

/**
 * The dose item keys whose snooze is running, by the rule the today list and
 * the reminder worker share (`snooze-scope.ts`). One indexed read that finds
 * nothing on almost every day.
 */
async function readSnoozedDoseKeys(
  userId: string,
  userTz: string,
  medsToday: MedsTodayBlock,
  now: Date,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const candidates = medsToday.dueCandidates ?? [];
  if (candidates.length === 0) return keys;
  const where = {
    userId,
    id: { in: candidates.map((c) => c.medicationId) },
    snoozedUntil: { gt: now },
    ...TRACKED_INTAKE_WHERE,
  };
  // A bare count first: no snooze runs on almost every day, and the full
  // read below fans out into a statement per relation.
  if ((await prisma.medication.count({ where })) === 0) return keys;
  const snoozed = await prisma.medication.findMany({
    where,
    select: {
      id: true,
      snoozedUntil: true,
      updatedAt: true,
      ...SNOOZE_ANCHOR_INCLUDE,
      schedules: {
        select: {
          windowStart: true,
          windowEnd: true,
          timesOfDay: true,
          reminderGraceMinutes: true,
          doseWindows: true,
        },
      },
    },
  });
  for (const medication of snoozed) {
    for (const candidate of candidates) {
      if (candidate.medicationId !== medication.id) continue;
      const slot = new Date(candidate.dueAt);
      if (Number.isNaN(slot.getTime())) continue;
      const held = slotsHeldBySnooze({
        snoozedUntil: medication.snoozedUntil,
        snoozedAt: snoozeAnchor(medication),
        schedules: medication.schedules,
        slotInstants: [slot],
        tz: userTz,
        now,
      });
      if (held.has(slot.getTime())) {
        keys.add(doseWindowItemKey(candidate.medicationId, candidate.dueAt));
      }
    }
  }
  return keys;
}

/**
 * The digest input fields the asks read. The admin question only when the
 * caller passed `adminAsks` (a browser session on its own record, where the
 * cookie-only answers can be given) and the reader is an admin.
 */
/**
 * The asks set aside today ("Later"), as their item keys: the dismiss
 * ledger rows `ask-later:<today>:<itemKey>`. Yesterday's rows no longer
 * match, so a "later" lasts for the rest of the local day.
 */
async function readAskLaterKeys(
  userId: string,
  today: string,
): Promise<string[]> {
  const prefix = askLaterKey(today, "");
  const rows = await prisma.dismissedPriorityItem.findMany({
    where: { userId, itemKey: { startsWith: prefix } },
    select: { itemKey: true },
  });
  return rows.map((row) => row.itemKey.slice(prefix.length));
}

export async function readAskInputs(
  user: SessionUser,
  medsToday: MedsTodayBlock,
  now: Date,
  options: { adminAsks?: boolean },
): Promise<{
  adminAsk: AdminAskKind | null;
  snoozedDoseItemKeys: Set<string>;
}> {
  const [snoozedDoseItemKeys, adminAsk, laterKeys] = await Promise.all([
    readSnoozedDoseKeys(user.id, user.timezone, medsToday, now).catch(
      () => new Set<string>(),
    ),
    options.adminAsks && user.role === "ADMIN"
      ? readAdminAsk(user.id).catch(() => null)
      : Promise.resolve(null),
    readAskLaterKeys(user.id, userDayKey(now, user.timezone)).catch(
      () => [] as string[],
    ),
  ]);
  for (const key of laterKeys) snoozedDoseItemKeys.add(key);
  annotate({
    meta: {
      daily_digest_admin_ask: adminAsk,
      daily_digest_held_asks: snoozedDoseItemKeys.size,
    },
  });
  return { adminAsk, snoozedDoseItemKeys };
}
