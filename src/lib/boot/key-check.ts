/**
 * Runs the encryption key check once per process at boot and records the
 * verdict for the request path (`./key-mismatch-state.ts`).
 *
 * Returns true when the process must refuse: the caller then starts neither
 * the queue producer nor the worker, because a process holding the wrong key
 * must never write. The process keeps running so `/api/health` and the
 * explanation page can say why; a crash loop would hide the reason in a log
 * that the people most likely to hit this (a NAS app catalog install) never
 * open.
 */
import {
  checkEncryptionKeyCanaries,
  keyMismatchLogBlock,
  type CanaryClient,
  type InconclusiveReason,
} from "@/lib/crypto/canary";
import {
  getKeyCheckMode,
  setKeyMismatchState,
  setKeyMismatchWarning,
} from "./key-mismatch-state";

const INCONCLUSIVE_EXPLANATION: Record<InconclusiveReason, string> = {
  "single-value": "the only stored value found under that id did not open.",
  mixed:
    "the oldest stored values under that id do not open, newer ones do. " +
    "That is what a wrong key that served for a while leaves behind; check " +
    "that this is the key the database was first written with.",
  unsampled:
    "the values stored under that id are too large to probe at start-up.",
  incomplete:
    "the probe of the stored data did not finish in time or a table could " +
    "not be read.",
};

export async function runBootKeyCheck(client: CanaryClient): Promise<boolean> {
  const mode = getKeyCheckMode();
  const outcome = await checkEncryptionKeyCanaries(client, { mode });
  setKeyMismatchWarning(null);
  if (outcome.state === "mismatch") {
    const state = {
      keyIds: outcome.keyIds,
      detectedAt: new Date().toISOString(),
    };
    console.error(keyMismatchLogBlock(outcome.keyIds));
    if (mode === "warn") {
      // The operator turned the refusal off. Say so next to the block, keep
      // the finding for /api/health, and serve.
      setKeyMismatchState(null);
      setKeyMismatchWarning(state);
      console.error(
        "[boot] ENCRYPTION_KEY_CHECK=warn: serving anyway. No key is recorded " +
          "while the check does not pass. Remove the setting once the key is " +
          "confirmed.",
      );
      return false;
    }
    setKeyMismatchState(state);
    return true;
  }
  setKeyMismatchState(null);
  if (outcome.state === "error") {
    // The check could not run. The loaders and the database each have their
    // own loud signal for that; serving stays on.
    console.warn(
      `[boot] Encryption key check skipped: ${outcome.message.slice(0, 300)}`,
    );
  } else {
    for (const { keyId, reason } of outcome.inconclusive) {
      console.warn(
        `[boot] Encryption key check inconclusive for key id ${keyId}: ` +
          `${INCONCLUSIVE_EXPLANATION[reason]} Serving; no key recorded; ` +
          "the check runs again at the next start.",
      );
    }
    if (mode === "warn" && outcome.inconclusive.length > 0) {
      console.warn(
        "[boot] ENCRYPTION_KEY_CHECK=warn: no key recorded on this start " +
          "because the check did not pass for every key id.",
      );
    }
    if (outcome.written.length > 0) {
      console.info(
        `[boot] Encryption key check: recorded key id(s) ${outcome.written.join(", ")}`,
      );
    }
  }
  return false;
}
