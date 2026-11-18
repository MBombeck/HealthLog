/**
 * CLI probe helper for Antigravity (`agy`).
 *
 * Runs `--version` in an allowlisted child environment and caches probes by
 * file identity (mtime, size, inode) to avoid spawning child processes on every
 * poll, while immediately picking up repaired or replaced binaries.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { antigravityChildEnv } from "./antigravity-client";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

export interface CliProbe {
  installed: boolean;
  version: string | null;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  probe: CliProbe;
}

/**
 * The last `--version` result per binary path. The probe starts a process, and
 * the settings page polls the status endpoint. An entry is valid while the
 * binary's stat identity (modification time, size, inode) stays the same, so
 * replaced or repaired binaries invalidate the cache.
 */
const versionCache = new Map<string, CacheEntry>();

export async function probeCli(binary: string): Promise<CliProbe> {
  let mtimeMs: number;
  let size: number;
  let ino: number;
  try {
    const stat = statSync(binary);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
    ino = stat.ino;
  } catch {
    versionCache.delete(binary);
    return { installed: false, version: null };
  }
  const cached = versionCache.get(binary);
  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    cached.size === size &&
    cached.ino === ino
  ) {
    return cached.probe;
  }

  let probe: CliProbe;
  try {
    // The child gets the same allowlisted environment as the provider, so app
    // secrets stay out of it.
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: PROBE_TIMEOUT_MS,
      env: antigravityChildEnv(),
    });
    const match = String(stdout).match(/(\d+\.\d+\.\d+)/);
    probe = { installed: true, version: match ? match[1] : null };
  } catch {
    // The file is there but does not run. The reason stays out of the response.
    probe = { installed: false, version: null };
  }

  versionCache.set(binary, { mtimeMs, size, ino, probe });

  return probe;
}
