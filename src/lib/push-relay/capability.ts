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
 * - `operatorDecision` (`undecided` | `on` | `off`): the operator's one answer
 *   to "Send push notifications through the HealthLog relay?"
 *   (`operator-decision.ts`); `canDecide`: the caller is an admin of a server
 *   whose relay is available, not a demo deploy. The answer is given on the web admin page
 *   (`/admin`): the routes that give it are cookie-only (`requireAdmin()`), so
 *   an app signed in with a Bearer token opens that page instead.
 *
 * `push.device`: `transport` (`relay` | `direct` | `none`), `consent`,
 * `relayState`, `intakeSync` (`ok` | `degraded`), `liveActivityConsent`,
 * `liveActivityStarted` (`{ medicationId, slotInstant }` | null).
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
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
  operatorDecisionOf,
  storedRelayDecisionOf,
  type RelayOperatorDecision,
} from "@/lib/push-relay/operator-decision";
import { readOperatorRow } from "@/lib/settings/operator-row";
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
import {
  ROUTABLE_DEVICE_SELECT,
  routeFor,
  type DeviceRoute,
  type RoutableDevice,
} from "@/lib/push-relay/route-device";

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
  operatorDecision: RelayOperatorDecision;
  canDecide: boolean;
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

/** What `push.relay` and `push.device` are built from, read once. */
interface PushStateInputs {
  config: RelayConfig;
  registration: RegistrationRow | null;
  apnsConfigured: boolean;
  /** Read once per request, shared by `push.relay` and `push.device`. */
  senderKeys: Promise<PublishedSenderKey[]>;
}

async function pushStateInputs(
  config: RelayConfig = relayConfig(),
): Promise<PushStateInputs> {
  const registration = config.available ? await loadRegistration(config) : null;
  const senderKeys = senderKeysFor(registration);
  // Awaited by every reader; never left to reject unobserved.
  senderKeys.catch(() => undefined);
  return {
    config,
    registration,
    apnsConfigured: loadApnsConfig() !== null,
    senderKeys,
  };
}

/** `push.relay` of `/api/auth/me`. */
async function relayCapabilityOf(
  inputs: PushStateInputs,
  isAdmin: boolean,
): Promise<RelayCapability> {
  const { config, registration: row } = inputs;
  const operator = await readOperatorRow();
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
    senderKeys: await inputs.senderKeys,
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
    operatorDecision: operatorDecisionOf({
      stored: storedRelayDecisionOf(operator?.pushRelayDecision),
      offered: row !== null,
      available: config.available,
      apnsConfigured: inputs.apnsConfigured,
    }),
    // A demo deploy refuses every write and shares its account: nobody there
    // is asked a question they could not answer.
    canDecide: isAdmin && config.available && process.env.DEMO_MODE !== "true",
  };
}

/**
 * The way a push reaches `device`, by the rule the real send follows
 * (`routeFor` in `route-device.ts`), from what this request read. Shared by
 * `push.device` and the device's push diagnostics.
 */
export function deviceRouteOf(
  device: RoutableDevice,
  inputs: {
    registration: RegistrationRow | null;
    apnsConfigured: boolean;
  },
): DeviceRoute {
  return routeFor(device, {
    apnsConfigured: inputs.apnsConfigured,
    registration: inputs.registration,
    canSeal: sealsEnvelopes(inputs.registration),
  });
}

/**
 * What the app is told about a route. A plaintext push over this server's own
 * APNs key (a device without a push key) reads `direct`, as it always has:
 * the app only tells the server's key from the relay.
 */
export function transportOf(route: DeviceRoute): "relay" | "direct" | "none" {
  return route === "legacy" ? "direct" : route;
}

function displayTransport(
  device: RoutableDevice,
  inputs: PushStateInputs,
): "relay" | "direct" | "none" {
  return transportOf(deviceRouteOf(device, inputs));
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
  // Both questions at once: they read the same ledger independently.
  const [lastRecorded, undelivered] = await Promise.all([
    prisma.pushRelayDelivery.findFirst({
      where: { deviceId: device.id, eventType: INTAKE_RECORDED_EVENT },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    }),
    device.envelopeReportedAt
      ? prisma.pushRelayDelivery.count({
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
        })
      : 0,
  ]);
  if (lastRecorded?.status === "dropped" || lastRecorded?.status === "failed") {
    return "degraded";
  }
  if (undelivered > 0) return "degraded";
  return "ok";
}

/** What the `push.device` block reads of the device row. */
const DEVICE_BLOCK_SELECT = {
  ...ROUTABLE_DEVICE_SELECT,
  envelopeReportedAt: true,
  liveActivityConsentAt: true,
  userId: true,
  laStartedMedicationId: true,
  laStartedSlot: true,
} as const;

type DeviceBlockRow = Prisma.DeviceGetPayload<{
  select: typeof DEVICE_BLOCK_SELECT;
}>;

/** The `push.device` block for one device row. */
export async function devicePushBlock(
  deviceId: string,
): Promise<DevicePushBlock> {
  const [device, inputs] = await Promise.all([
    prisma.device.findUnique({
      where: { id: deviceId },
      select: DEVICE_BLOCK_SELECT,
    }),
    pushStateInputs(),
  ]);
  return devicePushBlockOf(device, inputs);
}

async function devicePushBlockOf(
  device: DeviceBlockRow | null,
  inputs: PushStateInputs,
): Promise<DevicePushBlock> {
  const row = inputs.registration;
  const transport = device ? displayTransport(device, inputs) : "none";
  const [intakeSync, senderKeys, liveActivityStarted] = await Promise.all([
    device && transport === "relay"
      ? intakeSyncOf(device, row)
      : ("ok" as const),
    inputs.senderKeys,
    device ? liveActivityStartedOf(device) : null,
  ]);
  return {
    transport,
    envelope: device?.pushKeyPublic && transport !== "none" ? 1 : null,
    consent: Boolean(device?.relayConsentAt),
    relayState: device?.relayState ?? "none",
    intakeSync,
    senderKeys,
    relayInstanceId: row?.instanceId ?? null,
    liveActivityConsent: Boolean(
      device?.relayConsentAt && device.liveActivityConsentAt,
    ),
    liveActivityStarted,
  };
}

/**
 * The `push` block of `/api/auth/me`: the relay, and the device the request
 * names in `X-Device-Id` (null when it names none of the caller's devices).
 * The registration, the device row and the sender keys are read once, side
 * by side; the device's own reads follow in one more round.
 */
export async function accountPushState(
  userId: string,
  request?: Request,
  options: { isAdmin?: boolean } = {},
): Promise<{ relay: RelayCapability; device: DevicePushBlock | null }> {
  const deviceToken = request?.headers.get("x-device-id") ?? null;
  const inputs = pushStateInputs();
  const [relay, device] = await Promise.all([
    inputs.then((i) => relayCapabilityOf(i, options.isAdmin === true)),
    deviceToken
      ? Promise.all([
          prisma.device.findFirst({
            where: { userId, token: deviceToken },
            select: DEVICE_BLOCK_SELECT,
          }),
          inputs,
        ]).then(([row, i]) => (row ? devicePushBlockOf(row, i) : null))
      : null,
  ]);
  return { relay, device };
}
