/**
 * The action intents and constants of the asks (`asks.ts`), in a leaf
 * module the ask card and the settings can import without the server-side
 * policy and its imports.
 */
/** Action intents only an ask carries. */
export const ASK_INTENT = {
  /** `dose.snooze:<medicationId>`: the medication's own snooze. */
  doseSnooze: "dose.snooze",
  /** Answers the relay question with yes (opens its confirmations). */
  relayYes: "relay.yes",
  /** Answers the relay question with no, for the whole server. */
  relayNo: "relay.no",
  /** Opens the server setup. */
  setupOpen: "admin.setup.open",
  /**
   * `ask.later:<dismissKey>`: sets the ask aside for the rest of the local
   * day, through the dismiss ledger (`POST /api/daily/digest/dismiss` with
   * the key). The key names the day, so the ask returns tomorrow.
   */
  later: "ask.later",
  /**
   * Opens the emergency card's Wallet section to add the pass; the ask's
   * `href` is the web's page, the app opens its own add flow.
   */
  walletAdd: "emergency_wallet.add",
} as const;

/** The dismiss-ledger namespace of a "later" on an ask. */
export const ASK_LATER_KEY_PREFIX = "ask-later";

/** `ask-later:<localDay>:<itemKey>`: one ask set aside for one local day. */
export function askLaterKey(localDay: string, itemKey: string): string {
  return `${ASK_LATER_KEY_PREFIX}:${localDay}:${itemKey}`;
}

/**
 * The emergency-wallet ask's item key, and the dismiss-ledger key that holds
 * it back for good. Unlike a day's "later" it names no day: the offer is made
 * once, and "Later" or a pass made (`POST /api/emergency-card/wallet/apple`
 * writes the same row) ends it.
 */
export const EMERGENCY_WALLET_ASK_KEY = "emergency_wallet:offer";

/** Dismiss-ledger keys that set an ask aside for good, not for a day. */
export const ASK_SET_ASIDE_KEYS: readonly string[] = [EMERGENCY_WALLET_ASK_KEY];

/**
 * The categories a person may switch off for the start page (Settings ›
 * Dashboard). Everything else that asks is mandatory: a dose past its time
 * (the safety tier) and the admin's setup and consent questions.
 * `feature_offer` is no rail kind: it is the switch of the asks that offer
 * a feature the person has not used yet (`FEATURE_ASK_KINDS` in `asks.ts`).
 */
export const OPTIONAL_ASK_KINDS = [
  "dose_window",
  "preventive_care",
  "upcoming_visit",
  "coach_checkin",
  "sync_issue",
  "feature_offer",
] as const;
