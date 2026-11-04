/**
 * When a Garmin key stops working, and how close that is.
 *
 * Garmin does not publish a key's expiry anywhere the Personal API can read:
 * the key is opaque and the token's `exp` is the token's own day, until the
 * key's last day, when Garmin caps the token at the key's end. So the expiry
 * is known from one of two places, in this order:
 *
 *   1. learned: a token lived markedly less than a day (`./client.ts`), and
 *      its `exp` is the key's end;
 *   2. estimated: the validity the person picked when creating the key (30,
 *      90, 180 or 365 days), counted from the day it was connected here.
 *
 * Neither known: the state is `unknown`, and the card asks for the validity.
 * The warning starts a week ahead, which is when Garmin's own reminder mail
 * goes out.
 */

/** The validities Garmin Connect offers when a key is created, in days. */
export const GARMIN_KEY_VALIDITY_DAYS = [30, 90, 180, 365] as const;

export type GarminKeyValidityDays = (typeof GARMIN_KEY_VALIDITY_DAYS)[number];

/** How long before the end the card starts warning. */
export const GARMIN_KEY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type GarminKeyExpiryState = "ok" | "expiring" | "expired" | "unknown";

export interface GarminKeyExpiry {
  state: GarminKeyExpiryState;
  /** ISO instant, or null when unknown. */
  expiresAt: string | null;
  /** Whole days left (0 on the last day), or null when unknown or past. */
  daysLeft: number | null;
}

/** The expiry a picked validity gives, counted from `connectedAt`. */
export function estimateGarminKeyExpiry(
  connectedAt: Date,
  validityDays: GarminKeyValidityDays,
): Date {
  return new Date(connectedAt.getTime() + validityDays * DAY_MS);
}

/** Resolve the expiry state at `now`. */
export function resolveGarminKeyExpiry(
  expiresAt: Date | null,
  now: Date = new Date(),
): GarminKeyExpiry {
  if (!expiresAt) return { state: "unknown", expiresAt: null, daysLeft: null };
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) {
    return {
      state: "expired",
      expiresAt: expiresAt.toISOString(),
      daysLeft: null,
    };
  }
  const daysLeft = Math.floor(left / DAY_MS);
  return {
    state: daysLeft < GARMIN_KEY_WARNING_DAYS ? "expiring" : "ok",
    expiresAt: expiresAt.toISOString(),
    daysLeft,
  };
}
