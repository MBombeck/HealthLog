/**
 * moodLog webhook secret — encrypt-at-rest helpers (V3 audit STILL-V2-C-2).
 *
 * Previously the `mood_log_webhook_secret` column stored the secret in
 * plaintext. The webhook handler did a timing-safe `Buffer.equals` against
 * every enabled user's plaintext secret to find a match.
 *
 * The new contract:
 *   - All writes go through `encryptMoodLogSecret()` → AES-256-GCM
 *     base64 envelope.
 *   - Reads go through `readMoodLogSecret()` which decrypts envelopes;
 *     if a stored value is NOT a valid envelope it is treated as a legacy
 *     plaintext secret (transitional grace period). Operators can leave
 *     existing rows in place — the next write rotates them to encrypted.
 *
 * The webhook lookup still iterates candidates, but each candidate is
 * decrypted before the timing-safe compare. Cost is O(n) decrypt calls
 * per webhook invocation; acceptable for small deployments and easily
 * upgraded later by adding an HMAC lookup column.
 */
import { encrypt, decrypt, extractKeyId } from "@/lib/crypto";

export function encryptMoodLogSecret(plaintext: string): string {
  return encrypt(plaintext);
}

export function readMoodLogSecret(stored: string | null): string | null {
  if (!stored) return null;
  // Anything carrying a `<keyId>.<payload>` envelope must decrypt
  // cleanly. A failure here means either the active key map no longer
  // includes the version this row was written under (rotation playbook
  // not finished) or the ciphertext was tampered with directly in the
  // column. Returning the raw envelope bytes as if they were the
  // plaintext secret would silently turn a corrupted row into an
  // attacker-chosen webhook secret — so surface the failure instead.
  if (extractKeyId(stored) !== null) {
    return decrypt(stored);
  }
  // Legacy plaintext path — unprefixed values predate the encrypt-at-
  // rest contract. Return as-is so the integration keeps working until
  // the next write rotates them; `rotateLegacyMoodLogSecrets()` runs
  // at boot to convert them.
  return stored;
}

/**
 * Whether the stored value still looks like an unencrypted legacy secret.
 * Used by the boot-time migration helper + the rotation flow.
 */
export function isLegacyPlaintext(stored: string | null): boolean {
  if (!stored) return false;
  // A row is legacy plaintext only when it does NOT carry the
  // `<keyId>.<payload>` envelope. Envelope-shaped rows are encrypted —
  // even ones we currently can't decrypt (which should fail loud, not
  // get re-rotated as if they were plaintext).
  return extractKeyId(stored) === null;
}

interface MoodLogSecretMigrationDeps {
  findLegacy: () => Promise<
    Array<{ id: string; moodLogWebhookSecret: string | null }>
  >;
  rotate: (id: string, encryptedSecret: string) => Promise<void>;
}

/**
 * One-shot startup migration: encrypts any leftover plaintext secret rows
 * with AES-GCM. Idempotent — encrypted rows are skipped automatically.
 * Returns the number of rows rotated.
 */
export async function rotateLegacyMoodLogSecrets(
  deps: MoodLogSecretMigrationDeps,
): Promise<number> {
  const candidates = await deps.findLegacy();
  let rotated = 0;
  for (const row of candidates) {
    if (!row.moodLogWebhookSecret) continue;
    if (!isLegacyPlaintext(row.moodLogWebhookSecret)) continue;
    const encrypted = encryptMoodLogSecret(row.moodLogWebhookSecret);
    await deps.rotate(row.id, encrypted);
    rotated += 1;
  }
  return rotated;
}
