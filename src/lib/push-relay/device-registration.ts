/**
 * The push fields of `POST /api/devices`, beside the device row the route
 * writes: the device's push key (`pushKey`), the person's relay consent
 * (`relayConsent`), the signed relay binding (`relayBinding`) and the signed
 * Live Activity statement on each `liveActivityTokens` entry.
 *
 * - `pushKey` (X25519, base64url, with the suites the device opens) makes
 *   every later push to the device a sealed envelope. A low-order key is
 *   refused with 422. `pushKey: null` withdraws it: the relay binding is
 *   removed too.
 * - `relayBinding` is accepted only with `relayConsent.granted: true` and a
 *   push key; it is verified, stored and forwarded to the relay.
 * - `relayConsent.granted: false` withdraws the consent: the binding is
 *   removed at the relay, the push key stays (a server with its own APNs key
 *   keeps sealing to it).
 *
 * The answer carries the `push` block: the transport this device gets, the
 * envelope version, the sender keys to pin, the relay instance id and the
 * device's relay state.
 */
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  RELAY_DEVICES_PER_ACCOUNT,
  relayConfig,
} from "@/lib/push-relay/config";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { isValidRecipientKey } from "@/lib/push-relay/hpke";
import {
  checkBindingStatement,
  clearedRelayFields,
  forwardBinding,
  unbindToken,
  type BindingRefusal,
} from "@/lib/push-relay/binding";
import { loadRegistration } from "@/lib/push-relay/registration";
import {
  devicePushBlock,
  type DevicePushBlock,
} from "@/lib/push-relay/capability";

const b64url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((v) => fromBase64Url(v, bytes) !== null, {
      message: `must be ${bytes} bytes of unpadded base64url`,
    });
const hexTag = z.string().regex(/^[0-9a-f]{32}$/);
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const unixSeconds = z.number().int().min(0).max(99_999_999_999);

export const pushKeySchema = z
  .object({
    v: z.literal(1),
    suites: z.array(z.number().int().min(1).max(255)).min(1).max(8),
    publicKey: b64url(32),
  })
  .strict();

export const relayBindingSchema = z
  .object({
    bindingKey: b64url(32),
    statement: z
      .object({
        instanceId: uuid,
        tokenTag: hexTag,
        kind: z.literal("device"),
        seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        iat: unixSeconds,
      })
      .strict(),
    signature: b64url(64),
  })
  .strict();

export const relayConsentSchema = z
  .object({
    granted: z.boolean(),
    textVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
  })
  .strict();

/** The signed Live Activity statement on one `liveActivityTokens` entry. */
export const activityStatementSchema = z
  .object({
    instanceId: uuid,
    tokenTag: hexTag,
    laTokenTag: hexTag,
    iat: unixSeconds,
  })
  .strict();

/** The push fields `POST /api/devices` accepts, merged into its schema. */
export const devicePushFields = {
  pushKey: pushKeySchema.nullable().optional(),
  relayBinding: relayBindingSchema.optional(),
  relayConsent: relayConsentSchema.optional(),
};

export interface DevicePushInput {
  pushKey?: z.infer<typeof pushKeySchema> | null;
  relayBinding?: z.infer<typeof relayBindingSchema>;
  relayConsent?: z.infer<typeof relayConsentSchema>;
  apnsToken?: string;
}

export type PushFieldRefusal =
  | BindingRefusal
  | "invalid_push_key"
  | "unsupported_suite"
  | "consent_required"
  | "push_key_required"
  | "apns_token_required"
  | "relay_device_limit";

/**
 * Checks that need no device row: the key is usable, the binding comes with
 * consent and a key, and the statement verifies. Returns the refusal, if any.
 */
export async function checkPushFields(
  userId: string,
  input: DevicePushInput,
  stored: { pushKeyPublic: string | null; apnsToken: string | null } | null,
): Promise<PushFieldRefusal | null> {
  if (input.pushKey) {
    if (!input.pushKey.suites.includes(1)) return "unsupported_suite";
    if (!isValidRecipientKey(fromBase64Url(input.pushKey.publicKey, 32))) {
      return "invalid_push_key";
    }
  }
  if (!input.relayBinding) return null;
  if (input.relayConsent?.granted !== true) return "consent_required";
  if (!input.pushKey && !stored?.pushKeyPublic) return "push_key_required";
  const apnsToken = input.apnsToken ?? stored?.apnsToken;
  if (!apnsToken) return "apns_token_required";
  const config = relayConfig();
  const registration = config.available ? await loadRegistration(config) : null;
  const refusal = checkBindingStatement(
    input.relayBinding,
    apnsToken,
    registration,
    config,
  );
  if (refusal) return refusal;
  const bound = await prisma.device.count({
    where: {
      userId,
      relayConsentAt: { not: null },
      NOT: { apnsToken: apnsToken },
    },
  });
  return bound >= RELAY_DEVICES_PER_ACCOUNT ? "relay_device_limit" : null;
}

/**
 * Write the push fields onto the device the route registered and forward the
 * binding. Returns the `push` block of the answer.
 */
export async function applyPushFields(
  deviceId: string,
  input: DevicePushInput,
): Promise<DevicePushBlock> {
  const before = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { apnsToken: true, relayState: true },
  });
  const withdraw =
    input.pushKey === null || input.relayConsent?.granted === false;
  if (withdraw) {
    if (before?.relayState && before.relayState !== "none") {
      await unbindToken(before.apnsToken);
    }
    await prisma.device.update({
      where: { id: deviceId },
      data: clearedRelayFields({ pushKey: input.pushKey === null }),
    });
  }
  if (input.pushKey) {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        pushKeyPublic: input.pushKey.publicKey,
        pushKeySuites: input.pushKey.suites,
      },
    });
  }
  if (input.relayBinding && input.relayConsent?.granted === true) {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        relayConsentAt: new Date(),
        relayConsentVersion: input.relayConsent.textVersion,
        relayBindingKey: input.relayBinding.bindingKey,
        relayBindingStatement: input.relayBinding.statement,
        relayBindingSignature: input.relayBinding.signature,
      },
    });
    await forwardBinding(deviceId);
  }
  return devicePushBlock(deviceId);
}

/** The `meta.errorCode` of each refusal, as the error catalogue lists it. */
const PUSH_REFUSAL_CODES = {
  relay_not_offered: "devices.push.relay_not_offered",
  instance_mismatch: "devices.push.instance_mismatch",
  token_mismatch: "devices.push.token_mismatch",
  bad_signature: "devices.push.bad_signature",
  invalid_push_key: "devices.push.invalid_push_key",
  unsupported_suite: "devices.push.unsupported_suite",
  consent_required: "devices.push.consent_required",
  push_key_required: "devices.push.push_key_required",
  apns_token_required: "devices.push.apns_token_required",
  relay_device_limit: "devices.push.relay_device_limit",
} as const satisfies Record<PushFieldRefusal, string>;

/**
 * The 422 for refused push fields, or null when they pass. Reads the device
 * the request names (by its token or its APNs token) for what it already
 * holds.
 */
export async function refusePushFields(
  userId: string,
  input: DevicePushInput & { token: string },
): Promise<Response | null> {
  const stored = await prisma.device.findFirst({
    where: {
      userId,
      OR: [
        { token: input.token },
        ...(input.apnsToken ? [{ apnsToken: input.apnsToken }] : []),
      ],
    },
    select: { pushKeyPublic: true, apnsToken: true },
  });
  const refusal = await checkPushFields(userId, input, stored);
  if (!refusal) return null;
  annotate({ meta: { push_refused: refusal } });
  return apiError(`Push registration refused: ${refusal}`, 422, {
    errorCode: PUSH_REFUSAL_CODES[refusal],
  });
}
