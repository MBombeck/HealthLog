/**
 * The images of an emergency-card pass (v1.50): the HealthLog mark as icon
 * and logos, and the poster artwork. The same files go into every pass of
 * every instance, because the project's signing service only signs a pass
 * whose images are exactly these (it pins their SHA-1). A changed image is a
 * new `wallet-assets.v<n>.json` and a matching release of the signing
 * service, never an edit in place.
 *
 * Made by `scripts/wallet/generate-pass-assets.mjs` from the mark in
 * `public/favicon.svg`; the PNGs are committed, and the hash list next to
 * them is what the loader checks every file against before it is used, so a
 * file changed on disk fails closed instead of producing a pass the signer
 * refuses.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import hashes from "./assets/wallet-assets.v2.json";

/** Read from disk by a path the tracer cannot follow (next.config.ts). */
const ASSET_DIR = join(
  process.cwd(),
  "src/lib/emergency-card/wallet-pass/assets",
);

/** File name to its size in pixels (width, height), at Apple's @1x, @2x and @3x. */
export const WALLET_ASSET_SIZES: Readonly<
  Record<string, readonly [number, number]>
> = {
  "icon.png": [38, 38],
  "icon@2x.png": [76, 76],
  "icon@3x.png": [114, 114],
  // The logos are as wide as the mark is: 50 and 30 pt high, no margin.
  "logo@2x.png": [108, 100],
  "logo@3x.png": [162, 150],
  "primaryLogo@2x.png": [65, 60],
  "primaryLogo@3x.png": [97, 90],
  "artwork@2x.png": [716, 896],
  "artwork@3x.png": [1074, 1344],
};

/** The pinned SHA-1 of each image, as the signing service holds them. */
export const WALLET_ASSET_HASHES: Readonly<Record<string, string>> = hashes;

let cache: Map<string, Uint8Array> | null = null;

export function loadWalletAssets(): Map<string, Uint8Array> {
  if (cache) return new Map(cache);
  const out = new Map<string, Uint8Array>();
  for (const name of Object.keys(WALLET_ASSET_SIZES)) {
    const bytes = new Uint8Array(readFileSync(join(ASSET_DIR, name)));
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    if (sha1 !== WALLET_ASSET_HASHES[name]) {
      throw new Error(`wallet asset ${name} does not match its pinned hash`);
    }
    out.set(name, bytes);
  }
  cache = out;
  return new Map(out);
}
