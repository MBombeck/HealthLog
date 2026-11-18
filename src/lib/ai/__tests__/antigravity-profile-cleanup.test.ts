import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAntigravityProfiles } from "../antigravity-profile-cleanup";

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
});
