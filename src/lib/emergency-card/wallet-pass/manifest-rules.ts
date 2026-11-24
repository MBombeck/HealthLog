/**
 * What the project's signing service accepts as a pass manifest
 * (`spec/wallet-manifest-v1.json` and `spec/wallet.md` in healthlog-push),
 * checked here before a manifest leaves the server, so a pass the service
 * would refuse fails on this side with the same reason instead of as a
 * signing outage. A test holds these constants against a byte-pinned copy of
 * the relay's file.
 *
 * The images are checked against this server's own pinned hashes
 * (`wallet-assets.v1.json`), which are the ones the service pins. The
 * reading is the service's, strict: the relay's own test vectors run
 * through it with the same answers.
 */
import { WALLET_ASSET_HASHES } from "./assets";

export const WALLET_MANIFEST_RULES = {
  format: "healthlog-wallet-manifest-v1",
  maxBytes: 8192,
  maxEntries: 40,
  required: ["pass.json", "icon.png"],
  free: ["pass.json"],
  localizedLocales: [
    "de",
    "en",
    "es",
    "fr",
    "it",
    "ko",
    "nl",
    "pl",
    "pt-BR",
    "pt_BR",
    "ru",
  ],
  localizedFile: "pass.strings",
  pinned: [
    "icon.png",
    "icon@2x.png",
    "icon@3x.png",
    "logo@2x.png",
    "logo@3x.png",
    "primaryLogo@2x.png",
    "primaryLogo@3x.png",
    "artwork@2x.png",
    "artwork@3x.png",
  ],
} as const;

export type ManifestVerdict =
  | "ok"
  | "shape"
  | "too_many"
  | "unknown_file"
  | "foreign_asset"
  | "missing_file";

const HASH = /^[0-9a-f]{40}$/;
const LOCALIZED = /^([^/]+)\.lproj\/pass\.strings$/;
// JSON forbids raw control characters in a string, so the reader does too.
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const SPACE = /[ \t\n\r]*/y;

/**
 * One JSON object of string to string, in order, read the way the service
 * reads it: a repeated key, a value that is not a string, or anything after
 * the object is refused (null), where `JSON.parse` would keep the last key.
 */
function readPairs(text: string): Array<[string, string]> | null {
  let i = 0;
  const ws = () => {
    SPACE.lastIndex = i;
    SPACE.exec(text);
    i = SPACE.lastIndex;
  };
  const str = (): string | null => {
    STRING.lastIndex = i;
    const m = STRING.exec(text);
    if (!m) return null;
    i = STRING.lastIndex;
    return JSON.parse(m[0]) as string;
  };
  const out: Array<[string, string]> = [];
  ws();
  if (text[i++] !== "{") return null;
  ws();
  if (text[i] === "}") {
    i++;
    ws();
    return i === text.length ? out : null;
  }
  for (;;) {
    ws();
    const key = str();
    ws();
    if (key === null || text[i++] !== ":") return null;
    ws();
    const value = str();
    if (value === null) return null;
    out.push([key, value]);
    ws();
    const c = text[i++];
    if (c === "}") break;
    if (c !== ",") return null;
  }
  ws();
  return i === text.length ? out : null;
}

/**
 * The service's verdict on `bytes`, in its order. `pins` are the accepted
 * hashes per image path; by default this server's own, which are the ones
 * the service pins.
 */
export function checkWalletManifest(
  bytes: Uint8Array,
  pins: Readonly<Record<string, readonly string[]>> = OWN_PINS,
): ManifestVerdict {
  const rules = WALLET_MANIFEST_RULES;
  if (bytes.byteLength > rules.maxBytes) return "shape";
  let pairs: Array<[string, string]> | null;
  try {
    pairs = readPairs(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "shape";
  }
  if (pairs === null) return "shape";
  const seen = new Set<string>();
  for (const [path, hash] of pairs) {
    if (seen.has(path) || !HASH.test(hash)) return "shape";
    if (seen.size === rules.maxEntries) return "too_many";
    seen.add(path);
  }
  const locales: readonly string[] = rules.localizedLocales;
  const pinned: readonly string[] = rules.pinned;
  for (const [path, hash] of pairs) {
    const m = LOCALIZED.exec(path);
    if (path === "pass.json" || (m && locales.includes(m[1]))) continue;
    if (pinned.includes(path)) {
      if (!(pins[path] ?? []).includes(hash)) return "foreign_asset";
      continue;
    }
    return "unknown_file";
  }
  for (const required of rules.required) {
    if (!seen.has(required)) return "missing_file";
  }
  return "ok";
}

const OWN_PINS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    Object.entries(WALLET_ASSET_HASHES).map(([path, hash]) => [path, [hash]]),
  );
