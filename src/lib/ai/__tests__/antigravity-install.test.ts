import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installAntigravityCli,
  resolveAntigravityBinary,
} from "../antigravity-install";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("antigravity-install", () => {
  const originalEnv = { ...process.env };
  let testDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    testDir = mkdtempSync(join(tmpdir(), "healthlog-agy-install-test-"));
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("resolveAntigravityBinary", () => {
    it("returns ANTIGRAVITY_BIN_PATH if it is an executable file", () => {
      const customBin = join(testDir, "custom-agy");
      writeFileSync(customBin, "#!/bin/sh\necho '1.5.8'\n");
      chmodSync(customBin, 0o755);

      process.env.ANTIGRAVITY_BIN_PATH = customBin;
      const resolved = resolveAntigravityBinary();
      expect(resolved).toBe(customBin);
    });

    it("returns profile root bin path if present and executable", () => {
      delete process.env.ANTIGRAVITY_BIN_PATH;
      process.env.ANTIGRAVITY_PROFILE_ROOT = testDir;

      const binDir = join(testDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const targetAgy = join(binDir, "agy");
      writeFileSync(targetAgy, "#!/bin/sh\necho '1.5.8'\n");
      chmodSync(targetAgy, 0o755);

      const resolved = resolveAntigravityBinary();
      expect(resolved).toBe(targetAgy);
    });

    it("returns null when no executable binary exists", () => {
      delete process.env.ANTIGRAVITY_BIN_PATH;
      process.env.ANTIGRAVITY_PROFILE_ROOT = testDir; // empty dir, no bin/agy

      const resolved = resolveAntigravityBinary();
      // It won't find anything in testDir/bin/agy, /var/lib/healthlog/..., or /usr/local/bin unless host has it
      // If host has /usr/local/bin/agy, it returns that or null
      if (resolved !== null) {
        expect(resolved).toMatch(/\/usr\/(local\/)?bin\/agy/);
      } else {
        expect(resolved).toBeNull();
      }
    });

    it("returns null when ANTIGRAVITY_BIN_PATH is not executable, without falling back", () => {
      process.env.ANTIGRAVITY_BIN_PATH = join(testDir, "nonexistent-agy");
      const resolved = resolveAntigravityBinary();
      expect(resolved).toBeNull();
    });
  });

  describe("installAntigravityCli", () => {
    it("returns existing installation if already present and not forced", async () => {
      delete process.env.ANTIGRAVITY_BIN_PATH;
      process.env.ANTIGRAVITY_PROFILE_ROOT = testDir;

      const binDir = join(testDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const targetAgy = join(binDir, "agy");
      writeFileSync(targetAgy, "#!/bin/sh\necho 'agy version 1.5.8'\n");
      chmodSync(targetAgy, 0o755);

      const result = await installAntigravityCli();
      expect(result.alreadyInstalled).toBe(true);
      expect(result.version).toBe("1.5.8");
      expect(result.binaryPath).toBe(targetAgy);
    });

    it("rejects when binaryPath override is configured", async () => {
      process.env.ANTIGRAVITY_BIN_PATH = join(testDir, "custom-agy");
      await expect(installAntigravityCli()).rejects.toThrow(
        "Antigravity CLI is externally managed via binaryPath override and cannot be installed or modified by HealthLog",
      );
    });

    it("rejects when process architecture is unsupported", async () => {
      const origArch = process.arch;
      Object.defineProperty(process, "arch", {
        value: "s390x",
        configurable: true,
      });

      try {
        await expect(installAntigravityCli({ force: true })).rejects.toThrow(
          "Unsupported architecture for Antigravity CLI: s390x",
        );
      } finally {
        Object.defineProperty(process, "arch", {
          value: origArch,
          configurable: true,
        });
      }
    });
  });
});
