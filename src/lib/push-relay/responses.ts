/**
 * The shapes of the relay's signed answers, checked before anything in them
 * is used (`spec/relay-api.yaml`). A signed body that does not fit is a
 * transport error like an unsigned one: the server acts only on fields it
 * has bounded, and nothing unbounded reaches a column or `/api/auth/me`.
 */
import { z } from "zod/v4";

/** The longest body the server reads; the relay never sends over 64 KiB. */
export const MAX_RELAY_BODY_BYTES = 262_144;
/** The longest wait a signed retry hint may ask for. */
export const MAX_RETRY_AFTER_S = 86_400;

const code = z.string().regex(/^[a-z0-9_]{1,40}$/);
const short = z.string().max(64);
const retryAfter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const unixTime = z.number().int().min(0).max(32_503_680_000);

const notice = z
  .object({
    id: code,
    level: z.enum(["info", "planned", "action_required"]),
    until: unixTime.optional(),
  })
  .nullable();

/** Any refusal: the error envelope. */
const errorBody = z.looseObject({
  error: code,
  scope: z.enum(["device", "instance", "tier", "global"]).optional(),
  retryAfter: retryAfter.optional(),
  relayTime: unixTime.optional(),
  reason: code.optional(),
});

const pushResult = z.looseObject({
  ref: z.string().max(40),
  status: z.number().int().min(100).max(599),
  result: code.optional(),
  error: code.optional(),
  reason: short.optional(),
  scope: z.enum(["device", "instance", "tier", "global"]).optional(),
  retryAfter: retryAfter.optional(),
  duplicate: z.boolean().optional(),
});

const registration = z.looseObject({
  instanceId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  tier: z.enum(["probation", "standard", "suspended", "revoked"]).optional(),
});

const SUCCESS: Record<string, z.ZodType> = {
  "POST /v1/instances": registration,
  "POST /v1/instances/self/rotate": registration,
  "POST /v1/push": z.looseObject({
    results: z.array(pushResult).max(50),
    notice: notice.optional(),
    relayTime: unixTime.optional(),
  }),
  "GET /v1/status": z.looseObject({
    state: z.enum(["ok", "degraded", "maintenance", "misconfigured"]),
    tier: z.enum(["probation", "standard", "suspended", "revoked"]).optional(),
    notice: notice.optional(),
    relayTime: unixTime.optional(),
  }),
  "POST /v1/bindings": z.looseObject({
    state: z.enum(["provisional", "active", "soft_invalid"]),
  }),
  "POST /v1/bindings/liveactivity": z.looseObject({
    liveActivity: z.literal("granted"),
  }),
  // `spec/wallet.md`: a detached CMS over the manifest, and who signed it.
  "POST /v1/wallet/apple/sign": z.looseObject({
    signature: z
      .string()
      .min(16)
      .max(22_000)
      .regex(/^[A-Za-z0-9_-]+$/),
    passTypeIdentifier: z.string().regex(/^pass\.[A-Za-z0-9.-]{1,120}$/),
    teamIdentifier: z.string().regex(/^[A-Z0-9]{10}$/),
    signerSubjectO: z.string().max(200),
    certNotAfterDay: z.number().int().min(0).max(1_000_000),
  }),
  "POST /v1/wallet/apple/notify": z.looseObject({
    results: z
      .array(
        z.looseObject({
          ref: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          result: code,
        }),
      )
      .max(50),
  }),
};

/**
 * The parsed body when it fits the endpoint and status, else null. A `2xx`
 * with no body is fine (`204`); a refusal must be the error envelope.
 */
export function parseRelayBody(
  method: string,
  path: string,
  status: number,
  body: unknown,
): Record<string, unknown> | null | "invalid" {
  if (body === null) return status === 204 || status === 200 ? null : "invalid";
  const route = `${method} ${path.split("?")[0]}`;
  const schema =
    status < 300 ? (SUCCESS[route] ?? z.looseObject({})) : errorBody;
  const parsed = schema.safeParse(body);
  return parsed.success ? (parsed.data as Record<string, unknown>) : "invalid";
}

/** The signed retry hint of a body, capped at one day. */
export function signedRetryAfter(
  body: Record<string, unknown> | null,
): number | null {
  const value = body?.retryAfter;
  return typeof value === "number" && value > 0
    ? Math.min(value, MAX_RETRY_AFTER_S)
    : null;
}
