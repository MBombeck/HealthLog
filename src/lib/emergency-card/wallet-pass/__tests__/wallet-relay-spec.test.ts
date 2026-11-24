/**
 * This server against the push relay's Wallet contract (healthlog-push,
 * `spec/wallet.md`).
 *
 * `relay-spec/` holds byte-for-byte copies from healthlog-push at commit
 * 128ef3c (main, "Add the wallet process, the Wallet endpoints and the APNs
 * tunnel"), CC0:
 *
 *   wallet.mjs                  spec/tools/wallet.mjs
 *   wallet-v1.json              spec/vectors/wallet-v1.json
 *   wallet-manifest-v1.json     spec/wallet-manifest-v1.json
 *   AppleWWDRCAG4.cer           internal/wallet/AppleWWDRCAG4.cer
 *   AppleIncRootCertificate.cer internal/wallet/testdata/AppleIncRootCertificate.cer
 *
 * Their SHA-256 is pinned below, so a copy edited here fails, and a new
 * release of the relay's spec is a deliberate re-copy with new pins.
 */
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WALLET_ASSET_HASHES } from "../assets";
import { buildPassFiles, passManifest } from "../bundle";
import { signManifestLocally } from "../cms";
import { buildPassContent } from "../content";
import { checkWalletManifest, WALLET_MANIFEST_RULES } from "../manifest-rules";
import { appleWwdrG4, APPLE_WWDR_G4_SHA256 } from "../wwdr";

import {
  MINIMAL_INPUT,
  NONCE,
  RELAY_SPEC_DIR as DIR,
  relayReference,
  SAMPLE_INPUT,
} from "./fixture";

const { checkManifest, deriveRSAKey } = await relayReference();
const read = (name: string) => readFileSync(join(DIR, name));
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const PINNED_COPIES: Record<string, string> = {
  [`wallet.${"mjs"}`]:
    "1de0cda8e315028ac316cf2a96e6081f15ffd4af7e65a666af8272dca28a01dd",
  "wallet-v1.json":
    "287283feda13f31b553ec2eb7eaf1fd673f8fd53d8624c7fd40fcf43b8104c48",
  "wallet-manifest-v1.json":
    "ab71698fe29c0bec92416b28768599e16cd6b4397273ba64ec41a0cd4bc80e06",
  "AppleWWDRCAG4.cer": APPLE_WWDR_G4_SHA256,
  "AppleIncRootCertificate.cer":
    "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024",
};

interface Vectors {
  seeds: { pass: string };
  certificates: { pass: string; intermediate: string };
  pins: Record<string, string[]>;
  manifests: Array<{ name: string; manifest: string; expect: string }>;
  walletSign: Array<{
    name: string;
    manifest: string;
    signingTime: string;
    signature: string;
  }>;
}
const vectors = JSON.parse(read("wallet-v1.json").toString("utf8")) as Vectors;

function pem(derB64url: string): string {
  const b64 = Buffer.from(derB64url, "base64url").toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${b64.replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
}

describe("the copies of the relay's files", () => {
  it("are the pinned bytes", () => {
    for (const [name, hash] of Object.entries(PINNED_COPIES)) {
      expect(sha256(read(name)), name).toBe(hash);
    }
  });

  it("agree with this server's manifest rules", () => {
    const spec = JSON.parse(read("wallet-manifest-v1.json").toString("utf8"));
    expect(spec.format).toBe(WALLET_MANIFEST_RULES.format);
    expect(spec.maxBytes).toBe(WALLET_MANIFEST_RULES.maxBytes);
    expect(spec.maxEntries).toBe(WALLET_MANIFEST_RULES.maxEntries);
    expect(spec.required).toEqual(WALLET_MANIFEST_RULES.required);
    expect(spec.free).toEqual(WALLET_MANIFEST_RULES.free);
    expect(spec.localized.locales).toEqual(
      WALLET_MANIFEST_RULES.localizedLocales,
    );
    expect(spec.localized.file).toBe(WALLET_MANIFEST_RULES.localizedFile);
    expect(Object.keys(spec.pinned)).toEqual(WALLET_MANIFEST_RULES.pinned);
    // Every image this server bundles is one the service pins by path.
    expect(Object.keys(WALLET_ASSET_HASHES).sort()).toEqual(
      [...WALLET_MANIFEST_RULES.pinned].sort(),
    );
  });
});

describe("the manifest check", () => {
  it("answers every relay vector as the relay does", () => {
    expect(vectors.manifests.length).toBeGreaterThan(20);
    for (const m of vectors.manifests) {
      expect(
        checkWalletManifest(Buffer.from(m.manifest, "utf8"), vectors.pins),
        m.name,
      ).toBe(m.expect);
    }
  });

  it("passes this server's manifests, in the relay's reference too", () => {
    const pins = Object.fromEntries(
      Object.entries(WALLET_ASSET_HASHES).map(([p, h]) => [p, [h]]),
    );
    for (const input of [
      SAMPLE_INPUT,
      MINIMAL_INPUT,
      { ...SAMPLE_INPUT, voidedOnDay: "2026-12-01" },
    ]) {
      const manifest = passManifest(
        buildPassFiles(buildPassContent(input), NONCE),
      );
      expect(checkWalletManifest(manifest)).toBe("ok");
      expect(checkManifest(Buffer.from(manifest), pins)).toBe("ok");
    }
  });

  it("refuses a foreign image, a strange file and a missing icon", () => {
    const manifest = JSON.parse(
      new TextDecoder().decode(
        passManifest(buildPassFiles(buildPassContent(SAMPLE_INPUT), NONCE)),
      ),
    ) as Record<string, string>;
    const enc = (m: Record<string, string>) =>
      new TextEncoder().encode(JSON.stringify(m));
    expect(
      checkWalletManifest(enc({ ...manifest, "icon.png": "0".repeat(40) })),
    ).toBe("foreign_asset");
    expect(
      checkWalletManifest(
        enc({ ...manifest, "thumbnail.png": "0".repeat(40) }),
      ),
    ).toBe("unknown_file");
    const noIcon = { ...manifest };
    delete noIcon["icon.png"];
    expect(checkWalletManifest(enc(noIcon))).toBe("missing_file");
  });
});

describe("the local CMS signer against the relay's vectors", () => {
  it("makes the relay's signatures byte for byte", () => {
    const key = deriveRSAKey(Buffer.from(vectors.seeds.pass, "hex"));
    expect(vectors.walletSign.length).toBeGreaterThan(0);
    for (const v of vectors.walletSign) {
      const signature = signManifestLocally(
        Buffer.from(v.manifest, "base64url"),
        {
          certificatePem: pem(vectors.certificates.pass),
          privateKey: key.privateKey,
          intermediatePem: pem(vectors.certificates.intermediate),
        },
        new Date(v.signingTime),
      );
      expect(Buffer.from(signature).toString("base64url"), v.name).toBe(
        v.signature,
      );
    }
  });
});

describe("the embedded Apple WWDR G4", () => {
  it("is the relay's copy and is issued by the Apple root", () => {
    const wwdr = appleWwdrG4();
    expect(Buffer.from(wwdr.raw).equals(read("AppleWWDRCAG4.cer"))).toBe(true);
    const root = new X509Certificate(read("AppleIncRootCertificate.cer"));
    expect(wwdr.checkIssued(root)).toBe(true);
    expect(wwdr.verify(root.publicKey)).toBe(true);
    expect(wwdr.subject).toContain("OU=G4");
  });
});
