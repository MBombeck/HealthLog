/**
 * Why the APNs channel sent nothing although the account has sealed devices.
 * The channel names these itself and never borrows the plaintext sender's
 * "not configured" (`push-relay/apns-channel.ts`). A leaf, so the
 * dispatcher, the channel and the channel state can all read them.
 */

/** Nothing was due on this channel: the relay does not carry the event. */
export const APNS_EVENT_NOT_CARRIED = "apns_event_not_carried";

/** The account's sealed devices have no route at the moment. */
export const APNS_DEVICE_UNROUTED = "apns_device_unrouted";
