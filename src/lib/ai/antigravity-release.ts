/**
 * Official GitHub release discovery and validation for Antigravity CLI.
 *
 * Discovers the latest stable release from the official repository:
 * https://github.com/google-antigravity/antigravity-cli
 * via API endpoint:
 * https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest
 */
import { safeFetch } from "@/lib/safe-fetch";

export const AGY_GITHUB_REPO = "google-antigravity/antigravity-cli";
export const AGY_LATEST_RELEASE_URL = `https://api.github.com/repos/${AGY_GITHUB_REPO}/releases/latest`;

/** Bounded in-memory TTL for latest release status discovery and failure cache (5 minutes). */
export const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Default request timeout for GitHub release lookups (5 seconds). */
export const RELEASE_REQUEST_TIMEOUT_MS = 5_000;

export interface AntigravityReleaseInfo {
  version: string;
  tagName: string;
  assetName: string;
  downloadUrl: string;
  sha256: string;
  publishedAt?: string;
}

export type AntigravityReleaseErrorCode =
  | "invalid_release"
  | "prerelease_not_allowed"
  | "unsupported_platform"
  | "asset_not_found"
  | "invalid_asset"
  | "missing_digest"
  | "rate_limited"
  | "network_error"
  | "not_found";

export class AntigravityReleaseError extends Error {
  readonly code: AntigravityReleaseErrorCode;
  readonly cause?: unknown;

  constructor(
    message: string,
    code: AntigravityReleaseErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "AntigravityReleaseError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Parses a SHA-256 digest string, accepting both "sha256:<64 hex>" and "<64 hex>".
 * Returns 64 lowercase hex characters or null if invalid.
 */
export function parseSha256Digest(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/^(?:sha256:)?([a-fA-F0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validates and extracts semver version from a release tag (e.g. "v1.5.11" -> "1.5.11").
 */
export function parseSemverTag(tagName: unknown): string | null {
  if (typeof tagName !== "string") return null;
  const match = tagName
    .trim()
    .match(/^v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/);
  return match ? match[1] : null;
}

/**
 * Strict parser for official GitHub release JSON payload.
 *
 * Validates:
 * - Response object structure
 * - Release is not draft or prerelease
 * - Valid semver tag
 * - Contains release asset for this platform (Linux x64/arm64: `agy_cli_linux_${arch}.tar.gz`)
 * - Valid HTTPS download URL
 * - Valid SHA-256 digest on the asset (`digest: sha256:...`)
 */
export function parseAntigravityRelease(
  payload: unknown,
  options?: { platform?: string; arch?: string },
): AntigravityReleaseInfo {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AntigravityReleaseError(
      "Invalid GitHub release payload: expected an object",
      "invalid_release",
    );
  }

  const release = payload as Record<string, unknown>;

  if (release.draft === true) {
    throw new AntigravityReleaseError(
      "GitHub release is marked as draft",
      "invalid_release",
    );
  }

  if (release.prerelease === true) {
    throw new AntigravityReleaseError(
      "GitHub release is marked as prerelease",
      "prerelease_not_allowed",
    );
  }

  const version = parseSemverTag(release.tag_name);
  if (!version) {
    throw new AntigravityReleaseError(
      `GitHub release tag "${String(release.tag_name)}" is not a valid semver version`,
      "invalid_release",
    );
  }

  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;

  if (platform !== "linux") {
    throw new AntigravityReleaseError(
      `Unsupported platform for Antigravity CLI: ${platform}. Only linux is supported.`,
      "unsupported_platform",
    );
  }

  let assetArch: string;
  if (arch === "x64") {
    assetArch = "x64";
  } else if (arch === "arm64") {
    assetArch = "arm64";
  } else {
    throw new AntigravityReleaseError(
      `Unsupported architecture for Antigravity CLI: ${arch}. Supported: x64, arm64.`,
      "unsupported_platform",
    );
  }

  const expectedAssetName = `agy_cli_linux_${assetArch}.tar.gz`;

  if (!Array.isArray(release.assets)) {
    throw new AntigravityReleaseError(
      "GitHub release payload is missing assets array",
      "invalid_release",
    );
  }

  const asset = release.assets.find(
    (a: unknown): a is Record<string, unknown> =>
      Boolean(
        a &&
          typeof a === "object" &&
          (a as Record<string, unknown>).name === expectedAssetName,
      ),
  );

  if (!asset) {
    throw new AntigravityReleaseError(
      `Release ${version} does not contain asset "${expectedAssetName}" for ${platform}/${arch}`,
      "asset_not_found",
    );
  }

  const downloadUrl = asset.browser_download_url;
  const expectedDownloadUrl = `https://github.com/${AGY_GITHUB_REPO}/releases/download/${String(release.tag_name)}/${expectedAssetName}`;

  if (
    typeof downloadUrl !== "string" ||
    downloadUrl !== expectedDownloadUrl
  ) {
    throw new AntigravityReleaseError(
      `Release asset "${expectedAssetName}" download URL does not match official GitHub release URL: expected "${expectedDownloadUrl}", got "${String(downloadUrl)}"`,
      "invalid_asset",
    );
  }

  const sha256 = parseSha256Digest(asset.digest);
  if (!sha256) {
    throw new AntigravityReleaseError(
      `Release asset "${expectedAssetName}" is missing a valid SHA-256 digest in asset metadata`,
      "missing_digest",
    );
  }

  return {
    version,
    tagName: String(release.tag_name),
    assetName: expectedAssetName,
    downloadUrl,
    sha256,
    publishedAt:
      typeof release.published_at === "string"
        ? release.published_at
        : undefined,
  };
}

let cachedRelease: { release: AntigravityReleaseInfo; expiresAt: number } | null =
  null;
let cachedError: { error: AntigravityReleaseError; expiresAt: number } | null =
  null;
let inFlightFetch: Promise<AntigravityReleaseInfo> | null = null;

export function clearAntigravityReleaseCache(): void {
  cachedRelease = null;
  cachedError = null;
  inFlightFetch = null;
}

export interface GetReleaseOptions {
  forceFresh?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof safeFetch;
  now?: () => number;
  platform?: string;
  arch?: string;
}

/**
 * Discovers the latest stable release from official GitHub releases API.
 * Uses safeFetch and in-memory bounded TTL cache to prevent status polling
 * from causing repeated GitHub requests. Caches failures for the same bounded
 * interval to avoid hammering or rate-limiting GitHub.
 */
export async function getLatestAntigravityRelease(
  options?: GetReleaseOptions,
): Promise<AntigravityReleaseInfo> {
  const getNow = options?.now ?? Date.now;
  const now = getNow();
  const ttl = options?.ttlMs ?? RELEASE_CACHE_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? RELEASE_REQUEST_TIMEOUT_MS;

  if (options?.forceFresh) {
    cachedRelease = null;
    cachedError = null;
  } else {
    if (cachedRelease && cachedRelease.expiresAt > now) {
      return cachedRelease.release;
    }

    if (cachedError && cachedError.expiresAt > now) {
      throw cachedError.error;
    }

    if (inFlightFetch) {
      return inFlightFetch;
    }
  }

  const fetcher = options?.fetchFn ?? safeFetch;

  const promise = (async () => {
    try {
      let res: Response;
      try {
        res = await fetcher(
          AGY_LATEST_RELEASE_URL,
          {
            headers: {
              "User-Agent": "HealthLog",
              Accept: "application/vnd.github+json",
            },
          },
          {
            requirePublicHost: true,
            followRedirects: true,
            timeoutMs,
          },
        );
      } catch (err) {
        throw new AntigravityReleaseError(
          "Failed to reach GitHub releases API",
          "network_error",
          err,
        );
      }

      if (res.status === 403 || res.status === 429) {
        try {
          await res.text();
        } catch {}
        throw new AntigravityReleaseError(
          "GitHub releases API rate limit exceeded",
          "rate_limited",
        );
      }

      if (res.status === 404) {
        try {
          await res.text();
        } catch {}
        throw new AntigravityReleaseError(
          "No Antigravity CLI release found on GitHub",
          "not_found",
        );
      }

      if (!res.ok) {
        try {
          await res.text();
        } catch {}
        throw new AntigravityReleaseError(
          `GitHub releases API returned error status ${res.status}`,
          "network_error",
        );
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new AntigravityReleaseError(
          "Invalid JSON response received from GitHub releases API",
          "invalid_release",
        );
      }

      const release = parseAntigravityRelease(payload, {
        platform: options?.platform,
        arch: options?.arch,
      });

      cachedRelease = {
        release,
        expiresAt: getNow() + ttl,
      };
      cachedError = null;

      return release;
    } catch (err) {
      const releaseError =
        err instanceof AntigravityReleaseError
          ? err
          : new AntigravityReleaseError(
              "Failed to reach GitHub releases API",
              "network_error",
              err,
            );
      cachedError = {
        error: releaseError,
        expiresAt: getNow() + ttl,
      };
      cachedRelease = null;
      throw releaseError;
    }
  })().finally(() => {
    inFlightFetch = null;
  });

  inFlightFetch = promise;
  return promise;
}
