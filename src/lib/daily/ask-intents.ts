/**
 * The action intents only an ask carries (`asks.ts`), in a leaf module the
 * ask card can import without the server-side policy and its imports.
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
} as const;
