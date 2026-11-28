/**
 * Deterministic APNs mock for the test suite (v1.4.23).
 *
 * Test files swap the real `@/lib/notifications/senders/apns` module for
 * this one via `vi.mock()`, then drive behaviour through three exported
 * helpers:
 *
 *   - `recordedApnsSends`   — every `sendApnsPush()` call lands here in
 *                             arrival order. Tests assert on the
 *                             payload + topic + collapseId the
 *                             dispatcher produced.
 *   - `recordedApnsBatches` — every `sendViaApns(userId, payload)` call
 *                             records the userId + payload pair.
 *   - `setApnsResponse`     — queues a per-token response. The next
 *                             `sendApnsPush` for that token consumes the
 *                             top of the queue. When the queue is empty
 *                             the mock returns `{ ok: true, status: 200 }`.
 *   - `setApnsBatchOutcome` — controls what `sendViaApns()` returns.
 *                             Defaults to `{ ok: true }`.
 *   - `resetApnsMock`       — clears all recorded calls + queued
 *                             responses; call from `beforeEach`.
 *
 * No real APNs library is loaded — the mock is a drop-in replacement for
 * the sender module's exported surface so the dispatcher test path runs
 * fully offline.
 */
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import type {
  ApnsSendInput,
  ApnsSendResult,
} from "@/lib/notifications/senders/apns";

export interface RecordedApnsSend extends ApnsSendInput {
  /** Wall-clock time the dispatcher made the call. */
  at: Date;
}

export interface RecordedApnsBatch {
  userId: string;
  payload: {
    title: string;
    message: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  };
  at: Date;
}

export const recordedApnsSends: RecordedApnsSend[] = [];
export const recordedApnsBatches: RecordedApnsBatch[] = [];

const queuedResponses = new Map<string, ApnsSendResult[]>();
let queuedBatchOutcome: SendOutcome | null = null;

/**
 * Queue a per-device-token response for the next `sendApnsPush` call.
 * Calls without a queued response default to `{ ok: true, status: 200 }`.
 */
export function setApnsResponse(
  deviceToken: string,
  response: ApnsSendResult,
): void {
  const list = queuedResponses.get(deviceToken) ?? [];
  list.push(response);
  queuedResponses.set(deviceToken, list);
}

/**
 * Force the next (and every subsequent) `sendViaApns()` call to return
 * the supplied outcome. Pass `null` to restore the default of `{ ok: true }`.
 */
export function setApnsBatchOutcome(outcome: SendOutcome | null): void {
  queuedBatchOutcome = outcome;
}

/** Clear every recorded call + queued response. */
export function resetApnsMock(): void {
  recordedApnsSends.length = 0;
  recordedApnsBatches.length = 0;
  queuedResponses.clear();
  queuedBatchOutcome = null;
}

/** Mock counterpart to the real `loadApnsConfig()`. */
export function loadApnsConfig(): { bundleId: string } | null {
  return { bundleId: "test.healthlog.ios" };
}

/** Mock counterpart to `resetApnsForTesting()`. No-op here. */
export function resetApnsForTesting(): void {
  resetApnsMock();
}

export async function sendApnsPush(
  input: ApnsSendInput,
): Promise<ApnsSendResult> {
  recordedApnsSends.push({ ...input, at: new Date() });
  const queued = queuedResponses.get(input.deviceToken);
  if (queued && queued.length > 0) {
    return queued.shift() as ApnsSendResult;
  }
  return { ok: true, status: 200 };
}

export async function sendViaApns(
  userId: string,
  payload: {
    title: string;
    message: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  },
): Promise<SendOutcome> {
  recordedApnsBatches.push({ userId, payload, at: new Date() });
  return queuedBatchOutcome ?? { ok: true };
}
