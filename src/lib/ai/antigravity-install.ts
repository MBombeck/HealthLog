/**
 * Antigravity CLI installer for the app. The logic lives in
 * `antigravity-install-core.mjs`, which the app/admin install route uses.
 * This file adds the app's configuration and the `safeFetch` downloader.
 */
import { envValue } from "@/lib/env";
import { safeFetch } from "@/lib/safe-fetch";
import { antigravityChildEnv } from "./antigravity-client";
import {
  AGY_PINNED_VERSION,
  compareSemver,
  installAgy,
  isManagedAntigravityBinary,
  resolveAntigravityBinary as resolveFromConfig,
} from "./antigravity-install-core.mjs";
import {
  type AntigravityReleaseInfo,
  getLatestAntigravityRelease,
} from "./antigravity-release";

export {
  AGY_PINNED_VERSION,
  compareSemver,
  type AntigravityReleaseInfo,
  getLatestAntigravityRelease,
};

/** A release archive is tens of megabytes. Five minutes covers a slow link. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface InstallAntigravityResult {
  version?: string;
  binaryPath: string;
  alreadyInstalled: boolean;
}

export interface InstallAntigravityOptions {
  force?: boolean;
  release?: AntigravityReleaseInfo;
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

/**
 * Returns true if the currently active Antigravity CLI binary is managed by
 * HealthLog in the profile directory rather than externally managed.
 */
export function isAntigravityBinaryManaged(): boolean {
  return isManagedAntigravityBinary({
    binaryPath: envValue("ANTIGRAVITY_BIN_PATH") ?? undefined,
    profileRoot: envValue("ANTIGRAVITY_PROFILE_ROOT") ?? undefined,
  });
}

/**
 * Download and install the pinned or specified release CLI. Callers must already have
 * checked that the caller is an admin: the install changes the binary every user
 * on this server runs.
 */
export function installAntigravityCli(
  options?: InstallAntigravityOptions,
): Promise<InstallAntigravityResult> {
  return installAgy({
    binaryPath: envValue("ANTIGRAVITY_BIN_PATH") ?? undefined,
    profileRoot: envValue("ANTIGRAVITY_PROFILE_ROOT") ?? undefined,
    force: options?.force === true,
    release: options?.release,
    childEnv: antigravityChildEnv(),
    download: (url: string) =>
      safeFetch(
        url,
        {},
        {
          followRedirects: true,
          requirePublicHost: true,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
        },
      ),
  });
}
