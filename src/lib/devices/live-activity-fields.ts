/**
 * The Live Activity fields of `POST /api/devices` and how a registration
 * treats one it cannot take. They are optional extras on a registration
 * whose point is the device and its APNs token, so a value in a shape the
 * server does not take is left out and named in the answer's `ignored`
 * instead of failing the whole registration with 422.
 */
import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import {
  APNS_TOKEN_MAX_HEX,
  activityStatementSchema,
  liveActivityStartSchema,
  type IgnoredDeviceField,
} from "@/lib/push-relay/device-registration";
import { isoDateTime } from "@/lib/validations/datetime";

/** An ActivityKit token (update or the legacy single token), hex. */
export const liveActivityHexToken = z
  .string()
  .min(8)
  .max(APNS_TOKEN_MAX_HEX)
  .regex(/^[A-Fa-f0-9]+$/, "liveActivityPushToken must be hex");

/** One running Live Activity in `liveActivityTokens`. */
export const liveActivityTokenEntry = z
  .object({
    token: z
      .string()
      .min(8)
      .max(APNS_TOKEN_MAX_HEX)
      .regex(/^[A-Fa-f0-9]+$/),
    // A relay-started Activity knows no dose (its attributes are
    // fixed); the server fills in the dose it started.
    medicationId: z.string().min(1).max(64).optional(),
    relayStart: z.boolean().optional(),
    slotInstant: isoDateTime()
      .transform((v) => new Date(v))
      .optional(),
    // The device's signed `hl-activity-v1` statement for this
    // Activity. Kept here and handed to the push relay only inside the
    // end push, so the relay never learns when an Activity starts.
    statement: activityStatementSchema.optional(),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{86}$/)
      .optional(),
  })
  .refine((a) => a.medicationId !== undefined || a.relayStart === true, {
    message: "medicationId is required unless relayStart is true",
  });

export const LIVE_ACTIVITY_TOKENS_MAX = 8;

/** The `code` of an optional field left out for its own shape. */
const INVALID_FIELD = "devices.register.invalid_field";

/**
 * The Live Activity fields are optional extras on a registration whose point
 * is the device and its APNs token. One of them in a shape this server does
 * not take (a token longer than it expects, a malformed list entry) is left
 * out and named in the answer's `ignored`, instead of failing the whole
 * registration with 422 and leaving the device without server push.
 */
export function dropInvalidLiveActivityFields(
  body: unknown,
  ignored: IgnoredDeviceField[],
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out: {
    liveActivityPushToken?: unknown;
    liveActivityStart?: unknown;
    liveActivityTokens?: unknown;
  } = { ...body };
  const left = (field: string) => ignored.push({ field, code: INVALID_FIELD });
  if (out.liveActivityPushToken != null) {
    if (!liveActivityHexToken.safeParse(out.liveActivityPushToken).success) {
      delete out.liveActivityPushToken;
      left("liveActivityPushToken");
    }
  }
  if (out.liveActivityStart != null) {
    if (!liveActivityStartSchema.safeParse(out.liveActivityStart).success) {
      delete out.liveActivityStart;
      left("liveActivityStart");
    }
  }
  const list = out.liveActivityTokens;
  if (list !== undefined) {
    if (!Array.isArray(list) || list.length > LIVE_ACTIVITY_TOKENS_MAX) {
      delete out.liveActivityTokens;
      left("liveActivityTokens");
    } else {
      out.liveActivityTokens = list.filter((entry, i) => {
        if (liveActivityTokenEntry.safeParse(entry).success) return true;
        ignored.push({
          field: `liveActivityTokens[${i}]`,
          code: INVALID_FIELD,
        });
        return false;
      });
    }
  }
  return out;
}

/**
 * The answer's `ignored` block: absent when nothing was left out. Notes the
 * left-out fields on the wide event, without their values.
 */
export function ignoredFieldsAnswer(ignored: IgnoredDeviceField[]): {
  ignored?: IgnoredDeviceField[];
} {
  if (ignored.length === 0) return {};
  annotate({
    meta: { ignored_fields: ignored.map((f) => `${f.field}:${f.code}`) },
  });
  return { ignored };
}
