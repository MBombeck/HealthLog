/**
 * The files of a `.pkpass` (v1.50): `pass.json`, one `pass.strings` per
 * language, the images, `manifest.json` and the signature, zipped.
 *
 * `manifest.json` maps every other file to the hex SHA-1 of its bytes; the
 * signature is a detached CMS over the manifest's exact bytes, so the
 * manifest is the one thing a signer ever needs to see. Its keys are sorted
 * and it is written without spaces, so the same files give the same manifest.
 * The zip is stored with a fixed modification time and a fixed order, so the
 * same files and signature give the same archive.
 */
import { createHash, randomBytes } from "node:crypto";

import { zipSync, type Zippable } from "fflate";

import { locales } from "@/lib/i18n/config";

import { loadWalletAssets, WALLET_ASSET_SIZES } from "./assets";
import type { WalletPassContent } from "./content";
import { serialisePassStrings, withoutNonce } from "./strings";

/** Path to bytes; the files the manifest covers. */
export type PassFiles = Map<string, Uint8Array>;

/**
 * Every path a pass may hold besides the manifest and the signature: the
 * closed set the signing service accepts (the images pinned, `pass.json` and
 * the string tables free). Anything else is refused there, so it is refused
 * here first.
 */
export const WALLET_PASS_PATHS: ReadonlySet<string> = new Set([
  "pass.json",
  ...Object.keys(WALLET_ASSET_SIZES),
  ...locales.map((l) => `${l}.lproj/pass.strings`),
]);

/** The `.lproj` folder of each language. */
export function lprojOf(locale: string): string {
  return `${locale}.lproj`;
}

/** A fresh nonce for the `pass.strings` tables: 128 random bits. */
export function freshStringsNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Every file of the pass but the manifest and the signature. `nonce` is the
 * one per-build random value; pass it in to get the same bytes twice.
 */
export function buildPassFiles(
  content: WalletPassContent,
  nonce: string = freshStringsNonce(),
  assets: PassFiles = loadWalletAssets(),
): PassFiles {
  const encoder = new TextEncoder();
  const files: PassFiles = new Map();
  files.set("pass.json", encoder.encode(JSON.stringify(content.passJson)));
  for (const locale of locales) {
    files.set(
      `${lprojOf(locale)}/pass.strings`,
      encoder.encode(serialisePassStrings(nonce, content.strings[locale])),
    );
  }
  for (const [path, bytes] of assets) files.set(path, bytes);
  for (const path of files.keys()) {
    if (!WALLET_PASS_PATHS.has(path))
      throw new Error(`${path} is not a pass file`);
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** `manifest.json`: path to SHA-1 hex, keys sorted, no whitespace. */
export function passManifest(files: PassFiles): Uint8Array {
  const entries = [...files.keys()]
    .sort()
    .map((path) => [path, sha1(files.get(path) as Uint8Array)] as const);
  return new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries)));
}

/**
 * SHA-256 over the pass's content: `pass.json` and every `pass.strings`
 * without its nonce line, in path order, each prefixed by its path and
 * length. A new nonce alone does not change it; any changed word does.
 */
export function passContentHash(files: PassFiles): string {
  const hash = createHash("sha256");
  const decoder = new TextDecoder();
  for (const path of [...files.keys()].sort()) {
    if (path !== "pass.json" && !path.endsWith("/pass.strings")) continue;
    const raw = files.get(path) as Uint8Array;
    const text =
      path === "pass.json"
        ? decoder.decode(raw)
        : withoutNonce(decoder.decode(raw));
    const bytes = new TextEncoder().encode(text);
    hash.update(`${path}\n${bytes.byteLength}\n`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** A fixed time, read through local getters by the zip writer. */
const ZIP_TIME = new Date(2000, 0, 1, 12, 0, 0);

/** The `.pkpass`: manifest and signature first, then the files in order. */
export function assemblePkpass(
  files: PassFiles,
  manifest: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  const zippable: Zippable = {
    "manifest.json": [manifest, { mtime: ZIP_TIME }],
    signature: [signature, { mtime: ZIP_TIME }],
  };
  for (const [path, bytes] of files) {
    if (path === "manifest.json" || path === "signature") {
      throw new Error(`${path} is not a pass file`);
    }
    // Images are already compressed; deflating them again buys nothing.
    zippable[path] = [
      bytes,
      { mtime: ZIP_TIME, level: path.endsWith(".png") ? 0 : 6 },
    ];
  }
  return zipSync(zippable, { mtime: ZIP_TIME });
}
