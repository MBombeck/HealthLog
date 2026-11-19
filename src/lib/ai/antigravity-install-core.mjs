/**
 * Installer and binary resolver for the Antigravity CLI (`agy`). The one copy
 * of this logic, used by the app (`antigravity-install.ts`, admin-only route),
 * which passes a `safeFetch` downloader.
 *
 * Plain ESM with no imports beyond Node, for the same reason as
 * `src/lib/auth/argon2-params.mjs`: the production image has no `tsx`.
 *
 * The downloader is injected rather than called here, so every outbound
 * request is made by the caller, with the policy it needs (the app passes
 * `safeFetch`).
 */
import {
  accessSync,
  chmodSync,
  constants,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

/**
 * Run a binary and resolve with its output. `execFile` is looked up on each
 * call, not at import, so importing this module never touches child_process.
 */
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export const AGY_PINNED_VERSION = "1.5.12";
export const AGY_SHA256_AMD64 =
  "0f0cb851cdc9fbedd50432570aa6ae9c4c398b9ea3f1e23e7776f707643c5b3e";
export const AGY_SHA256_ARM64 =
  "594046de1b91561f7fe16476365e3843038ecca56f5f59af45cf9d3091e43bd4";

/** Where the image keeps the profiles and the binary when no root is set. */
export const DEFAULT_PROFILE_ROOT = "/var/lib/healthlog/antigravity";

/**
 * Upper bound on the downloaded archive. The release is far smaller; the cap
 * keeps a bad or hostile response from filling the disk.
 */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Timeout for the `--version` probe of a binary. */
export const VERSION_TIMEOUT_MS = 10_000;

function isExecutableFile(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Binary path inside a profile root: `<root>/bin/agy`. */
export function antigravityBinaryPath(profileRoot = DEFAULT_PROFILE_ROOT) {
  return join(profileRoot, "bin", "agy");
}

/**
 * The installed binary, or null. Order: the explicit `binaryPath` override,
 * then `<profileRoot>/bin/agy`, then the default volume path, then the
 * standard system locations.
 */
export function resolveAntigravityBinary({ binaryPath, profileRoot } = {}) {
  if (binaryPath) return isExecutableFile(binaryPath) ? binaryPath : null;
  if (profileRoot) {
    const candidate = antigravityBinaryPath(profileRoot);
    if (isExecutableFile(candidate)) return candidate;
  }
  const defaultCandidate = antigravityBinaryPath(DEFAULT_PROFILE_ROOT);
  if (isExecutableFile(defaultCandidate)) return defaultCandidate;
  for (const p of ["/usr/local/bin/agy", "/usr/bin/agy"]) {
    if (isExecutableFile(p)) return p;
  }
  return null;
}

function stripV(s) {
  return String(s).replace(/^v/i, "").trim();
}

/**
 * Compare two semver strings (e.g. "1.5.8" and "1.5.10").
 * Returns -1 if a < b, 1 if a > b, 0 if equal.
 */
export function compareSemver(a, b) {
  const partsA = stripV(a)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10));
  const partsB = stripV(b)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const ai = partsA[i] ?? 0;
    const bi = partsB[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) {
      const sA = stripV(a);
      const sB = stripV(b);
      return sA < sB ? -1 : sA > sB ? 1 : 0;
    }
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel);
}

function isSafeManagedBinary(candidateBinary, root) {
  if (!candidateBinary || !root) return false;
  try {
    const expectedBinary = resolve(antigravityBinaryPath(root));
    if (resolve(candidateBinary) !== expectedBinary) {
      return false;
    }
    const binDir = join(root, "bin");

    const dirStat = lstatSync(binDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      return false;
    }

    const binStat = lstatSync(candidateBinary);
    if (binStat.isSymbolicLink() || !binStat.isFile()) {
      return false;
    }

    const realRoot = realpathSync(root);
    const realDir = realpathSync(binDir);
    const realBinary = realpathSync(candidateBinary);

    if (!isPathInside(realRoot, realDir)) {
      return false;
    }
    if (!isPathInside(realRoot, realBinary)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the resolved binary is the HealthLog-managed binary under
 * `<profileRoot>/bin/agy` (or default profile root) rather than an externally
 * mounted binary, system binary, or custom ANTIGRAVITY_BIN_PATH.
 *
 * Symlinks at the managed location or at the bin directory are treated as
 * externally managed to protect host mounts and operator symlinks from being
 * overwritten.
 */
export function isManagedAntigravityBinary({ binaryPath, profileRoot } = {}) {
  const resolved = resolveAntigravityBinary({ binaryPath, profileRoot });
  if (!resolved) return false;

  // When profileRoot is explicitly configured, only that root qualifies as managed.
  // The default profile root is only managed when no custom root is configured.
  const targetRoot = profileRoot || DEFAULT_PROFILE_ROOT;
  return isSafeManagedBinary(resolved, targetRoot);
}

function assertSafeInstallTarget(root) {
  const binDir = join(root, "bin");
  const targetBinary = antigravityBinaryPath(root);

  let dirStat = null;
  try {
    dirStat = lstatSync(binDir);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }

  if (dirStat) {
    if (dirStat.isSymbolicLink()) {
      throw new Error(
        `Cannot install into symlinked bin directory at ${binDir}. The binary is externally managed.`,
      );
    }
    let realRoot;
    let realDir;
    try {
      realRoot = realpathSync(root);
      realDir = realpathSync(binDir);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    if (realRoot && realDir && !isPathInside(realRoot, realDir)) {
      throw new Error(
        `Bin directory ${binDir} resolves outside profile root ${root}. The binary is externally managed.`,
      );
    }
  }

  let binStat = null;
  try {
    binStat = lstatSync(targetBinary);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }

  if (binStat) {
    if (binStat.isSymbolicLink()) {
      throw new Error(
        `Cannot overwrite symlink at ${targetBinary}. The binary is externally managed.`,
      );
    }
    let realRoot;
    let realBinary;
    try {
      realRoot = realpathSync(root);
      realBinary = realpathSync(targetBinary);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    if (realRoot && realBinary && !isPathInside(realRoot, realBinary)) {
      throw new Error(
        `Binary at ${targetBinary} resolves outside profile root ${root}. The binary is externally managed.`,
      );
    }
  }
}

function versionFrom(stdout) {
  const match = String(stdout).match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function shaFor(arch) {
  if (arch === "x64") return { asset: "x64", sha256: AGY_SHA256_AMD64 };
  if (arch === "arm64") return { asset: "arm64", sha256: AGY_SHA256_ARM64 };
  throw new Error(`Unsupported architecture for Antigravity CLI: ${arch}`);
}

/**
 * Stream the response body into `file` and hash it on the way. Refuses a body
 * larger than MAX_ARCHIVE_BYTES, and deletes the partial file on any failure.
 */
async function downloadArchive(response, file) {
  const out = createWriteStream(file);
  const hash = createHash("sha256");
  let reader = null;
  let received = 0;

  let rejectStreamError;
  const streamErrorPromise = new Promise((_, reject) => {
    rejectStreamError = reject;
  });
  streamErrorPromise.catch(() => {});

  const onStreamError = (err) => {
    rejectStreamError(err);
  };
  out.on("error", onStreamError);

  try {
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        streamErrorPromise,
      ]);
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error(
          "Antigravity CLI archive is larger than the allowed size",
        );
      }
      hash.update(value);
      if (!out.write(value)) {
        await Promise.race([once(out, "drain"), streamErrorPromise]);
      }
    }
    out.end();
    await Promise.race([once(out, "finish"), streamErrorPromise]);
  } catch (err) {
    out.destroy();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The body is already closed.
      }
    }
    try {
      unlinkSync(file);
    } catch {
      // Nothing was written.
    }
    throw err;
  } finally {
    out.off("error", onStreamError);
  }
  return hash.digest("hex");
}

async function doInstall({
  profileRoot,
  binaryPath,
  force,
  download,
  childEnv,
  release,
}) {
  if (binaryPath) {
    throw new Error(
      "Antigravity CLI is externally managed via binaryPath override and cannot be installed or modified by HealthLog",
    );
  }

  const root = profileRoot || DEFAULT_PROFILE_ROOT;
  const binDir = join(root, "bin");
  const targetBinary = antigravityBinaryPath(root);

  assertSafeInstallTarget(root);

  if (!force) {
    const existing = resolveAntigravityBinary({
      binaryPath,
      profileRoot: root,
    });
    if (existing) {
      try {
        const { stdout } = await execFileAsync(existing, ["--version"], {
          timeout: VERSION_TIMEOUT_MS,
          ...(childEnv ? { env: childEnv } : {}),
        });
        const version = versionFrom(stdout);
        if (version) {
          return {
            version,
            binaryPath: existing,
            alreadyInstalled: true,
          };
        }
      } catch {
        // The file is there but does not run. Install it again.
      }
    }
  }

  let downloadUrl;
  let expectedSha256;
  if (release) {
    if (!release.downloadUrl || !release.sha256) {
      throw new Error(
        "Invalid release provided to installer: missing downloadUrl or sha256",
      );
    }
    if (
      typeof release.downloadUrl !== "string" ||
      !release.downloadUrl.startsWith("https://")
    ) {
      throw new Error(
        `Invalid downloadUrl for Antigravity release: must use HTTPS protocol, got "${release.downloadUrl}"`,
      );
    }
    downloadUrl = release.downloadUrl;
    // Trust model: for the pinned version, always enforce the build-pinned
    // SHA-256 hash. For dynamic newer releases discovered via official GitHub
    // release metadata over HTTPS, trust the release asset digest published
    // on GitHub.
    if (compareSemver(release.version, AGY_PINNED_VERSION) === 0) {
      const { sha256: pinnedSha } = shaFor(process.arch);
      expectedSha256 = pinnedSha;
    } else {
      expectedSha256 = String(release.sha256).toLowerCase();
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error(
        `Invalid sha256 digest format for Antigravity release: ${expectedSha256}`,
      );
    }
  } else {
    const { asset, sha256 } = shaFor(process.arch);
    expectedSha256 = sha256;
    downloadUrl = `https://github.com/google-antigravity/antigravity-cli/releases/download/${AGY_PINNED_VERSION}/agy_cli_linux_${asset}.tar.gz`;
  }

  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  assertSafeInstallTarget(root);

  const response = await download(downloadUrl);
  if (!response.ok || !response.body) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // The body is already closed.
      }
    }
    throw new Error(
      `Failed to download Antigravity CLI: ${response.status} ${response.statusText}`,
    );
  }

  const archive = join(
    binDir,
    `agy-download-${process.pid}-${Date.now()}.tar.gz`,
  );
  const staging = mkdtempSync(join(binDir, ".extract-"));
  try {
    const actualSha256 = await downloadArchive(response, archive);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `SHA256 checksum mismatch for Antigravity CLI. Expected: ${expectedSha256}, Actual: ${actualSha256}`,
      );
    }

    await execFileAsync("tar", ["-xzf", archive, "-C", staging, "antigravity"]);
    const extracted = join(staging, "antigravity");
    if (!existsSync(extracted)) {
      throw new Error("Extracted antigravity binary not found in archive");
    }
    const stat = lstatSync(extracted);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Extracted antigravity binary must be a regular file");
    }
    chmodSync(extracted, 0o755);

    const { stdout: probeStdout } = await execFileAsync(
      extracted,
      ["--version"],
      {
        timeout: VERSION_TIMEOUT_MS,
        ...(childEnv ? { env: childEnv } : {}),
      },
    );
    const version = versionFrom(probeStdout);
    if (!version) {
      throw new Error(
        "Installed Antigravity CLI output did not contain a parseable version",
      );
    }

    const expectedVersion = release?.version
      ? stripV(release.version)
      : stripV(AGY_PINNED_VERSION);

    if (compareSemver(version, expectedVersion) !== 0) {
      throw new Error(
        `Downloaded Antigravity CLI version mismatch. Expected ${expectedVersion}, got ${version}`,
      );
    }

    assertSafeInstallTarget(root);

    const preRenameStat = lstatSync(extracted);
    if (preRenameStat.isSymbolicLink() || !preRenameStat.isFile()) {
      throw new Error("Extracted antigravity binary must be a regular file");
    }

    // rename replaces the old binary in one step, so no caller sees a gap.
    renameSync(extracted, targetBinary);

    return {
      version,
      binaryPath: targetBinary,
      alreadyInstalled: false,
    };
  } finally {
    try {
      unlinkSync(archive);
    } catch {
      // Already removed, or never written.
    }
    rmSync(staging, { recursive: true, force: true });
  }
}

// Track running install per process.
let inFlightExecution = null;

/**
 * Download, verify and install the pinned or specified binary into `<profileRoot>/bin/agy`.
 *
 * Concurrent callers requesting the same target version share the running install.
 * A simultaneous update or forced reinstall for a different target version waits for the
 * in-flight install to finish before performing the requested operation, ensuring that
 * updates are never falsely reported by an unrelated in-flight install.
 *
 * @param {{
 *   profileRoot?: string,
 *   binaryPath?: string,
 *   force?: boolean,
 *   release?: { version: string, downloadUrl: string, sha256: string },
 *   childEnv?: NodeJS.ProcessEnv,
 *   download: (url: string) => Promise<Response>,
 * }} options
 */
export function installAgy(options) {
  const root = options?.profileRoot || DEFAULT_PROFILE_ROOT;
  const targetVersion = options?.release?.version
    ? stripV(options.release.version)
    : stripV(AGY_PINNED_VERSION);
  const requiresForce = options?.force === true;

  if (
    inFlightExecution &&
    inFlightExecution.root === root &&
    inFlightExecution.targetVersion === targetVersion &&
    (!requiresForce || inFlightExecution.force)
  ) {
    return inFlightExecution.promise;
  }

  const previous = inFlightExecution
    ? inFlightExecution.promise.catch(() => {})
    : Promise.resolve();

  const promise = (async () => {
    await previous;
    return doInstall(options);
  })().finally(() => {
    if (inFlightExecution?.promise === promise) {
      inFlightExecution = null;
    }
  });

  inFlightExecution = {
    promise,
    root,
    targetVersion,
    force: requiresForce,
  };

  return promise;
}
