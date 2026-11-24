/**
 * The local CMS signer against OpenSSL.
 *
 * The test makes a throwaway PKI in a temporary folder (a root, an
 * intermediate in the place of Apple WWDR, a pass certificate under it),
 * signs a manifest, and asks `openssl smime -verify` to check the signature
 * the way a pass is checked: detached content, the chain to the root. A
 * changed manifest must then fail. No key is committed; every run makes its
 * own and deletes it. Skipped where `openssl` is not on the path.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assemblePkpass, buildPassFiles, passManifest } from "../bundle";
import { signManifestLocally, type LocalSigner } from "../cms";
import { buildPassContent } from "../content";

import { NONCE, SAMPLE_INPUT } from "./fixture";

const HAS_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

function openssl(dir: string, args: string[]) {
  return spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
}

/** Root, intermediate (CA), pass certificate (leaf), all RSA-2048. */
function makePki(dir: string): LocalSigner {
  const run = (args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  writeFileSync(
    join(dir, "ca.ext"),
    "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n",
  );
  writeFileSync(
    join(dir, "leaf.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n",
  );
  run([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    "root.key",
  ]);
  run([
    "req",
    "-x509",
    "-new",
    "-key",
    "root.key",
    "-subj",
    "/CN=Test Root/O=Example",
    "-days",
    "2",
    "-out",
    "root.pem",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  run([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    "wwdr.key",
  ]);
  run([
    "req",
    "-new",
    "-key",
    "wwdr.key",
    "-subj",
    "/CN=Test Intermediate/O=Example",
    "-out",
    "wwdr.csr",
  ]);
  run([
    "x509",
    "-req",
    "-in",
    "wwdr.csr",
    "-CA",
    "root.pem",
    "-CAkey",
    "root.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    "ca.ext",
    "-out",
    "wwdr.pem",
  ]);
  run([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    "pass.key",
  ]);
  run([
    "req",
    "-new",
    "-key",
    "pass.key",
    "-subj",
    "/UID=pass.dev.healthlog.emergency/CN=Pass Type ID: test/OU=ABCDE12345/O=Example",
    "-out",
    "pass.csr",
  ]);
  run([
    "x509",
    "-req",
    "-in",
    "pass.csr",
    "-CA",
    "wwdr.pem",
    "-CAkey",
    "wwdr.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    "leaf.ext",
    "-out",
    "pass.pem",
  ]);
  return {
    certificatePem: readFileSync(join(dir, "pass.pem"), "utf8"),
    privateKeyPem: readFileSync(join(dir, "pass.key"), "utf8"),
    intermediatePem: readFileSync(join(dir, "wwdr.pem"), "utf8"),
  };
}

describe.skipIf(!HAS_OPENSSL)("the local CMS signer", () => {
  let dir = "";
  let signer: LocalSigner;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hl-wallet-cms-"));
    signer = makePki(dir);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function verify(signature: Uint8Array, manifest: Uint8Array) {
    writeFileSync(join(dir, "signature"), signature);
    writeFileSync(join(dir, "manifest.json"), manifest);
    return openssl(dir, [
      "smime",
      "-verify",
      "-binary",
      "-inform",
      "DER",
      "-in",
      "signature",
      "-content",
      "manifest.json",
      "-purpose",
      "any",
      "-CAfile",
      "root.pem",
      "-certfile",
      "wwdr.pem",
      "-out",
      "/dev/null",
    ]);
  }

  it("signs a pass's manifest so that OpenSSL verifies it, and not a changed one", () => {
    const files = buildPassFiles(buildPassContent(SAMPLE_INPUT), NONCE);
    const manifest = passManifest(files);
    const signature = signManifestLocally(manifest, signer);
    const ok = verify(signature, manifest);
    expect(ok.status, ok.stderr).toBe(0);

    const tampered = new TextEncoder().encode(
      new TextDecoder()
        .decode(manifest)
        .replace(/"pass.json":"[0-9a-f]/, '"pass.json":"0'),
    );
    expect(Buffer.from(tampered).equals(Buffer.from(manifest))).toBe(false);
    expect(verify(signature, tampered).status).not.toBe(0);
  });

  it("verifies from inside a zipped pass", () => {
    const files = buildPassFiles(buildPassContent(SAMPLE_INPUT), NONCE);
    const manifest = passManifest(files);
    const pkpass = assemblePkpass(
      files,
      manifest,
      signManifestLocally(manifest, signer),
    );
    const unzipped = unzipSync(pkpass);
    const ok = verify(unzipped.signature, unzipped["manifest.json"]);
    expect(ok.status, ok.stderr).toBe(0);
  });

  it("carries both certificates, SHA-256 and the signing time", () => {
    const when = new Date("2026-11-24T08:30:00Z");
    const signature = signManifestLocally(
      new TextEncoder().encode("{}"),
      signer,
      when,
    );
    writeFileSync(join(dir, "sig.der"), signature);
    const printed = openssl(dir, [
      "cms",
      "-cmsout",
      "-print",
      "-inform",
      "DER",
      "-in",
      "sig.der",
    ]);
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stdout).toContain("sha256");
    expect(printed.stdout).toContain("Test Intermediate");
    expect(printed.stdout).toContain("Pass Type ID: test");
    expect(printed.stdout).toContain("UTCTIME:Nov 24 08:30:00 2026 GMT");
    expect(printed.stdout).toContain("eContent: <ABSENT>");
  });

  it("is the same bytes for the same manifest, key and time", () => {
    const when = new Date("2026-11-24T08:30:00Z");
    const manifest = new TextEncoder().encode('{"pass.json":"00"}');
    const a = signManifestLocally(manifest, signer, when);
    const b = signManifestLocally(manifest, signer, when);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("refuses a key that is not the certificate's", () => {
    const other = readFileSync(join(dir, "wwdr.key"), "utf8");
    expect(() =>
      signManifestLocally(new Uint8Array(), {
        ...signer,
        privateKeyPem: other,
      }),
    ).toThrow(/does not belong/);
  });
});
