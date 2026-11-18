/**
 * In-memory last-working-provider cache for chain resolution.
 */
import type { ProviderChainType } from "./provider-chain";

export const LAST_WORKING_TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry {
  providerType: ProviderChainType;
  expiresAt: number;
}

const lastWorkingCache = new Map<string, CacheEntry>();

/** Test-only entry-point: empty the in-memory cache between cases. */
export function clearLastWorkingProviderCache(): void {
  lastWorkingCache.clear();
}

/**
 * Fetch the cached "last working provider" for the user, or null if
 * none is cached or the entry has expired. Reads consult `Date.now()`
 * so test code can manipulate `vi.useFakeTimers()` to exercise TTL.
 */
export function getLastWorkingProvider(
  userId: string,
): ProviderChainType | null {
  const entry = lastWorkingCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    lastWorkingCache.delete(userId);
    return null;
  }
  return entry.providerType;
}

/**
 * Drop one user's "last working provider" memo. Called when the person saves
 * a new chain: the memo reorders the chain they just arranged, and a provider
 * they removed or disabled must not keep leading it for up to an hour.
 */
export function forgetLastWorkingProvider(userId: string): void {
  lastWorkingCache.delete(userId);
}

export function rememberWorkingProvider(
  userId: string,
  candidate:
    | { providerType: ProviderChainType; pinned?: boolean }
    | ProviderChainType,
): void {
  if (typeof candidate === "object") {
    if (candidate.pinned) return;
    lastWorkingCache.set(userId, {
      providerType: candidate.providerType,
      expiresAt: Date.now() + LAST_WORKING_TTL_MS,
    });
    return;
  }
  lastWorkingCache.set(userId, {
    providerType: candidate,
    expiresAt: Date.now() + LAST_WORKING_TTL_MS,
  });
}
