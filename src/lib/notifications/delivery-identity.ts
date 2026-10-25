import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import {
  activeGuardianWhere,
  withManagedProfileLock,
} from "@/lib/managed-profiles/lifecycle";
import type { Prisma } from "@/generated/prisma/client";
import type {
  ChannelType,
  NotificationPayload,
} from "@/lib/notifications/types";

export interface NotificationDeliveryIdentity {
  recordUserId: string;
  recipientUserId: string;
  managed: boolean;
}

/**
 * The policy is deliberately closed. `SYSTEM_ALERT` by itself is never a
 * Guardian event: the safety-floor producer must name its narrow admission
 * marker, while illness red flags continue to remain record-local.
 */
export function isManagedGuardianFanoutAllowed(
  payload: Pick<NotificationPayload, "eventType" | "managedFanoutEvent">,
): boolean {
  if (payload.managedFanoutEvent === "SAFETY_FLOOR_ALERT") {
    return payload.eventType === "SYSTEM_ALERT";
  }

  return (
    payload.managedFanoutEvent === undefined &&
    (payload.eventType === "MEDICATION_REMINDER" ||
      payload.eventType === "MEASUREMENT_REMINDER" ||
      payload.eventType === "MEDICATION_LOW_STOCK")
  );
}

/**
 * Enumerate candidate Guardians only for a legacy record-addressed delivery.
 * Each candidate is still re-authorized under the managed-profile advisory
 * lock immediately before its own channel selection and provider egress.
 */
export async function resolveManagedGuardianRecipientIds(
  payload: NotificationPayload,
): Promise<string[] | null> {
  if (
    payload.recordUserId !== undefined ||
    payload.recipientUserId !== undefined ||
    !isManagedGuardianFanoutAllowed(payload)
  ) {
    return null;
  }

  const record = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { managedProfileAt: true },
  });
  if (record?.managedProfileAt == null) return null;

  const grants = await prisma.accountGrant.findMany({
    where: {
      grantorId: payload.userId,
      ...activeGuardianWhere(new Date()),
      grantee: { managedProfileAt: null },
    },
    select: {
      granteeId: true,
      grantee: { select: { managedProfileAt: true } },
    },
  });

  return grants
    .filter(
      (grant) =>
        grant.granteeId !== payload.userId &&
        grant.grantee.managedProfileAt == null,
    )
    .map((grant) => grant.granteeId);
}

/**
 * Resolve notification identities without treating a managed record as its
 * own destination. Legacy payloads remain valid only for ordinary self
 * delivery; a managed record must name an active Guardian explicitly. This is
 * a preflight for recipient channel selection; managed delivery is authorized
 * again under the same lock at each provider egress claim below.
 *
 * Cross-principal authorization preflight uses the locked grant read below.
 * The final authorization is a separate short transaction that commits a
 * durable egress claim immediately before the provider operation starts.
 */
/** No delivery: the record or the recipient is pending deletion. */
function deletionPending(): null {
  getEvent()?.addMeta("notification_skipped_deletion_pending", true);
  return null;
}

export async function resolveNotificationDeliveryIdentity(
  payload: NotificationPayload,
): Promise<NotificationDeliveryIdentity | null> {
  const hasRecordUserId = payload.recordUserId !== undefined;
  const hasRecipientUserId = payload.recipientUserId !== undefined;

  if (hasRecordUserId !== hasRecipientUserId) return null;

  const recordUserId = payload.recordUserId ?? payload.userId;
  const recipientUserId = payload.recipientUserId ?? payload.userId;
  if (!recordUserId || !recipientUserId || payload.userId !== recordUserId) {
    return null;
  }

  const record = await prisma.user.findUnique({
    where: { id: recordUserId },
    select: { managedProfileAt: true, deletionRequestedAt: true },
  });
  if (!record) return null;
  // Nothing is sent about, or to, an account pending deletion: it is locked,
  // and the person asked to be gone. Every reminder, digest and nudge passes
  // here, so a job that enumerates without the shared filter
  // (`active-account.ts`) still sends nothing.
  if (record.deletionRequestedAt != null) return deletionPending();

  if (record.managedProfileAt == null) {
    return recipientUserId === recordUserId
      ? { recordUserId, recipientUserId, managed: false }
      : null;
  }

  if (recipientUserId === recordUserId) return null;

  if (!isManagedGuardianFanoutAllowed(payload)) return null;
  const guardianPending = await prisma.user.count({
    where: { id: recipientUserId, deletionRequestedAt: { not: null } },
  });
  if (guardianPending > 0) return deletionPending();

  return withManagedGuardianAuthorization(recordUserId, recipientUserId, () =>
    Promise.resolve({ recordUserId, recipientUserId, managed: true }),
  );
}

/**
 * Create the final authorization claim for one managed Guardian channel.
 *
 * The claim commits while holding the same lifecycle lock as Guardian
 * revocation and expiry. Its commit is the linearization point: if a
 * revocation commits first, this returns null and no provider operation may
 * start. If the claim commits first, it authorizes one provider operation
 * that is already in flight from the lifecycle's perspective. The provider
 * operation runs only after this transaction commits, so slow networks never
 * retain a database transaction, advisory lock, or pooled connection. This is
 * the logical send time, not a promise that a later revocation or expiry can
 * recall an already-authorized provider operation before its first byte.
 */
export async function claimManagedGuardianEgressAuthorization(
  delivery: NotificationDeliveryIdentity,
  channel: ChannelType,
  eventType: string,
): Promise<{ id: string } | null> {
  if (!delivery.managed) return null;

  return withManagedGuardianAuthorization(
    delivery.recordUserId,
    delivery.recipientUserId,
    async (tx) => {
      const id = randomUUID();
      const claims = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "notification_egress_authorizations" (
          "id",
          "record_user_id",
          "recipient_user_id",
          "channel",
          "event_type",
          "authorized_at"
        )
        SELECT
          ${id},
          ${delivery.recordUserId},
          ${delivery.recipientUserId},
          ${channel},
          ${eventType},
          (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE EXISTS (
          SELECT 1
          FROM "account_grants"
          WHERE "grantor_id" = ${delivery.recordUserId}
            AND "grantee_id" = ${delivery.recipientUserId}
            AND "access" = 'MANAGE'::"account_grant_access"
            AND "accepted_at" IS NOT NULL
            AND "revoked_at" IS NULL
            AND (
              "expires_at" IS NULL
              OR "expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
            )
        )
        RETURNING "id"
      `;
      return claims[0] ?? null;
    },
  );
}

/**
 * Record a completed provider operation outside the lifecycle transaction.
 * This is observability only: authorization always rechecks the active grant,
 * and every retry creates a new claim regardless of a prior outcome.
 */
export async function completeManagedGuardianEgressAuthorization(
  authorizationId: string,
  outcome: "ok" | "hard_reject" | "transient_failure" | "sender_threw",
): Promise<void> {
  try {
    await prisma.notificationEgressAuthorization.update({
      where: { id: authorizationId },
      data: { completedAt: new Date(), outcome },
    });
  } catch {
    // The claim is intentionally durable even if the best-effort completion
    // marker cannot be written after an otherwise independent provider call.
  }
}

async function withManagedGuardianAuthorization<T>(
  recordUserId: string,
  recipientUserId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | null> {
  return prisma.$transaction((tx) =>
    withManagedProfileLock(tx, recordUserId, async (lockedRecord) => {
      if (lockedRecord?.managedProfileAt == null) return null;

      const recipient = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { managedProfileAt: true },
      });
      if (!recipient || recipient.managedProfileAt != null) return null;

      const guardian = await tx.accountGrant.findFirst({
        where: {
          grantorId: recordUserId,
          granteeId: recipientUserId,
          ...activeGuardianWhere(new Date()),
        },
        select: { id: true },
      });
      if (!guardian) return null;

      return operation(tx);
    }),
  );
}
