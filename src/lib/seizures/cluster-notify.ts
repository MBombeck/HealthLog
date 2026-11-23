/**
 * "A seizure cluster just formed" (#1368).
 *
 * The one push the diary sends. It is opt-in (`SEIZURE_CLUSTER` is off by
 * default, routed per channel at /notifications) and fires at most once per
 * cluster: on the write that turns a run of seizures into a cluster under the
 * person's own rule, never again for the seizures that follow inside it.
 *
 * Three refusals keep it from nagging, and they live here rather than at the
 * call site:
 *
 *  1. A seizure logged by the person themselves sends nothing. They are the
 *     one who knows; the push is for the people around them.
 *  2. A seizure logged after the fact (its onset further back than the rule's
 *     window) sends nothing. Back-filling last month's diary is not news.
 *  3. A seizure that joins a cluster that was already there sends nothing.
 *
 * Each cluster is claimed in `seizure_cluster_alerts` before the send, so two
 * seizures that form it together, logged at the same moment, send once.
 *
 * On a managed profile the dispatcher fans the push out to the record's
 * guardians, except the one who logged the seizure; on an adult's record it
 * goes to the owner, who learns that a carer logged it. No free text rides along: the count, the window and the
 * name of the person who logged it.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { accountLabel } from "@/lib/sharing/account-access-view";

import {
  deriveClusters,
  type ClusterEpisode,
  type ClusterRule,
  type DerivableSeizure,
} from "./derive";
import { readClusterRule } from "./server";

const HOUR_MS = 60 * 60 * 1000;

type ClusterInput = Pick<DerivableSeizure, "id" | "onsetAt" | "count">;

/**
 * The cluster that the event `newId` brought into being, or null.
 *
 * Null when the event is in no cluster, when the cluster it is in shares a
 * seizure with a cluster that stood before it was logged (it joined one), or
 * when its onset lies a whole window or more before `now` (a back-fill).
 * Pure and exported so the rule is pinned without a database.
 */
export function newlyFormedCluster(
  events: readonly ClusterInput[],
  newId: string,
  rule: ClusterRule,
  now: Date,
): ClusterEpisode | null {
  const added = events.find((e) => e.id === newId);
  if (!added) return null;
  const onset = new Date(added.onsetAt).getTime();
  if (now.getTime() - onset >= rule.windowHours * HOUR_MS) return null;

  const derivable = (list: readonly ClusterInput[]) =>
    list.map((e) => ({
      ...e,
      certainty: "CONFIRMED" as const,
      ilaeType: null,
      typeProfileId: null,
      durationSec: null,
      sleepState: "UNKNOWN" as const,
    }));
  const after = deriveClusters(derivable(events), rule);
  const episode = after.find((c) => c.eventIds.includes(newId));
  if (!episode) return null;

  const before = deriveClusters(
    derivable(events.filter((e) => e.id !== newId)),
    rule,
  );
  const members = new Set(episode.eventIds);
  const joined = before.some((c) => c.eventIds.some((id) => members.has(id)));
  return joined ? null : episode;
}

export interface NotifySeizureClusterInput {
  /** The record the seizure was logged on: the recipient (or its guardians). */
  ownerId: string;
  /** The account that logged it. */
  actorId: string;
  /** The seizure just written. */
  eventId: string;
}

/**
 * Tell the people around the person that a cluster just formed.
 *
 * Never throws and is not awaited by the route: a push that fails, or is
 * slow, is no reason to hold up the person logging at the bedside.
 */
export async function notifySeizureCluster(
  input: NotifySeizureClusterInput,
): Promise<void> {
  const { ownerId, actorId, eventId } = input;
  if (actorId === ownerId) return;

  try {
    const rule = await readClusterRule(ownerId);
    const added = await prisma.seizureEvent.findFirst({
      where: { id: eventId, userId: ownerId },
      select: { onsetAt: true },
    });
    if (!added) return;
    // Two windows either side reach every seizure that can sit in a window
    // with the new one, and every window that could already have formed a
    // cluster it would join.
    const reach = 2 * rule.windowHours * HOUR_MS;
    const events = await prisma.seizureEvent.findMany({
      where: {
        userId: ownerId,
        onsetAt: {
          gte: new Date(added.onsetAt.getTime() - reach),
          lte: new Date(added.onsetAt.getTime() + reach),
        },
      },
      select: { id: true, onsetAt: true, count: true },
    });
    const episode = newlyFormedCluster(events, eventId, rule, new Date());
    if (!episode) return;

    // Two seizures that form the cluster together, logged at once, each see
    // the other and call themselves its first. The cluster is claimed under
    // its first seizure, and only the write that inserts the claim sends.
    const claimed = await prisma.seizureClusterAlert.createMany({
      data: [{ userId: ownerId, anchorEventId: episode.eventIds[0]! }],
      skipDuplicates: true,
    });
    if (claimed.count === 0) return;

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { username: true, displayName: true },
    });
    if (!actor) return;

    await dispatchLocalisedNotification({
      userId: ownerId,
      eventType: "SEIZURE_CLUSTER",
      titleKey: "notifications.seizureCluster.title",
      messageKey: "notifications.seizureCluster.body",
      params: {
        count: episode.seizureCount,
        hours: rule.windowHours,
        name: accountLabel(actor),
      },
      // The push opens the seizure that formed the cluster. A guardian on a
      // managed profile still lands on the app root: resolveTapPath and the
      // iOS metadata both drop the path for a managed delivery, because their
      // session opens on their own record, not the one this seizure is on.
      metadata: {
        eventId,
        url: `/seizures?event=${encodeURIComponent(eventId)}`,
      },
      // On a managed profile the push fans out to the guardians, and the one
      // who logged the seizure is among them; they already know.
      excludeRecipientUserIds: [actorId],
    });
  } catch (err) {
    getEvent()?.addWarning(
      `notifySeizureCluster failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
