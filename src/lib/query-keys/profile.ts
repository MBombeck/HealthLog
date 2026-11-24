/** Query keys for the bounded, read-only profile summary surface. */
export const profileKeys = {
  profileSummary: () => ["profile", "summary"] as const,
  /** Emergency ("Notfalldaten") profile (`GET`/`PATCH /api/anamnesis/emergency`). */
  emergencyProfile: () => ["emergency-profile"] as const,
  /** The emergency card (`GET /api/emergency-card`). */
  emergencyCard: () => ["emergency-card"] as const,
  /** The card's QR link status (`/api/emergency-card/link`). */
  emergencyCardLink: () => ["emergency-card", "link"] as const,
  /** The card's Apple Wallet pass mutations (`/api/emergency-card/wallet/apple`). */
  emergencyCardWallet: () => ["emergency-card", "wallet"] as const,
};
