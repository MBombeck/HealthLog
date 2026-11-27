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
  /** Sets the admin notice aside, as the admin start page does. */
  noticeLater: "admin.notice.later",
  /** Opens the server setup. */
  setupOpen: "admin.setup.open",
  /**
   * `ask.later:<dismissKey>`: sets the ask aside for the rest of the local
   * day, through the dismiss ledger (`POST /api/daily/digest/dismiss` with
   * the key). The key names the day, so the ask returns tomorrow.
   */
  later: "ask.later",
} as const;

/** The dismiss-ledger namespace of a "later" on an ask. */
export const ASK_LATER_KEY_PREFIX = "ask-later";

/** `ask-later:<localDay>:<itemKey>`: one ask set aside for one local day. */
export function askLaterKey(localDay: string, itemKey: string): string {
  return `${ASK_LATER_KEY_PREFIX}:${localDay}:${itemKey}`;
}

/**
 * The categories a person may switch off for the start page (Settings ›
 * Dashboard). Everything else that asks is mandatory: a dose past its time
 * (the safety tier) and the admin's setup and consent questions.
 */
export const OPTIONAL_ASK_KINDS = [
  "dose_window",
  "preventive_care",
  "upcoming_visit",
  "coach_checkin",
  "sync_issue",
] as const;
