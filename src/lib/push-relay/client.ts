/**
 * The HTTP client of the relay protocol (`spec/protocol.md`).
 *
 * Every instance request is signed with the instance key over `hl-relay-v1`
 * (host, instance id, method, path with query, time, nonce, body hash). Every
 * response must carry `HL-Relay-Signature` by a pinned relay identity key over
 * `hl-relay-resp-v1`, bound to the nonce of this very request. A response that
 * is unsigned, signed by another key, or signed for another request is a
 * transport error: it is never acted on as a refusal, a revocation, a
 * deletion or a notice, because a DNS or TLS takeover could otherwise answer
 * `410` for every device.
 *
 * `401 stale_timestamp` carries the relay clock; the client stores the offset
 * and retries exactly once with a corrected time and a fresh nonce.
 *
 * Egress goes through `safeFetch` with `requirePublicHost`, no redirects and
 * a 10 s deadline, on the long-lived pinned dispatcher (`keepAlive`), so a
 * push that follows another within 55 s reuses the open connection instead
 * of paying DNS, TCP and TLS again.
 */
import { randomBytes } from "node:crypto";

import { safeFetch } from "@/lib/safe-fetch";
import { getEvent } from "@/lib/logging/context";
import packageJson from "../../../package.json";
import {
  RELAY_CLIENT_NAME,
  RELAY_REQUEST_TIMEOUT_MS,
  type RelayConfig,
} from "@/lib/push-relay/config";
import { fromBase64Url, toBase64Url } from "@/lib/push-relay/encoding";
import {
  MAX_RELAY_BODY_BYTES,
  parseRelayBody,
  signedRetryAfter,
} from "@/lib/push-relay/responses";
import {
  ed25519PublicOf,
  registerText,
  requestText,
  responseText,
  signText,
  verifyText,
} from "@/lib/push-relay/statements";

export type RelayCallResult =
  | {
      kind: "response";
      status: number;
      body: Record<string, unknown> | null;
      /** The signed body's `retryAfter`, seconds, capped at one day. */
      retryAfter: number | null;
    }
  | { kind: "transport"; reason: string };

export interface RelayIdentity {
  instanceId: string;
  instanceSeed: Buffer;
  clockOffsetSeconds: number;
}

/** A hook the caller uses to persist a learnt clock offset. */
export type OffsetSink = (offsetSeconds: number) => Promise<void> | void;

function clientHeader(): string {
  const version = /^\d+\.\d+\.\d+/.exec(packageJson.version)?.[0] ?? "0.0.0";
  return `${RELAY_CLIENT_NAME}/${version}`;
}

function nowSeconds(offset: number): number {
  return Math.floor(Date.now() / 1000) + offset;
}

/**
 * Whether `signature` is a pinned relay key's `hl-relay-resp-v2` signature
 * of this response to this request. A response bound to `-` (no nonce) never
 * verifies: every request this server sends carries one.
 */
export function verifyRelayResponse(
  config: Pick<RelayConfig, "host" | "identityKeys">,
  request: { method: string; pathAndQuery: string; nonce: string },
  status: number,
  body: Buffer,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader || !/^[A-Za-z0-9_-]{22}$/.test(request.nonce)) {
    return false;
  }
  const signature = fromBase64Url(signatureHeader, 64);
  if (!signature) return false;
  const text = responseText({
    host: config.host,
    method: request.method,
    pathAndQuery: request.pathAndQuery,
    nonce: request.nonce,
    status,
    body,
  });
  return config.identityKeys.some((key) => verifyText(key, text, signature));
}

/** Read at most `limit` bytes of a body; null when it is longer or breaks. */
async function readBounded(
  response: Response,
  limit: number,
): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

async function exchange(
  config: RelayConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: string,
  headers: Record<string, string>,
  nonce: string,
): Promise<RelayCallResult> {
  let response: Response;
  try {
    response = await safeFetch(
      `${config.origin}${path}`,
      {
        method,
        headers: {
          ...headers,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      },
      {
        requirePublicHost: true,
        keepAlive: true,
        timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
      },
    );
  } catch (err) {
    const kind = (err as { kind?: string }).kind;
    return {
      kind: "transport",
      reason: kind ? `relay_${kind}` : "relay_network",
    };
  }
  const bytes = await readBounded(response, MAX_RELAY_BODY_BYTES);
  if (!bytes) return { kind: "transport", reason: "relay_body_too_large" };
  if (
    !verifyRelayResponse(
      config,
      { method, pathAndQuery: path, nonce },
      response.status,
      bytes,
      response.headers.get("hl-relay-signature"),
    )
  ) {
    getEvent()?.addMeta("push_relay_signature_invalid", response.status);
    return { kind: "transport", reason: "relay_signature_invalid" };
  }
  let json: unknown = null;
  if (bytes.length > 0) {
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { kind: "transport", reason: "relay_body_invalid" };
    }
  }
  const parsed = parseRelayBody(method, path, response.status, json);
  if (parsed === "invalid") {
    return { kind: "transport", reason: "relay_body_invalid" };
  }
  // Only the signed body's hint counts; the `Retry-After` header is not
  // signed and is ignored.
  return {
    kind: "response",
    status: response.status,
    body: parsed,
    retryAfter: signedRetryAfter(parsed),
  };
}

/** The clock offset a relay time implies, never more than a day either way. */
function boundedOffset(relayTime: number): number {
  const offset = relayTime - Math.floor(Date.now() / 1000);
  return Math.max(-86_400, Math.min(86_400, offset));
}

function staleRelayTime(result: RelayCallResult): number | null {
  if (
    result.kind === "response" &&
    result.status === 401 &&
    result.body?.error === "stale_timestamp" &&
    typeof result.body.relayTime === "number"
  ) {
    return result.body.relayTime;
  }
  return null;
}

/** One signed instance request, retried once after `stale_timestamp`. */
export async function signedRelayCall(
  config: RelayConfig,
  identity: RelayIdentity,
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload: unknown,
  onOffset?: OffsetSink,
): Promise<RelayCallResult> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  let offset = identity.clockOffsetSeconds;
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = toBase64Url(randomBytes(16));
    const timestamp = nowSeconds(offset);
    const signature = signText(
      identity.instanceSeed,
      requestText({
        host: config.host,
        instanceId: identity.instanceId,
        method,
        pathAndQuery: path,
        timestamp,
        nonce,
        body,
      }),
    );
    const result = await exchange(
      config,
      method,
      path,
      body,
      {
        "HL-Instance": identity.instanceId,
        "HL-Timestamp": String(timestamp),
        "HL-Nonce": nonce,
        "HL-Signature": toBase64Url(signature),
        "HL-Client": clientHeader(),
      },
      nonce,
    );
    const relayTime = staleRelayTime(result);
    if (relayTime === null || attempt > 0) return result;
    offset = boundedOffset(relayTime);
    await onOffset?.(offset);
  }
  return { kind: "transport", reason: "relay_unreachable" };
}

/**
 * The `POST /v1/instances` body. `invite` is the operator's one-time code for
 * a relay in invite mode; without one the field is left out.
 */
export function registrationBody(
  config: RelayConfig,
  instanceSeed: Buffer,
  time: number,
  invite?: string,
): string {
  const publicKey = ed25519PublicOf(instanceSeed);
  return JSON.stringify({
    publicKey: toBase64Url(publicKey),
    client: clientHeader(),
    time,
    proof: toBase64Url(
      signText(instanceSeed, registerText(config.host, publicKey, time)),
    ),
    ...(invite ? { invite } : {}),
  });
}

/** `POST /v1/instances`: register (or recover) the instance key. */
export async function registerInstance(
  config: RelayConfig,
  instanceSeed: Buffer,
  clockOffsetSeconds: number,
  onOffset?: OffsetSink,
  invite?: string,
): Promise<RelayCallResult> {
  let offset = clockOffsetSeconds;
  for (let attempt = 0; attempt < 2; attempt++) {
    const time = nowSeconds(offset);
    const body = registrationBody(config, instanceSeed, time, invite);
    const nonce = toBase64Url(randomBytes(16));
    const result = await exchange(
      config,
      "POST",
      "/v1/instances",
      body,
      { "HL-Nonce": nonce },
      nonce,
    );
    const relayTime = staleRelayTime(result);
    if (relayTime === null || attempt > 0) return result;
    offset = boundedOffset(relayTime);
    await onOffset?.(offset);
  }
  return { kind: "transport", reason: "relay_unreachable" };
}
