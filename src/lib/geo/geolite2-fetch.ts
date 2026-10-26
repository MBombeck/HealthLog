/**
 * Runtime GeoLite2 database fetch (issue #659).
 *
 * A self-hoster running the published image cannot set a build secret, so the
 * two pre-existing ways to get the offline MMDBs — bake them at build time via
 * `scripts/fetch-geolite2.sh`, or mount your own and point `GEOLITE2_DIR` at
 * them — both need something the operator of a stock `:latest` pull does not
 * have. This is the third way: given `MAXMIND_LICENSE_KEY` at runtime, the
 * worker downloads GeoLite2-City + GeoLite2-ASN itself, extracts each, and
 * places them in `geoLiteDir()`. No rebuild, no manual mount.
 *
 * Fail-soft is the whole contract. Every download extracts to a temp file in
 * the SAME directory as the target, and a completed edition is promoted with an
 * atomic `rename` only after ALL editions are in hand — so a mid-fetch error
 * (bad key, MaxMind 5xx, a truncated body) leaves the previous databases exactly
 * as they were and never writes a partial `.mmdb`. The offline tier is optional;
 * a failure just means the online provider keeps answering, which is the
 * keyless default anyway.
 *
 * The MaxMind permalink (`download.maxmind.com/app/geoip_download`) 302-redirects
 * to a signed CDN URL, so the fetch opts into `followRedirects: true` on top of
 * the `requirePublicHost: true` DNS-rebinding pin.
 *
 * Extraction is pure Node: `zlib.gunzipSync` + a minimal in-process tar reader
 * (`extractMmdbFromTarGz`), NOT a shell-out to `tar`. The runtime image does
 * carry busybox `tar`+`gzip`, but this module is reachable from the worker-boot
 * import chain (`instrumentation.ts` → `reminder-worker` → this file), and a
 * `child_process` import there makes Next's file tracer give up and trace the
 * whole project into the standalone output. `node:zlib` keeps the trace bounded,
 * removes the busybox runtime dependency entirely, and is trivially unit-testable
 * — the MaxMind tarball nests a single `.mmdb` under one date-stamped directory,
 * a shape a ~40-line reader handles without a dependency.
 */
import { envFlag } from "@/lib/env";
import zlib from "node:zlib";
import fsp from "node:fs/promises";
import path from "node:path";
import { getEvent } from "@/lib/logging/context";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import {
  geoLiteDir,
  offlineGeoReady,
  resetGeoLite2ReaderCache,
} from "@/lib/geo";

/**
 * The MaxMind permalink download endpoint. Same URL shape the build-time
 * `scripts/fetch-geolite2.sh` uses: `?edition_id=…&license_key=…&suffix=tar.gz`.
 */
export const MAXMIND_DOWNLOAD_BASE =
  "https://download.maxmind.com/app/geoip_download";

export interface Geolite2Edition {
  /** MaxMind edition id, e.g. `GeoLite2-City`. */
  editionId: string;
  /** The `.mmdb` basename the resolver in `geo.ts` reads. */
  mmdb: string;
}

/**
 * The two editions the resolver reads: City for location, ASN for the
 * authoritative carrier + AS number. Both must land for the fetch to count as
 * a success, matching the build-time script's all-or-nothing contract.
 */
export const GEOLITE2_EDITIONS: readonly Geolite2Edition[] = [
  { editionId: "GeoLite2-City", mmdb: "GeoLite2-City.mmdb" },
  { editionId: "GeoLite2-ASN", mmdb: "GeoLite2-ASN.mmdb" },
];

// A GeoLite2 tarball is ~40-60 MB; give the download well clear of the 15 s
// safeFetch default so a slow self-host link does not abort a good fetch. The
// signal covers body streaming too (undici aborts the read on the same signal).
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type Geolite2FetchStatus =
  | "skipped_disabled"
  | "skipped_no_key"
  | "skipped_present"
  | "fetched"
  | "failed";

export interface Geolite2FetchResult {
  status: Geolite2FetchStatus;
  /** Edition ids that were placed on a `"fetched"` result; empty otherwise. */
  editions: string[];
  /** Human-readable cause on a `"failed"` result. */
  error?: string;
}

/**
 * Build the MaxMind permalink download URL for one edition. Exported so the
 * unit test can assert the exact wire URL per edition without a live request.
 */
export function buildMaxmindDownloadUrl(
  editionId: string,
  licenseKey: string,
): string {
  const params = new URLSearchParams({
    edition_id: editionId,
    license_key: licenseKey,
    suffix: "tar.gz",
  });
  return `${MAXMIND_DOWNLOAD_BASE}?${params.toString()}`;
}

function fail(message: string, cause: unknown): Geolite2FetchResult {
  const detail = cause instanceof Error ? cause.message : String(cause);
  getEvent()?.addWarning(`geolite2-fetch: ${message}: ${detail}`);
  return { status: "failed", editions: [], error: `${message}: ${detail}` };
}

const TAR_BLOCK = 512;

/** Read a NUL-terminated ASCII field from a tar header block. */
function readTarField(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.toString("ascii", 0, end === -1 ? raw.length : end).trim();
}

/** Parse a tar octal size field. GeoLite2 mmdbs fit octal, so no base-256 path. */
function readTarOctal(header: Buffer, offset: number, length: number): number {
  const text = readTarField(header, offset, length);
  if (!text) return 0;
  const n = parseInt(text, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extract one `.mmdb` from a gzipped tar. The MaxMind tarball nests a single
 * database under a date-stamped directory (`GeoLite2-City_YYYYMMDD/…mmdb`), so
 * we walk the ustar entries and return the first regular file whose basename
 * matches. Non-file records (directories, PAX/GNU extension headers) never
 * match and are stepped over by their declared size, so the reader stays
 * correct against both GNU tar and bsdtar output. Returns null if absent.
 */
export function extractMmdbFromTarGz(
  gz: Buffer,
  mmdbBasename: string,
): Buffer | null {
  const tar = zlib.gunzipSync(gz);
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    // Two all-zero blocks mark end-of-archive; one is enough to stop on.
    if (header.every((b) => b === 0)) break;

    const name = readTarField(header, 0, 100);
    const size = readTarOctal(header, 124, 12);
    const typeflag = header[156];
    const dataStart = offset + TAR_BLOCK;

    // Regular file: typeflag '0' (0x30) or the legacy NUL (0x00).
    const isFile = typeflag === 0x30 || typeflag === 0x00;
    if (isFile && name.split("/").pop() === mmdbBasename) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }

    // Advance past the data, padded up to the next 512-byte boundary.
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

/**
 * Download one edition and extract its `.mmdb` to a temp file in `destDir`.
 * Returns the temp path — the caller promotes it with an atomic rename once
 * every edition has been staged. Throws on any failure so the caller can
 * discard all partial temp files and leave the existing databases untouched.
 */
async function downloadAndExtractEdition(
  edition: Geolite2Edition,
  licenseKey: string,
  destDir: string,
): Promise<string> {
  const url = buildMaxmindDownloadUrl(edition.editionId, licenseKey);
  // The URL carries `license_key=<secret>` in its query string. safeFetch
  // embeds the full URL in its thrown error message, and the wide-event
  // warning / job-failure paths do not redact it, so a bare re-throw would
  // print the licence key to stdout, Loki and GlitchTip on any timeout or
  // network error. Re-throw with the edition and the error KIND only, never
  // the URL.
  let res: Response;
  try {
    res = await safeFetch(
      url,
      { headers: { Accept: "application/gzip" } },
      {
        // The permalink 302s to a signed CDN, so follow redirects; keep the
        // connect-time public-host pin so a rebinding cannot swing the hop onto
        // a private/metadata address.
        followRedirects: true,
        requirePublicHost: true,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      },
    );
  } catch (err) {
    const kind = err instanceof SafeFetchError ? err.kind : "network";
    throw new Error(`${edition.editionId} download failed (${kind})`);
  }
  if (!res.ok) {
    // 401 = wrong key / unsigned EULA, 403 = throttle, 5xx = MaxMind-side.
    throw new Error(
      `${edition.editionId} download returned HTTP ${res.status}`,
    );
  }

  const gz = Buffer.from(await res.arrayBuffer());
  const mmdb = extractMmdbFromTarGz(gz, edition.mmdb);
  if (!mmdb) {
    throw new Error(
      `${edition.mmdb} not found inside the ${edition.editionId} tarball`,
    );
  }
  if (mmdb.length === 0) {
    throw new Error(`${edition.mmdb} extracted empty`);
  }

  // Stage under destDir (same filesystem) so the promote is an atomic rename.
  // A `.tmp-` suffix keeps it out of the resolver's eye — `offlineGeoReady()`
  // only accepts the exact `GeoLite2-City.mmdb`.
  const tmpDest = path.join(
    destDir,
    `${edition.mmdb}.tmp-${process.pid}-${Date.now()}`,
  );
  await fsp.writeFile(tmpDest, mmdb);
  return tmpDest;
}

/**
 * Create `dir` and its missing parents one level at a time. Not
 * `fsp.mkdir(dir, { recursive: true })`: below `/proc` on Linux Node's
 * recursive walk retries ENOENT/EEXIST forever and the promise never settles.
 * Same walk as `makeDirectory` in `src/lib/database-backup/dump-core.mjs`,
 * which this module cannot import (its `child_process` import would undo the
 * bounded trace described above).
 */
export async function makeDirectory(dir: string): Promise<void> {
  const missing: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    try {
      await fsp.stat(current);
      break;
    } catch {
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const p of missing.reverse()) {
    try {
      await fsp.mkdir(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/**
 * Fetch both GeoLite2 databases and place them in `geoLiteDir()`.
 *
 *   - `IP_GEO_LOOKUP_DISABLED=1` → `skipped_disabled` (the whole tier is off).
 *   - No `MAXMIND_LICENSE_KEY` → `skipped_no_key`.
 *   - `skipIfPresent` and the offline tier already ready → `skipped_present`
 *     (the boot path: only fetch when there is no database yet).
 *
 * On success the reader cache is reset so a running worker reads the new
 * databases without a restart, and any stale keyless-build `.empty` marker is
 * removed. Never throws.
 */
export async function fetchGeoLite2Databases(
  opts: { skipIfPresent?: boolean } = {},
): Promise<Geolite2FetchResult> {
  if (envFlag("IP_GEO_LOOKUP_DISABLED")) {
    return { status: "skipped_disabled", editions: [] };
  }
  const licenseKey = process.env.MAXMIND_LICENSE_KEY?.trim();
  if (!licenseKey) {
    return { status: "skipped_no_key", editions: [] };
  }
  if (opts.skipIfPresent && offlineGeoReady()) {
    return { status: "skipped_present", editions: [] };
  }

  const dir = geoLiteDir();
  try {
    await makeDirectory(dir);
  } catch (err) {
    return fail(`geolite2 directory not writable (${dir})`, err);
  }

  const staged: { mmdb: string; tmp: string }[] = [];
  try {
    for (const edition of GEOLITE2_EDITIONS) {
      const tmp = await downloadAndExtractEdition(edition, licenseKey, dir);
      staged.push({ mmdb: edition.mmdb, tmp });
    }
  } catch (err) {
    // Fail-soft: drop every partial temp file, leave the existing databases.
    await Promise.all(
      staged.map((s) => fsp.rm(s.tmp, { force: true }).catch(() => {})),
    );
    return fail("geolite2 download/extract failed", err);
  }

  // Every edition is staged; promote them all with atomic renames.
  try {
    for (const s of staged) {
      await fsp.rename(s.tmp, path.join(dir, s.mmdb));
    }
    // A freshly populated directory must not keep a stale keyless-build marker
    // (the resolver reads `.empty` as "offline tier deliberately absent").
    await fsp.rm(path.join(dir, ".empty"), { force: true }).catch(() => {});
  } catch (err) {
    await Promise.all(
      staged.map((s) => fsp.rm(s.tmp, { force: true }).catch(() => {})),
    );
    return fail("geolite2 promote failed", err);
  }

  // The running worker latched its readers before the files existed; reset so
  // the next lookup reads them.
  resetGeoLite2ReaderCache();

  return {
    status: "fetched",
    editions: GEOLITE2_EDITIONS.map((e) => e.editionId),
  };
}
