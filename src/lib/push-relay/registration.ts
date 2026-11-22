/**
 * This instance's registration at the relay, and every signed call made
 * under it.
 *
 * The operator turns the relay on in the admin area (`enableRelay`): a fresh
 * Ed25519 instance key is made and stored encrypted, the envelope sender keys
 * are made if they do not exist yet, and the instance registers with a proof
 * of possession. Turning it off (`disableRelay`) deletes the instance at the
 * relay, which drops every binding, and deletes the registration and its key.
 *
 * `relayCall` is the one door for instance requests. It applies the
 * request-level answer to the registration: the breaker (`circuit.ts`), a
 * pause the relay asked for, suspension, revocation, an unknown instance
 * (registered again by the maintenance pass), the clock offset, a run of
 * refused signatures, and what `GET /v1/status` reports
 * (`relay-status.ts`). It never
 * touches a device row or a notification channel.
 */
import { randomBytes } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import { loadApnsConfig } from "@/lib/notifications/senders/apns";
import {
  relayConfig,
  RELAY_TERMS_VERSION,
  type RelayConfig,
} from "@/lib/push-relay/config";
import {
  registerInstance,
  signedRelayCall,
  type RelayCallResult,
} from "@/lib/push-relay/client";
import {
  afterSignedResponse,
  afterTransportFailure,
  isCircuitOpen,
  isTransportLikeStatus,
} from "@/lib/push-relay/circuit";
import { fromBase64Url, toBase64Url } from "@/lib/push-relay/encoding";
import {
  deleteEnvelopeKeys,
  ensureEnvelopeKeys,
} from "@/lib/push-relay/sender-keys";
import { recordRelayDecision } from "@/lib/push-relay/operator-decision";
import {
  anyItemAccepted,
  RELAY_REPORTED_REASONS,
  relayStatusOf,
  stateForReported,
} from "@/lib/push-relay/relay-status";

export type RegistrationRow = NonNullable<
  Awaited<ReturnType<typeof prisma.pushRelayRegistration.findUnique>>
>;

/**
 * The registration for the configured relay host, if the relay is on. A
 * registration the operator switched off that the relay has not confirmed
 * deleting yet (`state: deleting`) counts as off for everything except
 * finishing that deletion (`includeDeleting`).
 */
export async function loadRegistration(
  config: RelayConfig = relayConfig(),
  options: { includeDeleting?: boolean } = {},
): Promise<RegistrationRow | null> {
  if (!config.host) return null;
  const row = await prisma.pushRelayRegistration.findUnique({
    where: { relayHost: config.host },
  });
  if (row?.state === "deleting" && !options.includeDeleting) return null;
  return row;
}

function instanceSeedOf(row: RegistrationRow): Buffer | null {
  try {
    return fromBase64Url(decrypt(row.instanceKeyEncrypted), 32);
  } catch {
    return null;
  }
}

async function setState(
  id: string,
  state: string,
  reason: string | null,
  extra: Prisma.PushRelayRegistrationUncheckedUpdateInput = {},
) {
  const current = await prisma.pushRelayRegistration.findUnique({
    where: { id },
    select: { state: true, stateReason: true },
  });
  const changed = current?.state !== state || current?.stateReason !== reason;
  await prisma.pushRelayRegistration.update({
    where: { id },
    data: {
      state,
      stateReason: reason,
      ...(changed ? { stateSince: new Date() } : {}),
      ...extra,
    },
  });
}

/** Every bound device of this instance has to bind again. */
async function markAllRebindNeeded(): Promise<void> {
  await prisma.device.updateMany({
    where: { relayState: { in: ["bound", "conflict"] } },
    data: { relayState: "rebind_needed", relayBoundAt: null },
  });
}

function noticeOf(body: Record<string, unknown> | null) {
  const notice = body?.notice as { id?: unknown; level?: unknown } | null;
  if (!notice || typeof notice.id !== "string") {
    return { noticeId: null, noticeLevel: null };
  }
  return {
    noticeId: notice.id.slice(0, 40),
    noticeLevel: typeof notice.level === "string" ? notice.level : null,
  };
}

/**
 * Apply the request-level part of an answer to the registration. Returns the
 * answer unchanged so the caller can read the item results.
 */
async function applyAnswer(
  row: RegistrationRow,
  result: RelayCallResult,
  path: string,
): Promise<RelayCallResult> {
  const now = new Date();
  // Only the push path and the status probe speak for the instance's ability
  // to send. A refusal or failure of a binding, a receipt report or a key
  // rotation holds for that one call: it neither pauses the pushes nor
  // counts toward the breaker.
  const governsPushes =
    path === "/v1/push" || path.split("?")[0] === "/v1/status";
  if (
    result.kind === "transport" ||
    isTransportLikeStatus(result.status, result.retryAfter, result.body)
  ) {
    if (!governsPushes) return result;
    const next = afterTransportFailure(row, now);
    await prisma.pushRelayRegistration.update({
      where: { id: row.id },
      data: next,
    });
    if (isCircuitOpen(next) && !isCircuitOpen(row)) {
      getEvent()?.addMeta("push_relay_circuit", "opened");
      await setState(row.id, "down", "circuit_open");
    }
    return result;
  }
  const error = result.body?.error;
  const retry = result.retryAfter;
  const badSignature = result.status === 401 && error === "bad_signature";
  // Any other signed answer to a push or a status request ends a run of
  // refused signatures.
  const circuit = {
    ...afterSignedResponse(),
    ...(governsPushes && !badSignature ? { badSignatureCount: 0 } : {}),
  };
  if (isCircuitOpen(row)) {
    getEvent()?.addMeta("push_relay_circuit", "closed");
  }
  const isStatus = path.split("?")[0] === "/v1/status";
  if (result.status === 401 && error === "unknown_instance") {
    await prisma.pushRelayRegistration.update({
      where: { id: row.id },
      data: { ...circuit, instanceId: null },
    });
    await markAllRebindNeeded();
    await setState(row.id, "pending", "unknown_instance");
  } else if (result.status === 403 && error === "instance_revoked") {
    await setState(row.id, "revoked", "instance_revoked", circuit);
    getEvent()?.addMeta("push_relay_refused", String(error));
  } else if (result.status === 403 && error === "instance_suspended") {
    const reason =
      typeof result.body?.reason === "string" ? result.body.reason : null;
    await setState(row.id, "suspended", reason, circuit);
    getEvent()?.addMeta("push_relay_refused", String(error));
  } else if (result.status === 426) {
    await setState(row.id, "down", "min_server_version", circuit);
  } else if (!governsPushes) {
    if (result.status < 300) {
      await prisma.pushRelayRegistration.update({
        where: { id: row.id },
        data: { lastSuccessAt: now },
      });
    }
  } else if (badSignature) {
    // The relay refuses this server's signature, after the key overlap was
    // tried (`relayCall`). Every push waits for its deadline meanwhile, so
    // the state says so once it is no single mishap.
    const { badSignatureCount } = await prisma.pushRelayRegistration.update({
      where: { id: row.id },
      data: { ...circuit, badSignatureCount: { increment: 1 } },
      select: { badSignatureCount: true },
    });
    getEvent()?.addMeta("push_relay_bad_signature", badSignatureCount);
    if (badSignatureCount >= BAD_SIGNATURE_THRESHOLD) {
      await setState(row.id, "degraded", "bad_signature");
    }
  } else if ((result.status === 429 || result.status === 503) && retry) {
    await setState(row.id, "degraded", String(error ?? "paused"), {
      ...circuit,
      pausedUntil: new Date(now.getTime() + retry * 1000),
    });
  } else if (result.status < 300) {
    const status = isStatus ? relayStatusOf(result.body, now) : null;
    // What the relay reports about itself holds until it reports `ok` or
    // Apple takes a push through it: a push request the relay answered is
    // not proof that anything got through.
    const next = status
      ? stateForReported(status.state)
      : row.state === "degraded" &&
          RELAY_REPORTED_REASONS.has(row.stateReason ?? "") &&
          !anyItemAccepted(result.body)
        ? { state: "degraded" as const, reason: row.stateReason }
        : { state: "ok" as const, reason: null };
    await setState(row.id, next.state, next.reason, {
      ...circuit,
      lastSuccessAt: now,
      pausedUntil: null,
      ...(status ? { relayStatus: { ...status } } : {}),
      ...(result.body && "notice" in result.body ? noticeOf(result.body) : {}),
      ...(typeof result.body?.tier === "string"
        ? { tier: result.body.tier }
        : {}),
    });
  } else {
    await prisma.pushRelayRegistration.update({
      where: { id: row.id },
      data: circuit,
    });
  }
  return result;
}

/** One signed instance request under `row`, its answer applied. */
function seedOf(encrypted: string | null): Buffer | null {
  if (!encrypted) return null;
  try {
    return fromBase64Url(decrypt(encrypted), 32);
  } catch {
    return null;
  }
}

/**
 * Make `seed` the instance key: the one in use becomes `previous` for the
 * 7-day overlap, a pending rotation is settled.
 */
export async function promoteInstanceKey(
  row: RegistrationRow,
  seed: Buffer,
  now: Date = new Date(),
): Promise<void> {
  await prisma.pushRelayRegistration.update({
    where: { id: row.id },
    data: {
      instanceKeyEncrypted: encrypt(toBase64Url(seed)),
      instanceKeyCreatedAt: now,
      pendingInstanceKeyEncrypted: null,
      previousInstanceKeyEncrypted: row.instanceKeyEncrypted,
      previousInstanceKeyUntil: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
    },
  });
}

/**
 * Refused signatures in a row, on push and status requests, before the
 * relay state reads `degraded` with the reason `bad_signature`. One alone
 * can be a key rotation the relay has not applied yet.
 */
export const BAD_SIGNATURE_THRESHOLD = 3;

function isBadSignature(result: RelayCallResult): boolean {
  return (
    result.kind === "response" &&
    result.status === 401 &&
    result.body?.error === "bad_signature"
  );
}

/** One signed instance request under `row`, its answer applied. */
export async function relayCall(
  row: RegistrationRow,
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: unknown,
  config: RelayConfig = relayConfig(),
): Promise<RelayCallResult> {
  const seed = instanceSeedOf(row);
  if (!seed || !row.instanceId || !config.available) {
    return { kind: "transport", reason: "relay_not_registered" };
  }
  const instanceId = row.instanceId;
  const call = (instanceSeed: Buffer) =>
    signedRelayCall(
      config,
      {
        instanceId,
        instanceSeed,
        clockOffsetSeconds: row.clockOffsetSeconds,
      },
      method,
      path,
      payload,
      async (offset) => {
        await prisma.pushRelayRegistration.update({
          where: { id: row.id },
          data: { clockOffsetSeconds: offset },
        });
      },
    );
  let result = await call(seed);
  // The overlap of a key rotation: a rotation whose answer was lost left the
  // relay on the pending key; one the relay never applied leaves it on the
  // previous key. Either is tried once, and the key that works is kept.
  if (isBadSignature(result)) {
    const pending = seedOf(row.pendingInstanceKeyEncrypted);
    const previous =
      row.previousInstanceKeyUntil && row.previousInstanceKeyUntil > new Date()
        ? seedOf(row.previousInstanceKeyEncrypted)
        : null;
    for (const [alt, kind] of [
      [pending, "pending"],
      [previous, "previous"],
    ] as const) {
      if (!alt) continue;
      const retry = await call(alt);
      if (isBadSignature(retry) || retry.kind === "transport") continue;
      if (kind === "pending") {
        await promoteInstanceKey(row, alt);
      } else {
        await prisma.pushRelayRegistration.update({
          where: { id: row.id },
          data: {
            instanceKeyEncrypted: encrypt(toBase64Url(alt)),
            previousInstanceKeyEncrypted: null,
            previousInstanceKeyUntil: null,
          },
        });
      }
      getEvent()?.addMeta("push_relay_instance_key_fallback", kind);
      result = retry;
      break;
    }
  }
  return applyAnswer(row, result, path);
}

/**
 * Register a row that has no instance id yet. Returns whether it is
 * registered afterwards. A known key answers with its existing id, which is
 * also the recovery after the relay lost its database.
 */
export async function ensureInstanceRegistered(
  row: RegistrationRow,
  config: RelayConfig = relayConfig(),
  options: { invite?: string } = {},
): Promise<boolean> {
  if (row.instanceId) return true;
  const seed = instanceSeedOf(row);
  if (!seed || !config.available) return false;
  const result = await registerInstance(
    config,
    seed,
    row.clockOffsetSeconds,
    async (offset) => {
      await prisma.pushRelayRegistration.update({
        where: { id: row.id },
        data: { clockOffsetSeconds: offset },
      });
    },
    options.invite,
  );
  if (
    result.kind === "response" &&
    (result.status === 200 || result.status === 201) &&
    typeof result.body?.instanceId === "string"
  ) {
    await setState(row.id, "ok", null, {
      instanceId: result.body.instanceId,
      tier: typeof result.body.tier === "string" ? result.body.tier : null,
      lastSuccessAt: new Date(),
      pausedUntil: null,
    });
    // The operator's yes holds from the first registration that took, also
    // when the minute pass finishes one the switch left pending.
    await recordRelayDecision("on");
    return true;
  }
  if (result.kind === "transport") {
    await setState(row.id, "pending", result.reason);
    return false;
  }
  const error = String(result.body?.error ?? `http_${result.status}`);
  // The relay answers `invite_required` both to a missing code and to one it
  // does not accept (unknown, expired or already used); which one it was is
  // known here. Neither is retried until the operator enters a code
  // (`OPERATOR_ACTION_REASONS`).
  const reason =
    error === "invite_required" && options.invite ? "invite_rejected" : error;
  // A closed relay, or one whose registration limits are reached, says when
  // to ask again; the minute pass waits that long.
  const pausedUntil =
    error === "registration_paused"
      ? new Date(Date.now() + (result.retryAfter ?? 3600) * 1000)
      : null;
  await setState(row.id, "pending", reason, { pausedUntil });
  return false;
}

/**
 * The operator turns the relay on. Creates the registration with a fresh
 * instance key and registers it; a relay that cannot be reached leaves the
 * row `pending`, and the maintenance pass registers it later.
 *
 * On a registration that exists already the same call records a fresh
 * acceptance (the current terms version, the household confirmation, who)
 * and touches nothing else: the operator confirming a changed text keeps the
 * instance, its key, its state and every device binding.
 */
export async function enableRelay(input: {
  userId: string;
  config?: RelayConfig;
  /** The relay's one-time invite code, used for this attempt only. */
  invite?: string;
}): Promise<RegistrationRow> {
  const config = input.config ?? relayConfig();
  await ensureEnvelopeKeys();
  const now = new Date();
  const row = await prisma.pushRelayRegistration.upsert({
    where: { relayHost: config.host },
    create: {
      relayHost: config.host,
      instanceKeyEncrypted: encrypt(toBase64Url(randomBytes(32))),
      termsVersion: RELAY_TERMS_VERSION,
      householdConfirmedAt: now,
      enabledByUserId: input.userId,
    },
    update: {
      termsVersion: RELAY_TERMS_VERSION,
      householdConfirmedAt: now,
      enabledByUserId: input.userId,
    },
  });
  if (row.state === "deleting" && row.instanceId) {
    // Switched on again before the relay confirmed the switch-off: the
    // instance still exists there; ask it how things stand.
    await setState(row.id, "pending", null);
    const fresh = await loadRegistration(config);
    if (fresh) await relayCall(fresh, "GET", "/v1/status", undefined, config);
  } else {
    await ensureInstanceRegistered(row, config, { invite: input.invite });
  }
  const after = (await loadRegistration(config)) ?? row;
  // Switched on again before the relay confirmed a switch-off: the instance
  // it kept is registered, so the answer is yes again.
  if (after.instanceId && after.state !== "deleting") {
    await recordRelayDecision("on");
  }
  return after;
}

/**
 * The operator turns the relay off: the instance is deleted at the relay
 * (every binding with it), then its key and registration here, and every
 * device returns to `none` at once. While the relay has not confirmed the
 * deletion the registration stays as `deleting` with its key, so this
 * server can still delete the instance; the minute pass retries
 * (`finishRelayDisable`). The envelope keys go too unless this server seals
 * for its own APNs key.
 */
export async function disableRelay(
  config: RelayConfig = relayConfig(),
): Promise<{ unregistered: boolean }> {
  // Switching the relay off is the operator's no: nobody is asked again.
  await recordRelayDecision("off");
  const row = await loadRegistration(config, { includeDeleting: true });
  await prisma.device.updateMany({
    where: { relayState: { not: "none" } },
    data: {
      relayState: "none",
      relayBoundAt: null,
      relayBindingKey: null,
      relayBindingStatement: Prisma.DbNull,
      relayBindingSignature: null,
    },
  });
  await prisma.pushRelayDelivery.deleteMany({ where: { status: "pending" } });
  if (!row) return { unregistered: true };
  await setState(row.id, "deleting", null);
  return { unregistered: await finishRelayDisable(config) };
}

/**
 * Delete a `deleting` registration's instance at the relay, and once the
 * relay confirmed (or no longer knows it), the registration and its key.
 * Returns whether that happened.
 */
export async function finishRelayDisable(
  config: RelayConfig = relayConfig(),
): Promise<boolean> {
  const row = await loadRegistration(config, { includeDeleting: true });
  if (!row || row.state !== "deleting") return false;
  let gone = !row.instanceId;
  if (row.instanceId && config.available) {
    const result = await relayCall(
      row,
      "DELETE",
      "/v1/instances/self",
      undefined,
      config,
    );
    gone =
      result.kind === "response" &&
      (result.status === 204 || result.status === 401);
  }
  if (!gone) return false;
  await prisma.pushRelayRegistration.deleteMany({ where: { id: row.id } });
  if (!loadApnsConfig()) await deleteEnvelopeKeys();
  return true;
}
