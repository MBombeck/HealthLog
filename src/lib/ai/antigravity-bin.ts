/**
 * Dependency-leaf module for Antigravity child process environment and binary resolution.
 *
 * Keeps child environment construction and binary path resolution isolated
 * so neither antigravity-acp nor antigravity-install creates circular imports
 * with antigravity-client.
 */
import { join } from "node:path";
import { envValue } from "@/lib/env";
import { resolveAntigravityBinary as resolveFromConfig } from "./antigravity-install-core.mjs";

/** Environment variables passed to the child process. Everything else is dropped. */
export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;

/**
 * Build the minimal environment for an `agy` child process.
 *
 * HOME is overridden to the user's profile directory so that agy's file-based
 * token storage writes to the volume-mounted path instead of the container's
 * ephemeral $HOME. Without this, the OAuth token disappears on every container
 * recreate and the user must re-login.
 */
export function antigravityChildEnv(profileDir?: string): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Override $HOME so agy stores its token (and other home-relative files)
  // under the per-user profile directory, which is volume-mounted and persists
  // across container recreates. The XDG variables follow the same override so
  // nothing leaks into the container's default home directory.
  // When profileDir is not provided (e.g. for the CLI version probe in the
  // status route) the app's own HOME is used as-is.
  if (profileDir) {
    env.HOME = profileDir;
    env.XDG_DATA_HOME = join(profileDir, ".local", "share");
    env.XDG_CONFIG_HOME = join(profileDir, ".config");
    env.XDG_CACHE_HOME = join(profileDir, ".cache");
    env.XDG_STATE_HOME = join(profileDir, ".local", "state");
  }
  return env;
}

/**
 * The installed binary: `ANTIGRAVITY_BIN_PATH`, then the profile root's `bin`,
 * then the default volume path, then the system paths. Null when none runs.
 */
export function resolveAntigravityBinary(): string | null {
  return resolveFromConfig({
    binaryPath: envValue("ANTIGRAVITY_BIN_PATH") ?? undefined,
    profileRoot: envValue("ANTIGRAVITY_PROFILE_ROOT") ?? undefined,
  });
}
