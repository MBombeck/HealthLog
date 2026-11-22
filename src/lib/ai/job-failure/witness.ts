/**
 * #1404 — what one background job's AI work ran into, noted where it happens.
 *
 * Most background work never lets the reason reach the job: a document read
 * turns a provider error into "could not read the document", a status note
 * falls back to its template sentence, a capability refusal is a quiet skip.
 * The places that know the reason are few and shared, so they note it here:
 *
 *   - every provider call, served or failed (`logChainCalls`, attached to
 *     every entry `resolveProviderChain` builds);
 *   - every capability refusal a worker reads (`aiCapabilityForJob`), and the
 *     exact answer for the provider a job picked (`aiEgressRefusal`);
 *   - what a job knows itself (`noteAiJobFailure`: a spent budget, a file the
 *     provider cannot read).
 *
 * `trackAiJob` (`./report.ts`) opens a witness around one job's work and turns
 * what was noted into the recorded reason when the work ends. Outside a
 * tracked job there is no witness and noting does nothing, so an interactive
 * request pays nothing and records nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AiCapabilityKey,
  AiUnavailableReason,
} from "@/lib/ai/capabilities/types";
import type { ProviderFailureKind } from "@/lib/ai/failure-kind";

import type { AiJobFailureCode } from "./types";

export type WitnessEvent =
  | {
      type: "served";
      capability: AiCapabilityKey | null;
      providerType: string;
    }
  | {
      type: "failed";
      capability: AiCapabilityKey | null;
      providerType: string;
      failure: ProviderFailureKind;
      httpStatus: number | null;
    }
  | {
      /**
       * A capability refusal. `tentative` when it is the presence answer for
       * a provider or a consent (`PICK_DECIDED_REASONS`): the job's own pick
       * may still find one, and then notes `admitted`.
       */
      type: "refused";
      capability: AiCapabilityKey;
      userId: string;
      reason: AiUnavailableReason;
      tentative: boolean;
    }
  | { type: "admitted"; capability: AiCapabilityKey; userId: string }
  | {
      type: "code";
      capability: AiCapabilityKey | null;
      code: AiJobFailureCode;
      providerType: string | null;
    };

export interface AiJobWitness {
  events: WitnessEvent[];
}

const storage = new AsyncLocalStorage<AiJobWitness>();

/** Run `fn` with `witness` as the current job's witness. */
export function withAiJobWitness<T>(
  witness: AiJobWitness,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(witness, fn);
}

/** Note one event on the current job's witness, when there is one. */
export function noteAiJobEvent(event: WitnessEvent): void {
  const witness = storage.getStore();
  if (!witness) return;
  // Bounded: a long walk keeps only what decides its ending.
  if (witness.events.length >= 128) witness.events.shift();
  witness.events.push(event);
}

/**
 * A failure the job knows the reason for itself, on its own capability. Use
 * it only for what no shared place can see; a provider failure and a
 * capability refusal are noted already.
 */
export function noteAiJobFailure(
  code: AiJobFailureCode,
  providerType: string | null = null,
): void {
  noteAiJobEvent({ type: "code", capability: null, code, providerType });
}
