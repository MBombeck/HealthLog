import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  antigravityBinaryPath,
  installAgy,
  compareSemver,
} from "../antigravity-install-core.mjs";

describe("Antigravity Updater Success and Integrity", () => {
  let root: string;
  let binDir: string;
  let targetBinary: string;
  let fixtureDir: string;
  let validArchive: Buffer;
  let validSha256: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "healthlog-agy-updater-"));
    binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    targetBinary = antigravityBinaryPath(root);

    fixtureDir = mkdtempSync(join(tmpdir(), "healthlog-agy-fixture-"));
    const scriptPath = join(fixtureDir, "antigravity");
    writeFileSync(scriptPath, "#!/bin/sh\necho 'agy version 1.5.11'\n");
    chmodSync(scriptPath, 0o755);

    const archivePath = join(fixtureDir, "agy_cli_linux_x64.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", fixtureDir, "antigravity"]);
    validArchive = readFileSync(archivePath);
    validSha256 = createHash("sha256").update(validArchive).digest("hex");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("updates existing binary atomically after verifying release SHA-256 digest", async () => {
    // Seed existing 1.5.8 binary
    writeFileSync(targetBinary, "#!/bin/sh\necho 'agy version 1.5.8'\n");
    chmodSync(targetBinary, 0o755);

    const initialContent = readFileSync(targetBinary, "utf8");
    expect(initialContent).toContain("1.5.8");

    const release = {
      version: "1.5.11",
      downloadUrl:
        "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
      sha256: validSha256,
    };

    let downloadCalls = 0;
    const download = async (url: string) => {
      downloadCalls += 1;
      expect(url).toBe(release.downloadUrl);
      return new Response(Uint8Array.from(validArchive), { status: 200 });
    };

    const result = await installAgy({
      profileRoot: root,
      force: true,
      release,
      download,
    });

    expect(downloadCalls).toBe(1);
    expect(result.version).toBe("1.5.11");
    expect(result.binaryPath).toBe(targetBinary);
    expect(result.alreadyInstalled).toBe(false);

    // Verify binary was updated
    const updatedContent = readFileSync(targetBinary, "utf8");
    expect(updatedContent).toContain("1.5.11");
  });

  it("retains the old binary intact when download fails", async () => {
    writeFileSync(targetBinary, "#!/bin/sh\necho 'agy version 1.5.8'\n");
    chmodSync(targetBinary, 0o755);

    const release = {
      version: "1.5.11",
      downloadUrl:
        "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy.tar.gz",
      sha256: validSha256,
    };

    const download = async () =>
      new Response("Network timeout", {
        status: 504,
        statusText: "Gateway Timeout",
      });

    await expect(
      installAgy({
        profileRoot: root,
        force: true,
        release,
        download,
      }),
    ).rejects.toThrow(/Failed to download Antigravity CLI/);

    // Old binary must remain untouched
    const currentContent = readFileSync(targetBinary, "utf8");
    expect(currentContent).toContain("1.5.8");
  });

  it("retains the old binary intact when release SHA-256 digest mismatches", async () => {
    writeFileSync(targetBinary, "#!/bin/sh\necho 'agy version 1.5.8'\n");
    chmodSync(targetBinary, 0o755);

    const wrongSha256 =
      "0000000000000000000000000000000000000000000000000000000000000000";

    const release = {
      version: "1.5.11",
      downloadUrl:
        "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy.tar.gz",
      sha256: wrongSha256,
    };

    const download = async () =>
      new Response(Uint8Array.from(validArchive), { status: 200 });

    await expect(
      installAgy({
        profileRoot: root,
        force: true,
        release,
        download,
      }),
    ).rejects.toThrow(/SHA256 checksum mismatch/);

    // Old binary must remain completely untouched
    const currentContent = readFileSync(targetBinary, "utf8");
    expect(currentContent).toContain("1.5.8");
  });

  it("retains the old binary intact when downloaded binary --version does not match expected release version", async () => {
    writeFileSync(targetBinary, "#!/bin/sh\necho 'agy version 1.5.8'\n");
    chmodSync(targetBinary, 0o755);

    // Create fixture archive where extracted binary outputs 1.5.10 instead of 1.5.11
    const mismatchFixtureDir = mkdtempSync(
      join(tmpdir(), "healthlog-agy-mismatch-"),
    );
    try {
      const scriptPath = join(mismatchFixtureDir, "antigravity");
      writeFileSync(scriptPath, "#!/bin/sh\necho 'agy version 1.5.10'\n");
      chmodSync(scriptPath, 0o755);

      const archivePath = join(mismatchFixtureDir, "agy_cli_linux_x64.tar.gz");
      execFileSync("tar", [
        "-czf",
        archivePath,
        "-C",
        mismatchFixtureDir,
        "antigravity",
      ]);
      const archiveBytes = readFileSync(archivePath);
      const archiveSha256 = createHash("sha256")
        .update(archiveBytes)
        .digest("hex");

      const release = {
        version: "1.5.11",
        downloadUrl:
          "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
        sha256: archiveSha256,
      };

      const download = async () => new Response(archiveBytes, { status: 200 });

      await expect(
        installAgy({
          profileRoot: root,
          force: true,
          release,
          download,
        }),
      ).rejects.toThrow(/version mismatch/i);

      // Old binary must remain completely untouched
      const currentContent = readFileSync(targetBinary, "utf8");
      expect(currentContent).toContain("1.5.8");
    } finally {
      rmSync(mismatchFixtureDir, { recursive: true, force: true });
    }
  });

  it("retains the old binary intact when downloaded archive is corrupt", async () => {
    writeFileSync(targetBinary, "#!/bin/sh\necho 'agy version 1.5.8'\n");
    chmodSync(targetBinary, 0o755);

    const corruptBuffer = Buffer.from(
      "corrupt archive bytes not in tar format",
    );
    const corruptSha256 = createHash("sha256")
      .update(corruptBuffer)
      .digest("hex");

    const release = {
      version: "1.5.11",
      downloadUrl:
        "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy.tar.gz",
      sha256: corruptSha256,
    };

    const download = async () => new Response(corruptBuffer, { status: 200 });

    await expect(
      installAgy({
        profileRoot: root,
        force: true,
        release,
        download,
      }),
    ).rejects.toThrow();

    // Old binary must remain completely untouched
    const currentContent = readFileSync(targetBinary, "utf8");
    expect(currentContent).toContain("1.5.8");
  });

  describe("Semver comparison behavior", () => {
    it("correctly identifies equal, newer, and older versions", () => {
      expect(compareSemver("1.5.10", "1.5.11")).toBe(-1); // older -> update available
      expect(compareSemver("1.5.11", "1.5.11")).toBe(0); // equal -> already up to date
      expect(compareSemver("1.6.0", "1.5.11")).toBe(1); // newer -> cannot downgrade
      expect(compareSemver("v1.5.11", "1.5.11")).toBe(0);
      expect(compareSemver("1.5.11", "v1.5.10")).toBe(1);
    });
  });
});
