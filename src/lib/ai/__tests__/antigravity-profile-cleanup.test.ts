import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeAntigravityProfile,
  removeAntigravityProfiles,
} from "../antigravity-profile-cleanup";

const PROFILE = "0123456789abcdef0123456789abcdef";

describe("removeAntigravityProfiles", () => {
  const originalRoot = process.env.ANTIGRAVITY_PROFILE_ROOT;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "healthlog-agy-profiles-"));
    process.env.ANTIGRAVITY_PROFILE_ROOT = root;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ANTIGRAVITY_PROFILE_ROOT;
    else process.env.ANTIGRAVITY_PROFILE_ROOT = originalRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("removes the folder of a generated profile id, with the login inside it", async () => {
    const dir = join(root, PROFILE, ".config", "antigravity");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin-secrets.json"), "{}");

    const removed = await removeAntigravityProfiles([PROFILE]);

    expect(removed).toBe(1);
    expect(existsSync(join(root, PROFILE))).toBe(false);
  });

  it("never deletes outside the root for an id that is not in the generated form", async () => {
    const name = `agy-outside-${process.pid}`;
    const outside = join(root, "..", name);
    mkdirSync(outside, { recursive: true });
    try {
      const removed = await removeAntigravityProfiles([
        `../${name}`,
        "../../etc",
        null,
        undefined,
      ]);
      expect(removed).toBe(0);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does nothing when the profile root is not an absolute path", async () => {
    process.env.ANTIGRAVITY_PROFILE_ROOT = "relative/root";
    expect(await removeAntigravityProfiles([PROFILE])).toBe(0);
  });

  it("logs warning when profile root is unset or relative and valid IDs were passed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.ANTIGRAVITY_PROFILE_ROOT;
    const removed1 = await removeAntigravityProfiles([PROFILE]);
    expect(removed1).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Antigravity profile root is unset or not absolute",
      ),
    );

    warnSpy.mockClear();
    process.env.ANTIGRAVITY_PROFILE_ROOT = "relative/path";
    const removed2 = await removeAntigravityProfiles([PROFILE]);
    expect(removed2).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Antigravity profile root is unset or not absolute",
      ),
    );

    warnSpy.mockRestore();
  });

  it("removeAntigravityProfile returns false when profile root is unset or relative, retaining pointer", async () => {
    delete process.env.ANTIGRAVITY_PROFILE_ROOT;
    expect(await removeAntigravityProfile(PROFILE)).toBe(false);

    process.env.ANTIGRAVITY_PROFILE_ROOT = "relative/path";
    expect(await removeAntigravityProfile(PROFILE)).toBe(false);

    // Missing/empty profile ID returns true (no-op)
    expect(await removeAntigravityProfile(null)).toBe(true);
    expect(await removeAntigravityProfile(undefined)).toBe(true);
  });
});
