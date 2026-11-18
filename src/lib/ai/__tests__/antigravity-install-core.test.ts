import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravityBinaryPath,
  installAgy,
  isManagedAntigravityBinary,
  AGY_PINNED_VERSION,
} from "../antigravity-install-core.mjs";

describe("antigravity-install-core", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "healthlog-agy-core-"));
    mkdirSync(join(root, "bin"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("isManagedAntigravityBinary root configuration", () => {
    it("marks binary managed when present in explicitly configured profileRoot", () => {
      const binaryPath = join(root, "bin", "agy");
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binaryPath, 0o755);

      expect(isManagedAntigravityBinary({ profileRoot: root })).toBe(true);
      expect(
        isManagedAntigravityBinary({ binaryPath, profileRoot: root }),
      ).toBe(true);
    });

    it("does not mark binary managed if it belongs to a different root than the configured profileRoot", () => {
      const binaryPath = join(root, "bin", "agy");
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binaryPath, 0o755);

      const otherRoot = mkdtempSync(join(tmpdir(), "healthlog-agy-other-"));
      mkdirSync(join(otherRoot, "bin"), { recursive: true });
      try {
        // profileRoot is configured to otherRoot (which has no binary)
        // binaryPath points to root/bin/agy
        expect(
          isManagedAntigravityBinary({
            binaryPath,
            profileRoot: otherRoot,
          }),
        ).toBe(false);

        // When binaryPath is not passed, resolveAntigravityBinary may find binary in default or other paths,
        // but it must NOT qualify as managed under otherRoot.
        expect(
          isManagedAntigravityBinary({
            profileRoot: otherRoot,
          }),
        ).toBe(false);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    it("refuses symlinks at the managed location", () => {
      const realBin = join(tmpdir(), `real-agy-${Date.now()}`);
      writeFileSync(realBin, "#!/bin/sh\nexit 0\n");
      chmodSync(realBin, 0o755);

      const linkPath = join(root, "bin", "agy");
      symlinkSync(realBin, linkPath);

      try {
        expect(isManagedAntigravityBinary({ profileRoot: root })).toBe(false);
      } finally {
        rmSync(realBin, { force: true });
      }
    });
  });

  it("refuses an archive whose checksum does not match and leaves no binary behind", async () => {
    let calls = 0;
    let requestedUrl = "";
    const download = async (url: string) => {
      calls += 1;
      requestedUrl = url;
      return new Response(Buffer.from("not the pinned release archive"), {
        status: 200,
      });
    };

    await expect(installAgy({ profileRoot: root, download })).rejects.toThrow(
      /SHA256 checksum mismatch/,
    );

    expect(calls).toBe(1);
    expect(requestedUrl).toMatch(
      new RegExp(
        `/releases/download/v${AGY_PINNED_VERSION}/agy_cli_linux_(x64|arm64)\\.tar\\.gz$`,
      ),
    );
    expect(existsSync(antigravityBinaryPath(root))).toBe(false);
    // The partial archive and the staging folder are removed too.
    expect(readdirSync(join(root, "bin"))).toEqual([]);
  });

  it("reports a failed download without writing anything", async () => {
    const download = async () =>
      new Response("gone", { status: 404, statusText: "Not Found" });

    await expect(installAgy({ profileRoot: root, download })).rejects.toThrow(
      /Failed to download Antigravity CLI: 404/,
    );
    expect(readdirSync(join(root, "bin"))).toEqual([]);
  });

  it("shares one running install between concurrent callers requesting the same version", async () => {
    let calls = 0;
    const download = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("not the archive", { status: 200 });
    };

    const results = await Promise.allSettled([
      installAgy({ profileRoot: root, download }),
      installAgy({ profileRoot: root, download }),
    ]);

    expect(calls).toBe(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("does not allow concurrent update to falsely reuse an in-flight base install", async () => {
    const downloadCalls: string[] = [];
    const download = async (url: string) => {
      downloadCalls.push(url);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response("not the archive", { status: 200 });
    };

    const mockRelease = {
      version: "1.5.11",
      downloadUrl:
        "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
      sha256:
        "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    };

    // Caller 1 starts base install
    const p1 = installAgy({ profileRoot: root, download });
    // Caller 2 starts update to 1.5.11 concurrently
    const p2 = installAgy({
      profileRoot: root,
      download,
      force: true,
      release: mockRelease,
    });

    const [r1, r2] = await Promise.allSettled([p1, p2]);

    // Both should fail on archive verification in this mock, but both must have run separately
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    expect(downloadCalls.length).toBe(2);
    expect(downloadCalls[0]).toContain(AGY_PINNED_VERSION);
    expect(downloadCalls[1]).toContain("v1.5.11");
  });

  it("rejects an archive where extracted binary is a symlink", async () => {
    const { execSync } = await import("node:child_process");
    const { symlinkSync, readFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");

    const tarDir = mkdtempSync(join(tmpdir(), "tar-build-"));
    const dummyTarget = join(tarDir, "dummy-target");
    writeFileSync(dummyTarget, "#!/bin/sh\nexit 0\n");
    const linkFile = join(tarDir, "antigravity");
    symlinkSync(dummyTarget, linkFile);

    const archivePath = join(tarDir, "test.tar.gz");
    execSync(`tar -czf "${archivePath}" -C "${tarDir}" antigravity`);
    const archiveBytes = readFileSync(archivePath);
    const sha256 = createHash("sha256").update(archiveBytes).digest("hex");

    const release = {
      version: "9.9.9",
      downloadUrl: "https://example.com/fake.tar.gz",
      sha256,
    };

    const download = async () => new Response(archiveBytes, { status: 200 });

    try {
      await expect(
        installAgy({ profileRoot: root, download, release }),
      ).rejects.toThrow("Extracted antigravity binary must be a regular file");
      expect(existsSync(antigravityBinaryPath(root))).toBe(false);
    } finally {
      rmSync(tarDir, { recursive: true, force: true });
    }
  });

  it("enforces build-pinned hash when release version matches AGY_PINNED_VERSION", async () => {
    const release = {
      version: AGY_PINNED_VERSION,
      downloadUrl: "https://example.com/fake.tar.gz",
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const download = async () => new Response("archive-bytes", { status: 200 });
    await expect(
      installAgy({ profileRoot: root, download, release }),
    ).rejects.toThrow(/SHA256 checksum mismatch/);
  });

  it("rejects invalid sha256 digest format", async () => {
    const release = {
      version: "9.9.9",
      downloadUrl: "https://example.com/fake.tar.gz",
      sha256: "invalid-hash",
    };
    const download = async () => new Response("archive-bytes", { status: 200 });
    await expect(
      installAgy({ profileRoot: root, download, release }),
    ).rejects.toThrow(/Invalid sha256 digest format/);
  });

  it("rejects release with non-HTTPS downloadUrl", async () => {
    const release = {
      version: "1.5.11",
      downloadUrl:
        "http://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy.tar.gz",
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const download = async () => new Response("archive-bytes", { status: 200 });
    await expect(
      installAgy({ profileRoot: root, download, release }),
    ).rejects.toThrow(/must use HTTPS protocol/);
  });
});
