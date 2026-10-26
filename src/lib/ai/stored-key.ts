/**
 * Opening a stored AI-provider key.
 */
import { decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";

/**
 * A stored provider key, or null when it cannot be opened: a key id retired
 * from `ENCRYPTION_KEYS`, a corrupt row. An unreadable key is an unconfigured
 * provider, the same as no key at all. Its entry drops out of the chain, so a
 * generation answers the no-provider refusal (422 `ai.provider.none`)
 * instead of the decrypt's 500, and the operator sees the warning.
 */
export function openStoredKey(encrypted: string): string | null {
  try {
    return decrypt(encrypted);
  } catch {
    getEvent()?.addWarning("ai: a stored provider key could not be opened");
    return null;
  }
}
