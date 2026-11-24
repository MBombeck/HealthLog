/**
 * `WALLET_APPLE_*`: all or none, checked as a whole, fail closed, and never
 * a value in what comes back. The certificates are the relay's test chain
 * (`relay-spec/wallet-v1.json`, keys derived from public seeds), so nothing
 * secret is committed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readLocalWalletConfig } from "../local-signer";
import { signWalletManifest, walletSigningMode } from "../sign";
import { buildPassFiles, passManifest } from "../bundle";
import { buildPassContent } from "../content";

import { NONCE, RELAY_SPEC_DIR, relayReference, SAMPLE_INPUT } from "./fixture";

const { deriveRSAKey } = await relayReference();
const vectors = JSON.parse(
  readFileSync(join(RELAY_SPEC_DIR, "wallet-v1.json"), "utf8"),
) as {
  seeds: { pass: string; intermediate: string };
  certificates: { pass: string; intermediate: string; root: string };
  passTypeIdentifier: string;
  teamIdentifier: string;
  signerSubjectO: string;
};

const NOW = new Date("2026-12-01T10:00:00Z");
const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const der = (b64url: string) => Buffer.from(b64url, "base64url");

const passKey = deriveRSAKey(Buffer.from(vectors.seeds.pass, "hex")).privateKey;
const otherKey = deriveRSAKey(
  Buffer.from(vectors.seeds.intermediate, "hex"),
).privateKey;
const PASSPHRASE = "a passphrase for the test key";

function env(extra: Record<string, string | undefined> = {}) {
  return {
    WALLET_APPLE_PASS_TYPE_ID: vectors.passTypeIdentifier,
    WALLET_APPLE_TEAM_ID: vectors.teamIdentifier,
    // DER, base64: accepted as well as PEM.
    WALLET_APPLE_CERT_B64: b64(der(vectors.certificates.pass)),
    WALLET_APPLE_KEY_B64: b64(
      passKey.export({ type: "pkcs8", format: "pem" }) as string,
    ),
    WALLET_APPLE_WWDR_B64: b64(der(vectors.certificates.intermediate)),
    ...extra,
  };
}

describe("readLocalWalletConfig", () => {
  it("is off with nothing set", () => {
    expect(readLocalWalletConfig({}, NOW)).toEqual({ state: "off" });
  });

  it("is ready with a set that holds together", () => {
    const config = readLocalWalletConfig(env(), NOW);
    expect(config.state).toBe("ready");
    if (config.state !== "ready") return;
    expect(config.identity).toMatchObject({
      passTypeIdentifier: vectors.passTypeIdentifier,
      teamIdentifier: vectors.teamIdentifier,
      organization: vectors.signerSubjectO,
    });
    expect(config.identity.certNotAfter.toISOString()).toBe(
      "2036-01-01T00:00:00.000Z",
    );
  });

  it("opens a key sealed with its passphrase", () => {
    const sealed = passKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: PASSPHRASE,
    }) as string;
    expect(
      readLocalWalletConfig(
        env({
          WALLET_APPLE_KEY_B64: b64(sealed),
          WALLET_APPLE_KEY_PASSPHRASE: PASSPHRASE,
        }),
        NOW,
      ).state,
    ).toBe("ready");
    expect(
      readLocalWalletConfig(
        env({
          WALLET_APPLE_KEY_B64: b64(sealed),
          WALLET_APPLE_KEY_PASSPHRASE: "wrong",
        }),
        NOW,
      ),
    ).toEqual({ state: "invalid", problem: "key" });
  });

  it("refuses every set that does not hold together, naming no value", () => {
    const cases: Array<[Record<string, string | undefined>, string, Date?]> = [
      [{ WALLET_APPLE_KEY_B64: undefined }, "incomplete"],
      [{ WALLET_APPLE_PASS_TYPE_ID: "org.example" }, "pass_type_id"],
      [{ WALLET_APPLE_TEAM_ID: "short" }, "team_id"],
      [{ WALLET_APPLE_CERT_B64: b64("not a certificate") }, "certificate"],
      [{ WALLET_APPLE_KEY_B64: b64("not a key") }, "key"],
      [
        {
          WALLET_APPLE_KEY_B64: b64(
            otherKey.export({ type: "pkcs8", format: "pem" }) as string,
          ),
        },
        "key_mismatch",
      ],
      // Without an intermediate of its own, the set is held against Apple
      // WWDR G4, which did not issue the test certificate.
      [{ WALLET_APPLE_WWDR_B64: undefined }, "issuer"],
      [{ WALLET_APPLE_TEAM_ID: "OTHER12345" }, "identifier_mismatch"],
      [
        { WALLET_APPLE_PASS_TYPE_ID: "pass.org.example.other" },
        "identifier_mismatch",
      ],
      [{}, "not_yet_valid", new Date("2025-06-01T00:00:00Z")],
      [{}, "expiring", new Date("2035-12-28T00:00:00Z")],
    ];
    for (const [extra, problem, at] of cases) {
      const config = readLocalWalletConfig(env(extra), at ?? NOW);
      expect(config, problem).toEqual({ state: "invalid", problem });
    }
    // Only an optional variable set still counts as a partial set.
    expect(
      readLocalWalletConfig({ WALLET_APPLE_KEY_PASSPHRASE: PASSPHRASE }, NOW),
    ).toEqual({ state: "invalid", problem: "incomplete" });
  });
});

describe("signing with the operator's own Pass Type ID", () => {
  const manifest = passManifest(
    buildPassFiles(buildPassContent(SAMPLE_INPUT), NONCE),
  );
  const local = {
    signer: "LOCAL" as const,
    passTypeIdentifier: vectors.passTypeIdentifier,
    teamIdentifier: vectors.teamIdentifier,
  };

  it("signs a pass made with the same identity", async () => {
    const mode = walletSigningMode(env(), NOW);
    expect(mode.kind).toBe("local");
    const signed = await signWalletManifest(manifest, local, mode);
    expect(signed.ok).toBe(true);
    if (signed.ok) expect(signed.signature[0]).toBe(0x30);
  });

  it("does not sign a pass made under another identity or signer", async () => {
    const mode = walletSigningMode(env(), NOW);
    for (const pass of [
      { ...local, teamIdentifier: "OTHER12345" },
      { ...local, signer: "RELAY" as const },
    ]) {
      expect(await signWalletManifest(manifest, pass, mode)).toMatchObject({
        ok: false,
        reason: "signer_changed",
      });
    }
  });

  it("signs nothing with a broken set, and never falls back to the relay", async () => {
    const mode = walletSigningMode(env({ WALLET_APPLE_TEAM_ID: "x" }), NOW);
    expect(mode).toEqual({ kind: "invalid", problem: "team_id" });
    for (const signer of ["LOCAL", "RELAY"] as const) {
      expect(
        await signWalletManifest(manifest, { ...local, signer }, mode),
      ).toMatchObject({ ok: false, reason: "signer_changed" });
    }
  });

  it("throws on a manifest the signing service would refuse", async () => {
    const mode = walletSigningMode(env(), NOW);
    await expect(
      signWalletManifest(
        new TextEncoder().encode('{"thumbnail.png":"' + "0".repeat(40) + '"}'),
        local,
        mode,
      ),
    ).rejects.toThrow(/unknown_file/);
  });
});
