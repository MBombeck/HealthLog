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
import {
  ASK_SET_ASIDE_KEYS,
  askLaterKey,
  EMERGENCY_WALLET_ASK_KEY,
} from "@/lib/daily/ask-intents";
import {
  emergencyCardHasHealthItems,
  loadEmergencyCard,
} from "@/lib/emergency-card/card-data";
import {
  isHttpsOrigin,
  resolveEmergencyWalletApple,
} from "@/lib/emergency-card/wallet-pass/availability";
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
  return state.completedAt === null ? "server_setup" : "push_relay";
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
    where: {
      userId,
      OR: [
        { itemKey: { startsWith: prefix } },
        // The asks set aside for good name no day (`ASK_SET_ASIDE_KEYS`).
        { itemKey: { in: [...ASK_SET_ASIDE_KEYS] } },
      ],
    },
    select: { itemKey: true },
  });
  return rows.map((row) =>
    row.itemKey.startsWith(prefix)
      ? row.itemKey.slice(prefix.length)
      : row.itemKey,
  );
}

/**
 * Whether the start page offers the reader's emergency card for Wallet,
 * cheapest read first: the offer was not set aside (`heldKeys`, the dismiss
 * ledger, where a pass made writes the same key), the origin is https, no
 * pass was ever made for this record, Wallet is `available` here (the
 * resolution `/api/auth/me` publishes), and the card holds something beyond
 * the name and the date of birth.
 */
async function readEmergencyWalletAsk(
  user: SessionUser,
  origin: string,
  heldKeys: ReadonlySet<string>,
  now: Date,
): Promise<boolean> {
  if (heldKeys.has(EMERGENCY_WALLET_ASK_KEY)) return false;
  // No pass is made off https; known without a read.
  if (!isHttpsOrigin(origin)) return false;
  if ((await prisma.walletPass.count({ where: { userId: user.id } })) > 0) {
    return false;
  }
  const apple = await resolveEmergencyWalletApple({
    recordUserId: user.id,
    allowed: true,
    origin,
    // The state, not who may press the button: that is the card page's.
    authMethod: "cookie",
    callerIsAdmin: user.role === "ADMIN",
    relayHintDismissed: false,
    pass: null,
    now,
  });
  if (apple.state !== "available") return false;
  const card = await loadEmergencyCard(user.id, userDayKey(now, user.timezone));
  return emergencyCardHasHealthItems(card);
}

export async function readAskInputs(
  user: SessionUser,
  medsToday: MedsTodayBlock,
  now: Date,
  options: { adminAsks?: boolean; walletOrigin?: string | null },
): Promise<{
  adminAsk: AdminAskKind | null;
  snoozedDoseItemKeys: Set<string>;
  emergencyWalletAsk: boolean;
}> {
  const [snoozedDoseItemKeys, adminAsk, laterKeys] = await Promise.all([
    readSnoozedDoseKeys(user.id, user.timezone, medsToday, now).catch(
      () => new Set<string>(),
    ),
    options.adminAsks && user.role === "ADMIN"
      ? readAdminAsk(user.id).catch(() => null)
      : Promise.resolve(null),
    readAskLaterKeys(user.id, userDayKey(now, user.timezone)).catch(() => null),
  ]);
  for (const key of laterKeys ?? []) snoozedDoseItemKeys.add(key);
  // Without the ledger a "Later" given for good cannot be told, so the
  // one-time offer waits rather than come back.
  const emergencyWalletAsk =
    options.walletOrigin && laterKeys
      ? await readEmergencyWalletAsk(
          user,
          options.walletOrigin,
          snoozedDoseItemKeys,
          now,
        ).catch(() => false)
      : false;
  annotate({
    meta: {
      daily_digest_admin_ask: adminAsk,
      daily_digest_held_asks: snoozedDoseItemKeys.size,
      daily_digest_wallet_ask: emergencyWalletAsk,
    },
  });
  return { adminAsk, snoozedDoseItemKeys, emergencyWalletAsk };
}
