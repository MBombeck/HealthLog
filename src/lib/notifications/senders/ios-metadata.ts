/**
 * The custom keys an iOS push may carry beside `aps`, chosen from the
 * dispatcher payload's channel-shared `metadata`. One answer for every APNs
 * path: the plaintext alert (`apns.ts`) and the `d` of a sealed envelope
 * (`push-relay/apns-channel.ts`).
 */

/**
 * Whitelist the metadata keys we send through to iOS. The dispatcher
 * payload's `metadata` field is shared across every channel — Telegram
 * stuffs an `replyMarkup` keyboard in there, future channels will add
 * their own extras — and forwarding the lot to APNs leaks
 * channel-specific payload structures into the APNs userInfo Apple
 * sees plus the iOS app's notification handler.
 *
 * Allowed keys are the ones the iOS app actually reads. Add a new key
 * here as iOS gains support for it.
 */
const IOS_METADATA_ALLOWLIST = new Set([
  "scheduledAt",
  "localDate",
  "medicationId",
  "scheduleId",
  "phase",
  "date",
  // MEDICATION_LOW_STOCK deep link + context: the in-app
  // path the push should open (`/medications/{id}?tab=supply`) plus
  // the runway / threshold figures the iOS handler can surface.
  "url",
  "runwayDays",
  "thresholdDays",
  // MEASUREMENT_REMINDER carries the reminder's id so a
  // foreground / handled notification can POST the completion directly
  // instead of routing through the capture deep link.
  "reminderId",
  // SEIZURE_CLUSTER names the seizure that formed the cluster, so the app
  // can open it; an opaque id, and dropped for a managed delivery.
  "eventId",
  // SECURITY_ALERT: which change it reports (`new_device`, `passkey_added`,
  // `passkey_removed`, `token_revoked`, `refresh_reuse`), so the app opens
  // the account's security page. A closed set, no credential.
  "securityKind",
]);

export function pickIosMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (IOS_METADATA_ALLOWLIST.has(key)) {
      out[key] = metadata[key];
    }
  }
  return out;
}

/**
 * Metadata keys that exist so the iOS app can ACT on the notification rather
 * than merely read it. Dropped when the producer says the dispatch carries no
 * completion affordance.
 */
const ACTION_METADATA_KEYS = new Set(["reminderId"]);

/**
 * Strip the act-on-it keys from a payload whose actions the server will refuse.
 *
 * An appointment nudge rides the same `MEASUREMENT_REMINDER` event type as a
 * checkup, so the iOS app would offer the registered "Erledigt" action and
 * POST a completion the by-id reminder family answers 404 for. Removing the
 * id is what removes the action: the handler has nothing to complete.
 */
function stripActionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (!ACTION_METADATA_KEYS.has(key)) out[key] = metadata[key];
  }
  return out;
}

/** Cycle-semantic metadata keys that must never ride a discreet payload. */
const CYCLE_METADATA_KEYS = new Set(["phase"]);

/**
 * Drop cycle-semantic metadata (e.g. `phase`) so a discreet cycle push can't
 * name a cycle concept on the wire even though the allowlist permits the key.
 */
function stripCycleMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (!CYCLE_METADATA_KEYS.has(key)) out[key] = metadata[key];
  }
  return out;
}

/**
 * The metadata a push for `payload` carries: none for a managed Guardian
 * delivery, the act-on-it keys dropped when the dispatch offers no action,
 * the cycle keys dropped in discreet mode, then the iOS allowlist.
 */
export function iosMetadataFor(
  payload: {
    metadata?: Record<string, unknown>;
    discreet?: boolean;
    suppressActions?: boolean;
  },
  managedDelivery: boolean,
): Record<string, unknown> {
  if (managedDelivery) return {};
  const base = payload.discreet
    ? stripCycleMetadata(payload.metadata)
    : payload.metadata;
  return pickIosMetadata(
    payload.suppressActions ? stripActionMetadata(base) : base,
  );
}
