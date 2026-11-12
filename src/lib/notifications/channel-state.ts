/**
 * Channel state mutations for the notification dispatcher (v1.4.15 Phase B3).
 *
 * Centralised so the dispatcher can call ONE function per outcome —
 * making the "auto-disable on hard reject" + "exponential backoff on
 * soft reject" rules unit-testable and audit-loggable in one place.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auditLog } from "@/lib/auth/audit";
import { getEvent } from "@/lib/logging/context";
import {
  NO_RECIPIENT_COOLDOWN_MS,
  nextRetryAt,
  shouldAutoDisableAfterTransient,
  type SendOutcome,
} from "@/lib/notifications/retry-policy";
import type { ChannelType } from "@/lib/notifications/types";

interface ChannelRef {
  id: string;
  userId: string;
  type: ChannelType;
}

/**
 * Record a successful send. Resets the failure counter and clears any
 * pending retry-cooldown so the next dispatch goes out immediately.
 */
export async function recordChannelSuccess(channel: ChannelRef): Promise<void> {
  await prisma.notificationChannel.update({
    where: { id: channel.id },
    data: {
      lastSuccessAt: new Date(),
      consecutiveFailures: 0,
      nextRetryAt: null,
      lastFailureReason: null,
    },
  });
}

/**
 * Record a hard reject — the upstream told us this channel is dead.
 * Disables the channel, captures the reason for the Settings UI, and
 * writes an audit-log entry so the user can trace WHY their phone
 * stopped getting reminders.
 */
export async function recordChannelHardReject(
  channel: ChannelRef,
  outcome: Pick<SendOutcome, "reason" | "message" | "statusCode">,
): Promise<void> {
  const reason = outcome.reason ?? "hard_reject";
  await prisma.notificationChannel.update({
    where: { id: channel.id },
    data: {
      enabled: false,
      disabledReason: reason,
      lastFailureAt: new Date(),
      lastFailureReason: reason,
      // Counter is preserved so the UI can show "5 in a row before we
      // gave up", but bump it so /api/notifications/status shows the
      // hard-reject as a final failure event.
      consecutiveFailures: { increment: 1 },
      nextRetryAt: null,
    },
  });
  await auditLog("notification.channel.auto_disabled", {
    userId: channel.userId,
    details: {
      channelType: channel.type,
      channelId: channel.id,
      reason,
      statusCode: outcome.statusCode ?? null,
      kind: "hard_reject",
    },
  });
}

/**
 * Record a transient failure. Increments the counter, schedules the
 * next retry per the backoff schedule, and — once the counter crosses
 * MAX_CONSECUTIVE_FAILURES — auto-disables the channel with reason
 * `give_up_after_5_failures` and writes an audit entry.
 */
export async function recordChannelTransientFailure(
  channel: ChannelRef,
  outcome: Pick<SendOutcome, "reason" | "message" | "statusCode">,
  now: Date = new Date(),
): Promise<{ autoDisabled: boolean; nextRetryAt: Date | null }> {
  // Re-read current counter inside an atomic update to avoid races
  // when multiple dispatch attempts collide.
  const updated = await prisma.notificationChannel.update({
    where: { id: channel.id },
    data: {
      consecutiveFailures: { increment: 1 },
      lastFailureAt: now,
      lastFailureReason: outcome.reason ?? "transient_failure",
    },
    select: { consecutiveFailures: true },
  });
  const failureCount = updated.consecutiveFailures;

  if (shouldAutoDisableAfterTransient(failureCount)) {
    await prisma.notificationChannel.update({
      where: { id: channel.id },
      data: {
        enabled: false,
        disabledReason: "give_up_after_5_failures",
        nextRetryAt: null,
      },
    });
    await auditLog("notification.channel.auto_disabled", {
      userId: channel.userId,
      details: {
        channelType: channel.type,
        channelId: channel.id,
        reason: "give_up_after_5_failures",
        consecutiveFailures: failureCount,
        kind: "transient_give_up",
        lastError: outcome.reason ?? null,
        statusCode: outcome.statusCode ?? null,
      },
    });
    return { autoDisabled: true, nextRetryAt: null };
  }

  const retryAt = nextRetryAt(failureCount, now);
  await prisma.notificationChannel.update({
    where: { id: channel.id },
    data: { nextRetryAt: retryAt },
  });
  return { autoDisabled: false, nextRetryAt: retryAt };
}

/**
 * Record a send that had nobody to go to. Not a failure: the counter stays
 * where it is. The reason is kept, so the status screen says why nothing
 * arrives, and the channel rests for `NO_RECIPIENT_COOLDOWN_MS`.
 */
export async function recordChannelNoRecipient(
  channel: ChannelRef,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  getEvent()?.addMeta(
    `notification_skip_${channel.type.toLowerCase()}_no_recipient`,
    reason,
  );
  await prisma.notificationChannel.update({
    where: { id: channel.id },
    data: {
      lastFailureAt: now,
      lastFailureReason: reason,
      nextRetryAt: new Date(now.getTime() + NO_RECIPIENT_COOLDOWN_MS),
    },
  });
}

/** Pairing an iPhone ends a rest that was waiting for one. */
export async function endApnsNoDeviceRest(
  db: Pick<Prisma.TransactionClient, "notificationChannel">,
  userId: string,
): Promise<void> {
  await db.notificationChannel.updateMany({
    where: { userId, type: "APNS", lastFailureReason: "apns_no_devices" },
    data: { nextRetryAt: null, lastFailureReason: null },
  });
}

/**
 * Re-enable a channel that was previously auto-disabled. Clears the
 * disabled-reason + counter and the cooldown so the next dispatch
 * fires immediately. Audit-logs the manual override.
 */
export async function reEnableChannel(channel: ChannelRef): Promise<void> {
  await prisma.notificationChannel.update({
    where: { id: channel.id },
    data: {
      enabled: true,
      disabledReason: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      lastFailureReason: null,
    },
  });
  await auditLog("notification.channel.re_enabled", {
    userId: channel.userId,
    details: {
      channelType: channel.type,
      channelId: channel.id,
    },
  });
}

/**
 * Should the dispatcher attempt a send right now? Honours the cooldown
 * window written by the backoff scheduler — if `nextRetryAt` is in the
 * future, the channel is in "sending paused" mode and should be
 * skipped to avoid hammering a flapping upstream.
 */
export function isChannelInCooldown(
  channel: { nextRetryAt: Date | null },
  now: Date = new Date(),
): boolean {
  return channel.nextRetryAt !== null && channel.nextRetryAt > now;
}
