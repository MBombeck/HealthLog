/**
 * One sealed push for one device, the same for every transport.
 *
 * Every push this server sends to a device that registered a push key is
 * built here: over the relay (`relay-send.ts`) and over this server's own
 * APNs key (`direct-send.ts`). Both carry the identical envelope inside the
 * identical fixed template the relay uses (`spec/protocol.md`, "What the relay
 * sends to Apple"), so a device sees one format whatever path a push took.
 * The template carries no visible text, category, thread or interruption
 * level; the Notification Service Extension sets all of that after it opened
 * the envelope.
 */
import { fromHex, toBase64Url } from "@/lib/push-relay/encoding";
import { sealPadded, type EnvelopeClass } from "@/lib/push-relay/hpke";
import {
  buildPlaintext,
  padPlaintext,
  type EnvelopeText,
  type EnvelopeUi,
} from "@/lib/push-relay/plaintext";

export interface SealedPush {
  pushClass: "alert" | "silent";
  /** The plaintext `id`: the replay key, and the relay `ref`. */
  id: string;
  /** The plaintext `exp`, unix seconds. */
  exp: number;
  type: string;
  /** The envelope, unpadded base64url. */
  envelope: string;
}

export interface EnvelopeMessage {
  pushClass: "alert" | "silent";
  type: string;
  lifetimeSeconds: number;
  data?: Record<string, unknown>;
  text?: EnvelopeText;
  ui?: EnvelopeUi;
}

/** Seal `message` for one device. Throws `EnvelopeSealError` on a bad key. */
export function sealForDevice(input: {
  message: EnvelopeMessage;
  device: { apnsToken: string; pushKeyPublic: Buffer };
  senderPrivateKey: Buffer;
  nowMs?: number;
}): SealedPush {
  const token = fromHex(input.device.apnsToken);
  if (!token) throw new Error("device token is not hex");
  const { padded, plaintext } = padPlaintext(
    input.message.pushClass,
    buildPlaintext({
      pushClass: input.message.pushClass,
      type: input.message.type,
      lifetimeSeconds: input.message.lifetimeSeconds,
      nowMs: input.nowMs,
      data: input.message.data,
      text: input.message.text,
      ui: input.message.ui,
    }),
  );
  const envelope = sealPadded({
    pushClass: input.message.pushClass,
    padded,
    recipientPublicKey: input.device.pushKeyPublic,
    senderPrivateKey: input.senderPrivateKey,
    apnsToken: token,
  });
  return {
    pushClass: input.message.pushClass,
    id: plaintext.id,
    exp: plaintext.exp,
    type: plaintext.t,
    envelope: toBase64Url(envelope),
  };
}

/** The fixed APNs body of a sealed push, byte for byte the relay's template. */
export function templateFor(
  pushClass: EnvelopeClass,
  envelope: string,
): Record<string, unknown> {
  if (pushClass === "alert") {
    return {
      aps: {
        alert: { "loc-key": "HL_RELAY_ALERT" },
        "mutable-content": 1,
        sound: "default",
      },
      e: envelope,
    };
  }
  return { aps: { "content-available": 1 }, e: envelope };
}
