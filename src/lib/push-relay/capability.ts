/**
 * What `/api/auth/me` publishes about the push relay (`push.relay`), what it
 * says about the calling device (`push.device`), and the same device block
 * `POST /api/devices` answers with. The app gates on these fields only.
 *
 * `push.relay`:
 * - `host`: the relay host the app's signed statements name.
 * - `available`: this server can use a relay (`PUSH_RELAY_MODE`, pinned
 *   relay keys); `offered`: the operator turned it on.
 * - `state` (`ok` | `degraded` | `down` | `off`), `since`, `reason`.
 * - `instanceId`: what the app signs its binding statement for.
 * - `senderKeys`: the keys the app pins for this account; present whenever
 *   this server seals envelopes, over the relay or over its own APNs key.
 * - `envelopeVersions`, `liveActivity` (`end`, plus `start` and `update`
 *   while the operator's switch `PUSH_RELAY_LIVE_ACTIVITY` is on),
 *   `liveActivityConsentTextVersion`, `termsUrl`, `privacyUrl`,
 *   `consentTextVersion`.
 *
 * `push.device`: `transport` (`relay` | `direct` | `none`), `consent`,
 * `relayState`, `intakeSync` (`ok` | `degraded`), `liveActivityConsent`,
 * `liveActivityStarted` (`{ medicationId, slotInstant }` | null).
 */
import { prisma } from "@/lib/db";
import { loadApnsConfig } from "@/lib/notifications/senders/apns";
import {
  ENVELOPE_VERSIONS,
  LIVE_ACTIVITY_CONSENT_TEXT_VERSION,
  LIVE_ACTIVITY_EVENTS,
  LIVE_ACTIVITY_RELAY_EVENTS,
  liveActivityRelayEnabled,
  RELAY_CONSENT_TEXT_VERSION,
  relayConfig,
  relayDocumentUrls,
  type RelayConfig,
} from "@/lib/push-relay/config";
import { isCircuitOpen } from "@/lib/push-relay/circuit";
import {
  liveActivityStartedOf,
  type LiveActivityStarted,
} from "@/lib/push-relay/live-activity-started";
import {
  ensureEnvelopeKeys,
  publishedSenderKeys,
  type PublishedSenderKey,
} from "@/lib/push-relay/sender-keys";
import {
  loadRegistration,
  type RegistrationRow,
} from "@/lib/push-relay/registration";

/** The event whose dropped delivery makes `intakeSync` degraded. */
const INTAKE_RECORDED_EVENT = "MEDICATION_INTAKE_RECORDED";

export type RelayHealth = "ok" | "degraded" | "down" | "off";

export interface RelayCapability {
  /** The relay host every statement the app signs names. */
  host: string | null;
  available: boolean;
  offered: boolean;
  state: RelayHealth;
  since: string | null;
  reason: string | null;
  instanceId: string | null;
  senderKeys: PublishedSenderKey[];
  envelopeVersions: number[];
  liveActivity: string[];
  liveActivityConsentTextVersion: string;
  termsUrl: string | null;
  privacyUrl: string | null;
  consentTextVersion: string;
}

export interface DevicePushBlock {
  transport: "relay" | "direct" | "none";
  envelope: number | null;
  consent: boolean;
  relayState: string;
  intakeSync: "ok" | "degraded";
  senderKeys: PublishedSenderKey[];
  relayInstanceId: string | null;
  liveActivityConsent: boolean;
  /** The dose the server-started Live Activity shows (`live-activity-started.ts`). */
  liveActivityStarted: LiveActivityStarted | null;
}

/** The health the app sees for a registration. */
export function relayHealth(row: RegistrationRow | null): {
  state: RelayHealth;
  since: Date | null;
  reason: string | null;
} {
  if (!row) return { state: "off", since: null, reason: null };
  if (isCircuitOpen(row)) {
    return {
      state: "down",
      since: row.circuitOpenedAt,
      reason: "circuit_open",
    };
  }
  const state: RelayHealth =
    row.state === "ok" ? "ok" : row.state === "degraded" ? "degraded" : "down";
  return { state, since: row.stateSince, reason: row.stateReason };
}

/** Whether this server seals envelopes at all. */
function sealsEnvelopes(row: RegistrationRow | null): boolean {
  return row !== null || loadApnsConfig() !== null;
}

async function senderKeysFor(
  row: RegistrationRow | null,
): Promise<PublishedSenderKey[]> {
  if (!sealsEnvelopes(row)) return [];
  return publishedSenderKeys(await ensureEnvelopeKeys());
}

/** `push.relay` of `/api/auth/me`. */
export async function relayCapability(
  config: RelayConfig = relayConfig(),
): Promise<RelayCapability> {
  const row = config.available ? await loadRegistration(config) : null;
  const health = relayHealth(row);
  const docs = config.origin ? relayDocumentUrls(config.origin) : null;
  const sealing = sealsEnvelopes(row);
  return {
    host: config.host || null,
    available: config.available,
    offered: row !== null,
    state: health.state,
    since: health.since?.toISOString() ?? null,
    reason: health.reason,
    instanceId: row?.instanceId ?? null,
    senderKeys: await senderKeysFor(row),
    envelopeVersions: sealing ? [...ENVELOPE_VERSIONS] : [],
    liveActivity: row
      ? [
          ...LIVE_ACTIVITY_EVENTS,
          ...(liveActivityRelayEnabled() ? LIVE_ACTIVITY_RELAY_EVENTS : []),
        ]
      : [],
    liveActivityConsentTextVersion: LIVE_ACTIVITY_CONSENT_TEXT_VERSION,
    termsUrl: docs?.termsUrl ?? null,
    privacyUrl: docs?.privacyUrl ?? null,
    consentTextVersion: RELAY_CONSENT_TEXT_VERSION,
  };
}

/** How a push reaches this device: own APNs key, the relay, or not at all. */
export function deviceTransport(
  device: { relayState: string; relayConsentAt: Date | null },
  row: RegistrationRow | null,
  apnsConfigured: boolean,
): "relay" | "direct" | "none" {
  if (apnsConfigured) return "direct";
  if (
    row?.instanceId &&
    device.relayConsentAt &&
    device.relayState === "bound"
  ) {
    return "relay";
  }
  return "none";
}

const UNDELIVERED_GRACE_MS = 10 * 60 * 1000;

/**
 * Whether the confirmation of a dose recorded elsewhere can be trusted to
 * reach this device: `degraded` when the relay is not healthy, when the last
 * `MEDICATION_INTAKE_RECORDED` to the device was dropped, or when a push the
 * relay accepted was never opened although the device reported receipts well
 * after it.
 */
export async function intakeSyncOf(
  device: { id: string; envelopeReportedAt: Date | null },
  row: RegistrationRow | null,
): Promise<"ok" | "degraded"> {
  if (relayHealth(row).state !== "ok") return "degraded";
  const lastRecorded = await prisma.pushRelayDelivery.findFirst({
    where: { deviceId: device.id, eventType: INTAKE_RECORDED_EVENT },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  if (lastRecorded?.status === "dropped" || lastRecorded?.status === "failed") {
    return "degraded";
  }
  if (device.envelopeReportedAt) {
    const undelivered = await prisma.pushRelayDelivery.count({
      where: {
        deviceId: device.id,
        status: "accepted",
        confirmedAt: null,
        pushClass: { in: ["alert", "silent"] },
        acceptedAt: {
          lt: new Date(
            device.envelopeReportedAt.getTime() - UNDELIVERED_GRACE_MS,
          ),
        },
      },
    });
    if (undelivered > 0) return "degraded";
  }
  return "ok";
}

/** The `push.device` block for one device row. */
export async function devicePushBlock(
  deviceId: string,
): Promise<DevicePushBlock> {
  const config = relayConfig();
  const [device, row] = await Promise.all([
    prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        pushKeyPublic: true,
        relayState: true,
        relayConsentAt: true,
        envelopeReportedAt: true,
        liveActivityConsentAt: true,
        userId: true,
        laStartedMedicationId: true,
        laStartedSlot: true,
      },
    }),
    config.available ? loadRegistration(config) : null,
  ]);
  const transport = device
    ? deviceTransport(device, row, loadApnsConfig() !== null)
    : "none";
  return {
    transport,
    envelope: device?.pushKeyPublic && transport !== "none" ? 1 : null,
    consent: Boolean(device?.relayConsentAt),
    relayState: device?.relayState ?? "none",
    intakeSync:
      device && transport === "relay" ? await intakeSyncOf(device, row) : "ok",
    senderKeys: await senderKeysFor(row),
    relayInstanceId: row?.instanceId ?? null,
    liveActivityConsent: Boolean(
      device?.relayConsentAt && device.liveActivityConsentAt,
    ),
    liveActivityStarted: device ? await liveActivityStartedOf(device) : null,
  };
}

/** `push.device` for the device named by `X-Device-Id`, else null. */
export async function callingDevicePushBlock(
  userId: string,
  deviceToken: string | null,
): Promise<DevicePushBlock | null> {
  if (!deviceToken) return null;
  const device = await prisma.device.findFirst({
    where: { userId, token: deviceToken },
    select: { id: true },
  });
  return device ? devicePushBlock(device.id) : null;
}

/**
 * The `push` block of `/api/auth/me`: the relay, and the device the request
 * names in `X-Device-Id` (null when it names none of the caller's devices).
 */
export async function accountPushState(
  userId: string,
  request?: Request,
): Promise<{ relay: RelayCapability; device: DevicePushBlock | null }> {
  return {
    relay: await relayCapability(),
    device: await callingDevicePushBlock(
      userId,
      request?.headers.get("x-device-id") ?? null,
    ),
  };
}
