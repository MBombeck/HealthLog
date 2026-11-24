/**
 * `WALLET_APPLE_*` for the e2e web server: local pass signing with the push
 * relay's public test chain, so the Wallet journey can make, download and
 * withdraw a real signed pass without Apple's certificate.
 *
 * The chain is the one the unit tests sign with
 * (`src/lib/emergency-card/wallet-pass/__tests__/relay-spec/wallet-v1.json`,
 * CC0, copied from healthlog-push): a test root, an intermediate standing in
 * for Apple's WWDR, and a Pass Type ID certificate whose RSA key is derived
 * from a public seed by the relay's reference code. Nothing here is secret and
 * no key file is committed; the key is derived when the config loads (about
 * 0.2 s). A pass signed this way is valid only against the test root: Wallet
 * on a device refuses it, which is why the device test waits for the real
 * certificate.
 *
 * The derivation runs in a child Node process. Playwright's loader transpiles
 * the config and everything it imports as CommonJS, and the reference code is
 * an ES module; a separate process keeps that boundary out of the loader.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const RELAY_SPEC_DIR = resolve(
  process.cwd(),
  "src/lib/emergency-card/wallet-pass/__tests__/relay-spec",
);

const DERIVE = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[1];
const { deriveRSAKey } = await import(join(dir, "wallet.mjs"));
const v = JSON.parse(readFileSync(join(dir, "wallet-v1.json"), "utf8"));
const key = deriveRSAKey(Buffer.from(v.seeds.pass, "hex")).privateKey;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const der = (b64url) => Buffer.from(b64url, "base64url");
process.stdout.write(JSON.stringify({
  WALLET_APPLE_PASS_TYPE_ID: v.passTypeIdentifier,
  WALLET_APPLE_TEAM_ID: v.teamIdentifier,
  WALLET_APPLE_CERT_B64: b64(der(v.certificates.pass)),
  WALLET_APPLE_KEY_B64: b64(key.export({ type: "pkcs8", format: "pem" })),
  WALLET_APPLE_WWDR_B64: b64(der(v.certificates.intermediate)),
}));
`;

export type WalletTestSignerEnv = Record<
  | "WALLET_APPLE_PASS_TYPE_ID"
  | "WALLET_APPLE_TEAM_ID"
  | "WALLET_APPLE_CERT_B64"
  | "WALLET_APPLE_KEY_B64"
  | "WALLET_APPLE_WWDR_B64",
  string
>;

/** The five variables that switch local signing on with the test chain. */
export function walletTestSignerEnv(): WalletTestSignerEnv {
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", DERIVE, RELAY_SPEC_DIR],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as WalletTestSignerEnv;
}

/** The pass type and team the server signs under with the test chain. */
export const WALLET_TEST_PASS_TYPE_ID = "pass.dev.healthlog.vector";
export const WALLET_TEST_TEAM_ID = "VECTOR1234";
