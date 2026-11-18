import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypoint = join(repoRoot, "docker-entrypoint.sh");
const key = "a".repeat(64);
let fakeBin: string;

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "healthlog-entrypoint-"));
  const fakeNode = join(fakeBin, "node");
  writeFileSync(
    fakeNode,
    `#!/bin/sh
case "$1" in
  -e)
    case "$2" in
      *ENCRYPTION_KEYS*) exec "$REAL_NODE" "$@" ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(fakeNode, 0o755);
});

afterAll(() => {
  rmSync(fakeBin, { recursive: true, force: true });
});

function runEntrypoint(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    REAL_NODE: process.execPath,
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://healthlog:test@db:5432/healthlog",
    API_TOKEN_HMAC_KEY: "test-hmac-key",
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync("sh", [entrypoint, "true"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

describe("docker entrypoint crypto configuration", () => {
  it("accepts the legacy ENCRYPTION_KEY configuration", () => {
    const result = runEntrypoint({
      ENCRYPTION_KEY: key,
      ENCRYPTION_KEYS: undefined,
      ENCRYPTION_ACTIVE_KEY_ID: undefined,
    });

    expect(result.status, result.stderr).toBe(0);
  }, 20_000);

  it("accepts a keyring-only configuration", () => {
    const result = runEntrypoint({
      ENCRYPTION_KEY: undefined,
      ENCRYPTION_KEYS: JSON.stringify({ v2: key }),
      ENCRYPTION_ACTIVE_KEY_ID: undefined,
    });

    expect(result.status, result.stderr).toBe(0);
  }, 20_000);

  it("fails closed when ENCRYPTION_KEYS is invalid even if a legacy key exists", () => {
    const result = runEntrypoint({
      ENCRYPTION_KEY: key,
      ENCRYPTION_KEYS: JSON.stringify({ v2: "not-a-32-byte-key" }),
      ENCRYPTION_ACTIVE_KEY_ID: "v2",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENCRYPTION_KEYS");
    expect(result.stderr).toContain("invalid");
  });

  it("fails closed when the active key is absent from the keyring", () => {
    const result = runEntrypoint({
      ENCRYPTION_KEY: undefined,
      ENCRYPTION_KEYS: JSON.stringify({ v2: key }),
      ENCRYPTION_ACTIVE_KEY_ID: "v3",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENCRYPTION_ACTIVE_KEY_ID");
  });
});

describe("docker entrypoint startup installation", () => {
  it("does not auto-install Antigravity CLI and warns that ANTIGRAVITY_AUTO_INSTALL is ignored", () => {
    const result = runEntrypoint({
      ENCRYPTION_KEY: key,
      ANTIGRAVITY_AUTO_INSTALL: "true",
      ANTIGRAVITY_AUTO_DOWNLOAD: "true",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ANTIGRAVITY_AUTO_INSTALL is deprecated and ignored");
    expect(result.stdout).not.toContain("install-agy");
    expect(result.stderr).not.toContain("install-agy");
  });

  it("never executes install-agy or attempts binary download on startup", () => {
    const source = readFileSync(entrypoint, "utf8");
    expect(source).not.toContain("install-agy");
    expect(source).not.toContain("scripts/install-agy.mjs");
  });
});
