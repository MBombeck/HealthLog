/**
 * A random v4 UUID that also works on a plain-HTTP origin.
 *
 * `crypto.randomUUID()` is marked `[SecureContext]` in the Web Cryptography
 * IDL, so on a LAN self-host served over plain HTTP the property is simply
 * absent and the call throws `TypeError: crypto.randomUUID is not a
 * function`. Measured in Chromium on `http://<lan-ip>`: `isSecureContext`
 * false, `crypto.randomUUID` and `crypto.subtle` undefined — but
 * `crypto.getRandomValues` still a function, because it carries no
 * `[SecureContext]` marker.
 *
 * That threw where nobody caught it. The document-vault upload minted a
 * queue id and an `Idempotency-Key` this way inside the file-input change
 * handler, so picking a file on a plain-HTTP host did nothing at all: no
 * queue row, no request, no error. Since the client transport started
 * minting a default `Idempotency-Key`, every `apiPost` / `apiPatch` in the
 * app failed the same way on such a host.
 *
 * So the id is built from `getRandomValues` whenever `randomUUID` is out of
 * reach. Same 122 bits of entropy from the same CSPRNG, same RFC 4122
 * version-4 layout, no secure context required. Nothing in an upload needs
 * one: the bytes go out over multipart XHR and every cryptographic
 * operation happens on the server.
 */

/** Hex lookup for the byte→string step; built once. */
const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/**
 * A fresh RFC 4122 version-4 UUID.
 *
 * Prefers the platform's own `randomUUID` and falls back to the
 * always-available `getRandomValues`. Use this instead of
 * `crypto.randomUUID()` in anything that runs in the browser — the
 * `client-random-id-guard` test fails a direct call.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 §4.4: version nibble to 4, variant bits to 0b10.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => HEX[b]!).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
