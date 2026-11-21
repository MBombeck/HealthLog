/**
 * Rotation of the instance signing key (`POST /v1/instances/self/rotate`).
 *
 * Every 30 days, and on demand from the admin card, the instance makes a new
 * Ed25519 key, proves possession of it (`hl-register-v1` by the new key) in
 * a request signed with the old one, and switches over once the relay
 * confirms. The relay stops accepting the old key at once, so the new key is
 * stored as `pending` before the request leaves: an answer lost on the way
 * back cannot lock the instance out, because the next request the relay
 * refuses as `bad_signature` is retried with the pending key
 * (`relayCall`). The replaced key stays as `previous` for 7 days, the same
 * overlap the relay reports a rotation for (`keyRotatedDay`).
 *
 * The relay allows one rotation per UTC day. A refusal or an unreachable
 * relay moves the next scheduled attempt a day on.
 */
import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import packageJson from "../../../package.json";
import {
  relayConfig,
  RELAY_CLIENT_NAME,
  type RelayConfig,
} from "@/lib/push-relay/config";
import { fromBase64Url, toBase64Url } from "@/lib/push-relay/encoding";
import {
  ed25519PublicOf,
  registerText,
  signText,
} from "@/lib/push-relay/statements";
import {
  promoteInstanceKey,
  relayCall,
  type RegistrationRow,
} from "@/lib/push-relay/registration";

export const INSTANCE_KEY_ROTATION_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

export type InstanceKeyRotation =
  "rotated" | "refused" | "unreachable" | "not_registered";

export function instanceKeyDue(
  row: Pick<RegistrationRow, "instanceKeyCreatedAt">,
  now: Date = new Date(),
): boolean {
  return (
    now.getTime() - row.instanceKeyCreatedAt.getTime() >=
    INSTANCE_KEY_ROTATION_DAYS * DAY_MS
  );
}

function pendingSeed(row: RegistrationRow): Buffer | null {
  if (!row.pendingInstanceKeyEncrypted) return null;
  try {
    return fromBase64Url(decrypt(row.pendingInstanceKeyEncrypted), 32);
  } catch {
    return null;
  }
}

/** Rotate the instance key now. */
export async function rotateInstanceKey(
  row: RegistrationRow,
  config: RelayConfig = relayConfig(),
  now: Date = new Date(),
): Promise<InstanceKeyRotation> {
  if (!row.instanceId || !config.available) return "not_registered";
  const seed = pendingSeed(row) ?? randomBytes(32);
  await prisma.pushRelayRegistration.update({
    where: { id: row.id },
    data: { pendingInstanceKeyEncrypted: encrypt(toBase64Url(seed)) },
  });
  const publicKey = ed25519PublicOf(seed);
  const time = Math.floor(now.getTime() / 1000) + row.clockOffsetSeconds;
  const version = /^\d+\.\d+\.\d+/.exec(packageJson.version)?.[0] ?? "0.0.0";
  const result = await relayCall(
    row,
    "POST",
    "/v1/instances/self/rotate",
    {
      publicKey: toBase64Url(publicKey),
      client: `${RELAY_CLIENT_NAME}/${version}`,
      time,
      proof: toBase64Url(
        signText(seed, registerText(config.host, publicKey, time)),
      ),
    },
    config,
  );
  if (result.kind === "response" && result.status === 200) {
    const fresh = await prisma.pushRelayRegistration.findUniqueOrThrow({
      where: { id: row.id },
    });
    await promoteInstanceKey(fresh, seed, now);
    return "rotated";
  }
  // Try again in a day. A refused key (in use, malformed) is dropped; after
  // a lost answer or a daily limit the pending key stays, since the relay
  // may already hold it.
  const definite =
    result.kind === "response" &&
    (result.status === 409 || result.status === 422);
  await prisma.pushRelayRegistration.update({
    where: { id: row.id },
    data: {
      instanceKeyCreatedAt: new Date(
        now.getTime() - (INSTANCE_KEY_ROTATION_DAYS - 1) * DAY_MS,
      ),
      ...(definite ? { pendingInstanceKeyEncrypted: null } : {}),
    },
  });
  return result.kind === "transport" ? "unreachable" : "refused";
}
