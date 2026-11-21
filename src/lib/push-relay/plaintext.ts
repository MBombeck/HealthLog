/**
 * The plaintext inside a push envelope (`spec/envelope.md`, "Plaintext
 * schema") and its padding to the fixed bucket of the class.
 *
 * `id` is a ULID and the receiver's replay key; `iat` and `exp` bound the
 * lifetime, so nobody on the path can hold an envelope back and deliver it
 * later than this server intended. The padded form is
 * `uint16_be(len) || json || zero bytes` up to the bucket. When the JSON does
 * not fit, the visible texts are shortened at character boundaries, measured
 * after JSON encoding, until it does; the bucket never changes.
 */
import { randomBytes } from "node:crypto";

import {
  BUCKET,
  MAX_LIFETIME_S,
  type EnvelopeClass,
} from "@/lib/push-relay/hpke";

export interface EnvelopeText {
  title?: string;
  body?: string;
  subtitle?: string;
}

export interface EnvelopeUi {
  /** A logical category name the NSE maps to its own identifier. */
  category?: string;
  thread?: string;
  level?: "passive" | "active" | "time-sensitive";
  sound?: "default";
  badge?: number;
}

export interface EnvelopePlaintext {
  v: 1;
  t: string;
  id: string;
  iat: number;
  exp: number;
  d?: Record<string, unknown>;
  n?: EnvelopeText;
  ui?: EnvelopeUi;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of milliseconds, 80 random bits, Crockford base32. */
export function newUlid(nowMs: number = Date.now()): string {
  let time = "";
  let t = Math.floor(nowMs);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits, five at a time.
  const random = randomBytes(10);
  let tail = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of random) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      tail += CROCKFORD[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return time + tail;
}

/** The plaintext of one envelope, with its lifetime clamped to the class. */
export function buildPlaintext(input: {
  pushClass: EnvelopeClass;
  type: string;
  lifetimeSeconds: number;
  nowMs?: number;
  data?: Record<string, unknown>;
  text?: EnvelopeText;
  ui?: EnvelopeUi;
}): EnvelopePlaintext {
  const nowMs = input.nowMs ?? Date.now();
  const iat = Math.floor(nowMs / 1000);
  const lifetime = Math.max(
    1,
    Math.min(
      Math.floor(input.lifetimeSeconds),
      MAX_LIFETIME_S[input.pushClass],
    ),
  );
  return {
    v: 1,
    t: input.type,
    id: newUlid(nowMs),
    iat,
    exp: iat + lifetime,
    ...(input.data ? { d: input.data } : {}),
    ...(input.text ? { n: input.text } : {}),
    ...(input.ui ? { ui: input.ui } : {}),
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Drop the last code point of a string. */
function shorten(text: string): string {
  const chars = Array.from(text);
  chars.pop();
  return chars.join("");
}

/**
 * The plaintext shortened until its JSON fits `limit` bytes: the longest
 * visible text loses one character at a time. Throws when even empty texts
 * do not fit, which only an oversized `d` can cause.
 */
export function fitPlaintext(
  plaintext: EnvelopePlaintext,
  limit: number,
): EnvelopePlaintext {
  if (jsonBytes(plaintext) <= limit) return plaintext;
  const text: EnvelopeText = { ...plaintext.n };
  const fields = ["body", "subtitle", "title"] as const;
  let candidate: EnvelopePlaintext = { ...plaintext, n: text };
  while (jsonBytes(candidate) > limit) {
    const longest = fields
      .filter((f) => (text[f]?.length ?? 0) > 0)
      .sort((a, b) => (text[b]?.length ?? 0) - (text[a]?.length ?? 0))[0];
    if (!longest) throw new Error("push envelope data exceeds its bucket");
    text[longest] = shorten(text[longest] ?? "");
    candidate = { ...plaintext, n: text };
  }
  return candidate;
}

/** `uint16_be(len) || json || zeros` up to the bucket of the class. */
export function padPlaintext(
  pushClass: EnvelopeClass,
  plaintext: EnvelopePlaintext,
): { padded: Buffer; plaintext: EnvelopePlaintext } {
  const size = BUCKET[pushClass];
  const fitted = fitPlaintext(plaintext, size - 2);
  const body = Buffer.from(JSON.stringify(fitted), "utf8");
  const padded = Buffer.alloc(size);
  padded.writeUInt16BE(body.length, 0);
  body.copy(padded, 2);
  return { padded, plaintext: fitted };
}
