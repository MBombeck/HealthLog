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
 *   keeps sealing to it). The Live Activity consent goes with it.
 * - `liveActivityConsent` is the second, separate consent to Live Activity
 *   start and update over the relay: the device's signed `hl-la-consent-v1`,
 *   checked against its binding key and passed on to the relay
 *   (`POST /v1/bindings/liveactivity`). `liveActivityWithdraw` is the signed
 *   `hl-la-withdraw-v1`; it drops the consent here and at the relay. Both
 *   need a device bound with the relay consent, else 422
 *   `devices.push.relay_consent_required`.
 * - `liveActivityStart` is the ActivityKit push-to-start token with the
 *   device's signed `hl-la-start-v1`; `null` drops it.
 *
 * The answer carries the `push` block: the transport this device gets, the
 * envelope version, the sender keys to pin, the relay instance id and the
 * device's relay state.
 */
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { queueRelayUnbind } from "@/lib/push-relay/unbind-queue";
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
import { endRelayStartedActivities } from "@/lib/push-relay/live-activity";
import {
  devicePushBlock,
  type DevicePushBlock,
} from "@/lib/push-relay/capability";
import {
  applyLiveActivityFields,
  checkLiveActivityFields,
} from "@/lib/push-relay/live-activity-registration";

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

/** `hl-la-consent-v1`, signed with the binding key when the person agrees. */
export const liveActivityConsentSchema = z
  .object({
    textVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
    iat: unixSeconds,
    signature: b64url(64),
  })
  .strict();

/** `hl-la-withdraw-v1`, signed with the binding key when the person stops. */
export const liveActivityWithdrawSchema = z
  .object({ iat: unixSeconds, signature: b64url(64) })
  .strict();

/**
 * The longest APNs token (device, Live Activity update or push-to-start
 * token) accepted, in hex characters. Apple documents no fixed length: device
 * tokens are 64 characters today, push-to-start tokens already run to 256.
 */
export const APNS_TOKEN_MAX_HEX = 512;

/** The push-to-start token with its `hl-la-start-v1` statement. */
export const liveActivityStartSchema = z
  .object({
    token: z
      .string()
      .min(64)
      .max(APNS_TOKEN_MAX_HEX)
      .regex(/^[0-9A-Fa-f]+$/),
    statement: z
      .object({
        instanceId: uuid,
        tokenTag: hexTag,
        laTokenTag: hexTag,
        iat: unixSeconds,
      })
      .strict(),
    signature: b64url(64),
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
  liveActivityConsent: liveActivityConsentSchema.optional(),
  liveActivityWithdraw: liveActivityWithdrawSchema.optional(),
  liveActivityStart: liveActivityStartSchema.nullable().optional(),
};

export interface DevicePushInput {
  /**
   * Set by `preparePushFields` on the request it read: the relay-bound APNs
   * token this registration replaces, for `applyPushFields` to unbind.
   */
  replacedRelayToken?: string | null;
  pushKey?: z.infer<typeof pushKeySchema> | null;
  relayBinding?: z.infer<typeof relayBindingSchema>;
  relayConsent?: z.infer<typeof relayConsentSchema>;
  liveActivityConsent?: z.infer<typeof liveActivityConsentSchema>;
  liveActivityWithdraw?: z.infer<typeof liveActivityWithdrawSchema>;
  liveActivityStart?: z.infer<typeof liveActivityStartSchema> | null;
  apnsToken?: string;
}

export type PushFieldRefusal =
  | BindingRefusal
  | "invalid_push_key"
  | "unsupported_suite"
  | "consent_required"
  | "push_key_required"
  | "apns_token_required"
  | "relay_device_limit"
  | "relay_daily_limit"
  | "relay_consent_required"
  | "statement_stale";

/**
 * Checks that need no device row: the key is usable, the binding comes with
 * consent and a key, and the statement verifies. Returns the refusal, if any.
 */
export async function checkPushFields(
  userId: string,
  input: DevicePushInput,
  stored: {
    pushKeyPublic: string | null;
    apnsToken: string | null;
    relayState?: string;
    relayConsentAt?: Date | null;
    relayBindingKey?: string | null;
  } | null,
): Promise<PushFieldRefusal | null> {
  const laRefusal = await checkLiveActivityFields(input, stored);
  if (laRefusal) return laRefusal;
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
  if (bound >= RELAY_DEVICES_PER_ACCOUNT) return "relay_device_limit";
  // A binding the relay does not hold yet counts toward the account's daily
  // cap; resubmitting the statement of a device already bound with this
  // token does not.
  const alreadyBound =
    stored?.relayState === "bound" && stored.apnsToken === apnsToken;
  if (!alreadyBound) {
    const quota = await checkRateLimit(
      `push-relay:new-binding:${userId}`,
      RELAY_NEW_BINDINGS_PER_DAY,
      24 * 3600 * 1000,
    );
    if (!quota.allowed) return "relay_daily_limit";
  }
  return null;
}

/**
 * Write the push fields onto the device the route registered and forward the
 * binding. Returns the `push` block of the answer.
 */
export async function applyPushFields(
  deviceId: string,
  input: DevicePushInput,
): Promise<DevicePushBlock> {
  const replacedRelayToken = input.replacedRelayToken ?? null;
  // The device's APNs token changed: the old token's binding goes through
  // the retrying unbind queue, and the device binds its new token with a
  // fresh statement (sent with this request, or asked for).
  if (replacedRelayToken) {
    await queueRelayUnbind(replacedRelayToken);
    if (!input.relayBinding) {
      await prisma.device.update({
        where: { id: deviceId },
        data: { relayState: "rebind_needed", relayBoundAt: null },
      });
    }
  }
  const before = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { apnsToken: true, relayState: true },
  });
  const withdraw =
    input.pushKey === null || input.relayConsent?.granted === false;
  if (withdraw) {
    if (before?.relayState && before.relayState !== "none") {
      // The relay-started Activities end while the binding that carries
      // their end still exists.
      await endRelayStartedActivities(deviceId);
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
  if (!withdraw) await applyLiveActivityFields(deviceId, input);
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
  relay_daily_limit: "devices.push.relay_daily_limit",
  relay_consent_required: "devices.push.relay_consent_required",
  statement_stale: "devices.push.statement_stale",
} as const satisfies Record<PushFieldRefusal, string>;

/**
 * New relay bindings one account may start per day: room for a household's
 * devices and a few reinstalls, not for minting bindings for made-up tokens.
 */
export const RELAY_NEW_BINDINGS_PER_DAY = 10;

/** An optional field the registration left out instead of failing on it. */
export interface IgnoredDeviceField {
  /** The request field, `liveActivityTokens[2]` for one list entry. */
  field: string;
  /** `devices.register.invalid_field`, or the `devices.push.<reason>` refusal. */
  code: string;
}

export interface PreparedPushFields {
  /** The refusal to answer with, or null when the push fields pass. */
  refused: Response | null;
  /**
   * A push-to-start token whose statement does not hold is dropped, not
   * refused: the device registers without it and the answer names it.
   */
  ignored: IgnoredDeviceField[];
  /**
   * The relay-bound APNs token this registration replaces (the device's
   * token changed), whose binding has to go.
   */
  replacedRelayToken: string | null;
}

/**
 * Check the push fields against what the device already holds (read by its
 * token or its APNs token) and note a relay-bound APNs token the request
 * replaces. A refusal answers 422 with `devices.push.<reason>`, the daily
 * binding cap 429 with `devices.push.relay_daily_limit`.
 */
export async function preparePushFields(
  userId: string,
  input: DevicePushInput & { token: string },
): Promise<PreparedPushFields> {
  const [stored, previous] = await Promise.all([
    prisma.device.findFirst({
      where: {
        userId,
        OR: [
          { token: input.token },
          ...(input.apnsToken ? [{ apnsToken: input.apnsToken }] : []),
        ],
      },
      select: {
        pushKeyPublic: true,
        apnsToken: true,
        relayState: true,
        relayConsentAt: true,
        relayBindingKey: true,
      },
    }),
    prisma.device.findFirst({
      where: { userId, token: input.token },
      select: { apnsToken: true, relayState: true, relayConsentAt: true },
    }),
  ]);
  const replacedRelayToken =
    previous?.apnsToken &&
    input.apnsToken &&
    previous.apnsToken.toLowerCase() !== input.apnsToken.toLowerCase() &&
    (previous.relayState !== "none" || previous.relayConsentAt)
      ? previous.apnsToken
      : null;
  input.replacedRelayToken = replacedRelayToken;
  // The push-to-start token is a background refresh, not a choice the person
  // made: a statement that does not hold (stale, re-signed for an old token,
  // no relay consent yet) drops that field only, so the device still
  // registers its APNs token. The consent and withdraw statements keep
  // refusing the request.
  const ignored: IgnoredDeviceField[] = [];
  if (input.liveActivityStart) {
    const startRefusal = await checkLiveActivityFields(
      {
        ...input,
        liveActivityConsent: undefined,
        liveActivityWithdraw: undefined,
      },
      stored,
    );
    if (startRefusal) {
      ignored.push({
        field: "liveActivityStart",
        code: PUSH_REFUSAL_CODES[startRefusal],
      });
      input.liveActivityStart = undefined;
    }
  }
  const refusal = await checkPushFields(userId, input, stored);
  if (!refusal) return { refused: null, ignored, replacedRelayToken };
  annotate({ meta: { push_refused: refusal } });
  return {
    refused: apiError(
      `Push registration refused: ${refusal}`,
      refusal === "relay_daily_limit" ? 429 : 422,
      { errorCode: PUSH_REFUSAL_CODES[refusal] },
    ),
    ignored,
    replacedRelayToken,
  };
}
