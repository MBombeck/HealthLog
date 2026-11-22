/**
 * The capability re-check at the wire.
 *
 * `requireAiCapability` answers at the top of a route, before anything is
 * picked. That is the refusal a client sees, but it is not the last word: a
 * route may pick its provider in its own order, and a job enqueued before the
 * operator turned a switch off runs long after any route answered. So every
 * place that hands input to a model (the document provider pick, the labs
 * scan, the medication extractor, the fenced document chat) asks again here,
 * with the provider it is about to send to, immediately before it sends.
 *
 * Two questions, both about the actual wire:
 *
 *   1. Is the capability still open for this record? Inside a request this is
 *      the request's own resolution (memoised per request, so the answer
 *      matches the one the route gave); outside a request it is the job's
 *      resolution for the record it names.
 *   2. Does sending to exactly these providers need a consent receipt, and is
 *      one active? Presence cannot answer this for a route that reads the
 *      chain in its own order, so the pick answers it here, from the same
 *      rule and the same receipt kinds the capability table declares.
 *
 * `no_provider` is never answered here: a caller that has a pick has a
 * provider, and one without a pick refuses with its own typed code.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { noteAiJobEvent } from "@/lib/ai/job-failure/witness";

import { aiCapabilityForJob, requireAiCapability } from "./gate";
import { AiUnavailableError } from "./refusal";
import { consentNeededForProviders } from "./resolve";
import {
  AI_CAPABILITIES,
  PICK_DECIDED_REASONS,
  type AiCapabilityKey,
} from "./types";

/** Whether the record holds an active receipt of one of these kinds. */
async function hasActiveReceipt(
  recordId: string,
  kinds: readonly string[],
): Promise<boolean> {
  const row = await prisma.consentReceipt.findFirst({
    where: { userId: recordId, revokedAt: null, kind: { in: [...kinds] } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Why input may not leave for these providers right now, or `null` when it
 * may. Never throws for a refusal; a database error propagates, which is the
 * closed direction for a caller about to send.
 *
 * @param recordId The record the input belongs to. Inside a request the
 *   request's own record is used, which is the record the route acts on.
 * @param providerTypes The providers the input is about to reach: the one
 *   picked provider for a single-pick read, the whole chain for a cascade.
 */
export async function aiEgressRefusal(
  key: AiCapabilityKey,
  recordId: string,
  providerTypes: readonly string[],
): Promise<AiUnavailableError | null> {
  const refusal = await egressRefusal(key, recordId, providerTypes);
  // #1404 — the exact answer for the pick, for the background job this runs
  // inside (`job-failure/witness.ts`): it replaces a presence answer.
  noteAiJobEvent(
    refusal
      ? {
          type: "refused",
          capability: key,
          userId: recordId,
          reason: refusal.reason,
          tentative: false,
        }
      : { type: "admitted", capability: key, userId: recordId },
  );
  return refusal;
}

async function egressRefusal(
  key: AiCapabilityKey,
  recordId: string,
  providerTypes: readonly string[],
): Promise<AiUnavailableError | null> {
  if (getEvent()?.getAuth()?.user_id) {
    try {
      await requireAiCapability(key, { pickDecides: true });
    } catch (error) {
      if (error instanceof AiUnavailableError) return error;
      throw error;
    }
  } else {
    const state = await aiCapabilityForJob(recordId, key);
    if (state.reason !== null && !PICK_DECIDED_REASONS.has(state.reason)) {
      return new AiUnavailableError(key, state.reason);
    }
  }

  if (
    consentNeededForProviders(key, providerTypes) &&
    !(await hasActiveReceipt(recordId, AI_CAPABILITIES[key].consent.kinds))
  ) {
    return new AiUnavailableError(key, "consent_required");
  }
  return null;
}

/** {@link aiEgressRefusal}, thrown. For routes, where `apiHandler` renders it. */
export async function assertAiEgress(
  key: AiCapabilityKey,
  recordId: string,
  providerTypes: readonly string[],
): Promise<void> {
  const refusal = await aiEgressRefusal(key, recordId, providerTypes);
  if (refusal) throw refusal;
}
