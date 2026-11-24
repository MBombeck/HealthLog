/**
 * The emergency card's block of `/api/auth/me` as the client keeps it: the
 * Apple Wallet state for the record on screen, resolved on the server
 * (`emergency-card/wallet-pass/availability.ts`) and rendered as published.
 */
import type { EmergencyWalletApple } from "@/lib/emergency-card/wallet-pass/availability";

export type MeEmergency = { wallet: { apple: EmergencyWalletApple } };

/** The block as sent, or null when it is missing or not an object. */
export function readMeEmergency(value: unknown): MeEmergency | null {
  const apple = (value as { wallet?: { apple?: unknown } } | null)?.wallet
    ?.apple;
  return apple && typeof apple === "object" ? (value as MeEmergency) : null;
}
