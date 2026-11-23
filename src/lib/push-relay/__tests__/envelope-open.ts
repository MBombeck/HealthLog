/**
 * Test-only receiver for push envelopes, the open order of `spec/envelope.md`
 * step by step. The server never opens an envelope; the vector test and the
 * fake device of the end-to-end test do.
 */
import {
  aeadOpen,
  authDecap,
  BUCKET,
  CLASS_BYTE,
  ENVELOPE_SUITE,
  ENVELOPE_VERSION,
  envelopeAad,
  envelopeLength,
  keySchedule,
  MAX_LIFETIME_S,
  type EnvelopeClass,
} from "@/lib/push-relay/hpke";

export class OpenError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function openEnvelope(input: {
  recipientKeys: Buffer[];
  trustedSenders: Buffer[];
  apnsToken: Buffer;
  envelope: Buffer;
  expectedClass: EnvelopeClass;
  now: number;
}): Record<string, unknown> {
  const { envelope } = input;
  if (envelope.length < 3 + 32 + 16 + 2) throw new OpenError("malformed");
  if (envelope[0] !== ENVELOPE_VERSION || envelope[1] !== ENVELOPE_SUITE) {
    throw new OpenError("unsupportedVersion");
  }
  if (envelope[2] !== CLASS_BYTE[input.expectedClass]) {
    throw new OpenError("classMismatch");
  }
  if (envelope.length !== envelopeLength(input.expectedClass)) {
    throw new OpenError("malformed");
  }
  const header = envelope.subarray(0, 3);
  const enc = envelope.subarray(3, 35);
  const sealed = envelope.subarray(35);
  const aad = envelopeAad(header, input.apnsToken);
  let pt: Buffer | null = null;
  outer: for (const skR of input.recipientKeys) {
    for (const pkS of input.trustedSenders) {
      try {
        const { key, nonce } = keySchedule(authDecap(enc, skR, pkS));
        pt = aeadOpen(key, nonce, aad, sealed);
        break outer;
      } catch {
        /* not this pair */
      }
    }
  }
  if (!pt) throw new OpenError("authFailure");
  const len = pt.readUInt16BE(0);
  if (len === 0 || len + 2 > BUCKET[input.expectedClass]) {
    throw new OpenError("malformed");
  }
  if (!pt.subarray(2 + len).every((b) => b === 0)) {
    throw new OpenError("malformed");
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(STRICT_UTF8.decode(pt.subarray(2, 2 + len)));
  } catch {
    throw new OpenError("malformed");
  }
  if (
    !json ||
    typeof json !== "object" ||
    json.v !== 1 ||
    typeof json.t !== "string" ||
    typeof json.id !== "string" ||
    !ID_RE.test(json.id) ||
    !Number.isInteger(json.iat) ||
    !Number.isInteger(json.exp)
  ) {
    throw new OpenError("malformed");
  }
  const iat = json.iat as number;
  const exp = json.exp as number;
  if (exp <= iat || exp - iat > MAX_LIFETIME_S[input.expectedClass]) {
    throw new OpenError("lifetimeTooLong");
  }
  if (iat > input.now + 300) throw new OpenError("notYetValid");
  if (input.now > exp + 300) throw new OpenError("expired");
  return json;
}
