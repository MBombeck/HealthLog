import { AsyncLocalStorage } from "node:async_hooks";

import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { findActiveGrant } from "@/lib/sharing/grant-access";

/**
 * The authority that admitted provider work for a record.
 *
 * This envelope carries only durable identifiers. It travels in queue payloads,
 * never health content, so a worker can reject stale or delegated work before
 * a provider sees the record.
 */
export interface ProviderWorkAuthority {
  origin: "owner" | "delegate" | "guardian" | "system";
  recordUserId: string;
  actorUserId: string | null;
  grantId: string | null;
}

export type ProviderCredentialPolicy = "personal" | "operator-default" | "deny";

const workerAuthority = new AsyncLocalStorage<ProviderWorkAuthority>();

export function providerCredentialPolicy(
  authority: ProviderWorkAuthority | null,
  managedProfileAt: Date | null = null,
): ProviderCredentialPolicy {
  if (authority === null) return "deny";
  if (authority.origin === "delegate") return "deny";
  if (authority.origin === "guardian") return "operator-default";
  if (authority.origin === "system" && managedProfileAt !== null) {
    return "operator-default";
  }
  return "personal";
}

/**
 * Resolve the request or worker authority for exactly one record.
 *
 * A request that authenticated an actor but did not declare why it may reach a
 * different record has no authority to enqueue work for that record. Background
 * reconciliation has no actor and is represented explicitly as `system`.
 */
export function providerWorkAuthorityForRecord(
  recordUserId: string,
): ProviderWorkAuthority | null {
  const worker = workerAuthority.getStore();
  if (worker) {
    return worker.recordUserId === recordUserId ? worker : null;
  }

  const auth = getEvent()?.getAuth();
  const requestAuthority = auth?.provider_work_authority;
  if (requestAuthority) {
    return requestAuthority.recordUserId === recordUserId
      ? requestAuthority
      : null;
  }

  if (auth?.user_id) {
    return auth.user_id === recordUserId
      ? {
          origin: "owner",
          recordUserId,
          actorUserId: recordUserId,
          grantId: null,
        }
      : null;
  }

  return {
    origin: "system",
    recordUserId,
    actorUserId: null,
    grantId: null,
  };
}

export function mayEnqueueProviderWork(
  authority: ProviderWorkAuthority | null,
): authority is ProviderWorkAuthority {
  return authority !== null && authority.origin !== "delegate";
}

/** Recheck durable admission immediately before worker dispatch. */
export async function mayDispatchProviderWork(
  authority: ProviderWorkAuthority | undefined,
): Promise<boolean> {
  if (!authority) return false;

  switch (authority.origin) {
    case "owner":
      return (
        authority.actorUserId === authority.recordUserId &&
        authority.grantId === null
      );
    case "system":
      return authority.actorUserId === null && authority.grantId === null;
    case "delegate":
      return false;
    case "guardian": {
      if (
        authority.actorUserId === null ||
        authority.actorUserId === authority.recordUserId ||
        authority.grantId === null
      ) {
        return false;
      }
      const [record, grant] = await Promise.all([
        prisma.user.findUnique({
          where: { id: authority.recordUserId },
          select: { managedProfileAt: true },
        }),
        findActiveGrant({
          grantorId: authority.recordUserId,
          granteeId: authority.actorUserId,
        }),
      ]);
      return (
        record?.managedProfileAt != null &&
        grant?.id === authority.grantId &&
        grant.access === "MANAGE"
      );
    }
  }
}

export async function withProviderWorkAuthority<T>(
  authority: ProviderWorkAuthority,
  work: () => Promise<T>,
): Promise<T> {
  return workerAuthority.run(authority, work);
}
