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
 *   to "Use the HealthLog push relay?"
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
import { relayStateAt } from "@/lib/push-relay/relay-state";
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
      registered: row?.instanceId != null,
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
/** How far back the receipt and drop evidence reaches. */
const INTAKE_SYNC_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Why `intakeSync` reads `degraded`; null while it reads `ok`. Shown in the
 * device's push diagnostics.
 * - `relay`: the relay is not healthy.
 * - `intake_recorded_dropped`: the last dose confirmation to the device was
 *   dropped or failed, and no alert after it was opened.
 * - `alert_unconfirmed`: the newest alert the relay accepted was never opened
 *   although the device reported receipts well after it.
 */
export type IntakeSyncReason =
  "relay" | "intake_recorded_dropped" | "alert_unconfirmed";

export interface IntakeSyncState {
  state: "ok" | "degraded";
  reason: IntakeSyncReason | null;
}

/** The ledger evidence `judgeIntakeSync` reads, all inside the window. */
export interface IntakeSyncEvidence {
  relayOk: boolean;
  envelopeReportedAt: Date | null;
  /** The newest `MEDICATION_INTAKE_RECORDED` delivery to the device. */
  lastRecorded: { status: string; createdAt: Date } | null;
  /** The newest alert-class delivery the relay accepted. */
  lastAcceptedAlert: {
    acceptedAt: Date | null;
    confirmedAt: Date | null;
  } | null;
  /** When the newest alert-class delivery the device opened was created. */
  lastConfirmedAlertAt: Date | null;
}

/**
 * Whether the confirmation of a dose recorded elsewhere can be trusted to
 * reach this device. Only current evidence counts, so the state clears itself
 * once the problem is gone:
 *
 * - Only alert-class pushes are judged by their receipts. Every relay alert
 *   carries `mutable-content` (`templateFor`), so the notification service
 *   extension opens it on arrival and the next receipt confirms it. Silent
 *   pushes are delivered at iOS's discretion and throttled, and a Live
 *   Activity push is never opened by the app: a missing receipt for either
 *   says nothing about the sync.
 * - Only the newest accepted alert counts. Receipts confirm every push up to
 *   the newest one opened, so a later opened alert covers an older one.
 * - A dropped dose confirmation counts until an alert after it was opened.
 * - Nothing older than a day counts.
 */
export function judgeIntakeSync(e: IntakeSyncEvidence): IntakeSyncState {
  if (!e.relayOk) return { state: "degraded", reason: "relay" };
  const recorded = e.lastRecorded;
  if (
    recorded &&
    (recorded.status === "dropped" || recorded.status === "failed") &&
    !(e.lastConfirmedAlertAt && e.lastConfirmedAlertAt > recorded.createdAt)
  ) {
    return { state: "degraded", reason: "intake_recorded_dropped" };
  }
  const alert = e.lastAcceptedAlert;
  if (
    alert?.acceptedAt &&
    !alert.confirmedAt &&
    e.envelopeReportedAt &&
    alert.acceptedAt.getTime() <
      e.envelopeReportedAt.getTime() - UNDELIVERED_GRACE_MS
  ) {
    return { state: "degraded", reason: "alert_unconfirmed" };
  }
  return { state: "ok", reason: null };
}

/** `judgeIntakeSync` over the device's relay ledger. */
export async function intakeSyncOf(
  device: { id: string; envelopeReportedAt: Date | null },
  row: RegistrationRow | null,
  now: Date = new Date(),
): Promise<IntakeSyncState> {
  if (relayHealth(row).state !== "ok") {
    return { state: "degraded", reason: "relay" };
  }
  const since = new Date(now.getTime() - INTAKE_SYNC_WINDOW_MS);
  const alerts = { deviceId: device.id, pushClass: "alert" } as const;
  const [lastRecorded, lastAcceptedAlert] = await Promise.all([
    prisma.pushRelayDelivery.findFirst({
      where: {
        deviceId: device.id,
        eventType: INTAKE_RECORDED_EVENT,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true },
    }),
    prisma.pushRelayDelivery.findFirst({
      where: { ...alerts, status: "accepted", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { acceptedAt: true, confirmedAt: true, createdAt: true },
    }),
  ]);
  // The newest opened alert: the newest accepted one when that was opened;
  // else read only when a dropped dose confirmation asks whether one after
  // it was opened.
  const recordedLost =
    lastRecorded?.status === "dropped" || lastRecorded?.status === "failed";
  const lastConfirmedAlertAt = lastAcceptedAlert?.confirmedAt
    ? lastAcceptedAlert.createdAt
    : recordedLost
      ? ((
          await prisma.pushRelayDelivery.findFirst({
            where: {
              ...alerts,
              confirmedAt: { not: null },
              createdAt: { gte: since },
            },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          })
        )?.createdAt ?? null)
      : null;
  return judgeIntakeSync({
    relayOk: true,
    envelopeReportedAt: device.envelopeReportedAt,
    lastRecorded,
    lastAcceptedAlert,
    lastConfirmedAlertAt,
  });
}

/** What the `push.device` block reads of the device row. */
const DEVICE_BLOCK_SELECT = {
  ...ROUTABLE_DEVICE_SELECT,
  envelopeReportedAt: true,
  liveActivityConsentAt: true,
  userId: true,
  laStartedMedicationId: true,
  laStartedSlot: true,
  laStartedAt: true,
  relayConflictAt: true,
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
      ? intakeSyncOf(device, row).then((sync) => sync.state)
      : ("ok" as const),
    inputs.senderKeys,
    device ? liveActivityStartedOf(device) : null,
  ]);
  return {
    transport,
    envelope: device?.pushKeyPublic && transport !== "none" ? 1 : null,
    consent: Boolean(device?.relayConsentAt),
    relayState: device ? relayStateAt(device) : "none",
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
