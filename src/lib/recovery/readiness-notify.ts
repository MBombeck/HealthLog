/**
 * Push recovery readiness to every admin: once when a signal turns to
 * attention or failing, once when it is back to ok, and a reminder at most
 * once a day while it stays failing. Nothing else.
 *
 * The memory is one row per signal (`RecoveryReadinessNotice`): the state the
 * admins were last told about and when. A notice is claimed with a
 * compare-and-set on both columns before it is sent, so two workers that
 * evaluate in the same minute send it once, and a crash between the claim and
 * the send loses a notice rather than repeating it every hour.
 *
 * Delivery goes through the ordinary localised path, as the deploy-failure
 * alert does: every ADMIN, in their own locale, on the channels they enabled
 * for `BACKUP_HEALTH`, with the dispatcher's cooldowns and hard-reject rules.
 * An admin who switched the event off on a channel is not reached there.
 */
import { prisma } from "@/lib/db";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import {
  READINESS_SIGNALS,
  type ReadinessSignal,
  type ReadinessSignalId,
  type ReadinessState,
  type RecoveryReadiness,
} from "@/lib/recovery/readiness-model";

/** A failing signal is reminded at most this often. */
export const FAILING_REMINDER_HOURS = 24;

type NotifiedState = Exclude<ReadinessState, "inactive">;

export interface StoredNotice {
  notifiedState: NotifiedState | null;
  notifiedAt: Date | null;
}

export type NoticeKind = "problem" | "reminder" | "recovered";

export interface NoticeDecision {
  /** What to send, or null for nothing. */
  send: NoticeKind | null;
  /** What to store, or null to leave the row as it is. */
  next: StoredNotice | null;
}

const NOTHING: NoticeDecision = { send: null, next: null };

/**
 * Pure: what one evaluation of one signal sends and stores.
 *
 *   - attention / failing, different from what was last announced: send it.
 *   - failing, as announced, and the last notice is a day old: remind.
 *   - ok after attention or failing: announce the recovery.
 *   - inactive: forget silently. A signal that stops applying (the bucket was
 *     unset, so there is no drill to judge) did not recover, and saying so
 *     would be untrue; if it applies again and is still broken, it is news.
 */
export function decideNotice(
  stored: StoredNotice | null,
  current: ReadinessState,
  now: Date,
): NoticeDecision {
  const last = stored?.notifiedState ?? null;
  if (current === "inactive") {
    return last === null
      ? NOTHING
      : { send: null, next: { notifiedState: null, notifiedAt: null } };
  }
  if (current === "ok") {
    return last === "attention" || last === "failing"
      ? { send: "recovered", next: { notifiedState: "ok", notifiedAt: now } }
      : NOTHING;
  }
  if (last !== current) {
    return {
      send: "problem",
      next: { notifiedState: current, notifiedAt: now },
    };
  }
  const lastAt = stored?.notifiedAt ?? null;
  if (
    current === "failing" &&
    (lastAt === null ||
      now.getTime() - lastAt.getTime() >= FAILING_REMINDER_HOURS * 3_600_000)
  ) {
    return {
      send: "reminder",
      next: { notifiedState: current, notifiedAt: now },
    };
  }
  return NOTHING;
}

/** The title of a notice, by what it says. */
function titleKey(kind: NoticeKind, state: ReadinessState): string {
  if (kind === "recovered") {
    return "notifications.recoveryReadiness.titleRecovered";
  }
  if (kind === "reminder") {
    return "notifications.recoveryReadiness.titleReminder";
  }
  return state === "failing"
    ? "notifications.recoveryReadiness.titleFailing"
    : "notifications.recoveryReadiness.titleAttention";
}

/**
 * The body: the same sentence the tile shows for the signal's reason, or the
 * signal's own recovery line.
 */
function messageKey(kind: NoticeKind, signal: ReadinessSignal): string {
  return kind === "recovered"
    ? `admin.recoveryReadiness.recovered.${signal.id}`
    : `admin.recoveryReadiness.reason.${signal.id}.${signal.reason}`;
}

export interface NotifyOutcome {
  /** Notices claimed and sent, by signal. */
  sent: Array<{ signal: ReadinessSignalId; kind: NoticeKind }>;
  /** Admins each notice went to. */
  admins: number;
}

function isNotifiedState(value: string | null): value is NotifiedState {
  return value === "ok" || value === "attention" || value === "failing";
}

/**
 * Compare a fresh evaluation against what the admins were last told, claim
 * every notice that is due, and send it.
 */
export async function notifyReadinessChanges(
  readiness: RecoveryReadiness,
  now: Date = new Date(readiness.evaluatedAt),
): Promise<NotifyOutcome> {
  await prisma.recoveryReadinessNotice.createMany({
    data: READINESS_SIGNALS.map((signal) => ({ signal })),
    skipDuplicates: true,
  });
  const rows = await prisma.recoveryReadinessNotice.findMany();
  const byId = new Map(rows.map((row) => [row.signal, row]));
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const outcome: NotifyOutcome = { sent: [], admins: admins.length };
  for (const signal of readiness.signals) {
    const row = byId.get(signal.id);
    const applies = signal.state !== "inactive";
    // Since when the signal applies: set once, cleared when it stops.
    if (row && applies !== (row.watchedSince !== null)) {
      await prisma.recoveryReadinessNotice.updateMany({
        where: { signal: signal.id, watchedSince: row.watchedSince },
        data: { watchedSince: applies ? now : null },
      });
    }

    const stored: StoredNotice | null = row
      ? {
          notifiedState: isNotifiedState(row.notifiedState)
            ? row.notifiedState
            : null,
          notifiedAt: row.notifiedAt,
        }
      : null;
    const decision = decideNotice(stored, signal.state, now);
    // With no admin yet there is nobody to tell, so nothing is claimed: the
    // first admin hears about a problem that is still standing.
    if (!decision.next || admins.length === 0) continue;

    // Claim: only the evaluation that moves the row from what it read sends.
    const claimed = await prisma.recoveryReadinessNotice.updateMany({
      where: {
        signal: signal.id,
        notifiedState: row?.notifiedState ?? null,
        notifiedAt: row?.notifiedAt ?? null,
      },
      data: {
        notifiedState: decision.next.notifiedState,
        notifiedAt: decision.next.notifiedAt,
      },
    });
    if (claimed.count !== 1 || decision.send === null) continue;

    for (const admin of admins) {
      await dispatchLocalisedNotification({
        userId: admin.id,
        eventType: "BACKUP_HEALTH",
        titleKey: titleKey(decision.send, signal.state),
        messageKey: messageKey(decision.send, signal),
        params: signal.params,
        metadata: {
          source: "recovery-readiness",
          url: signal.fixPath,
          signal: signal.id,
          state: signal.state,
          reason: signal.reason,
        },
      });
    }
    outcome.sent.push({ signal: signal.id, kind: decision.send });
  }
  return outcome;
}
