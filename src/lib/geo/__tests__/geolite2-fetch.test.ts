/**
 * Runtime GeoLite2 fetch (issue #659) — unit coverage.
 *
 * The network is mocked (safeFetch), but the filesystem + `tar` extraction run
 * for real against a tar.gz fixture built the same way MaxMind ships one (the
 * mmdb nested under a date-stamped directory). That exercises the actual
 * temp-then-rename place path, not a stub of it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeFetchError } from "@/lib/safe-fetch";

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

const { resetCacheSpy } = vi.hoisted(() => ({ resetCacheSpy: vi.fn() }));
vi.mock("@/lib/geo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/geo")>();
  return { ...actual, resetGeoLite2ReaderCache: resetCacheSpy };
});

import {
  buildMaxmindDownloadUrl,
  fetchGeoLite2Databases,
  makeDirectory,
  MAXMIND_DOWNLOAD_BASE,
} from "@/lib/geo/geolite2-fetch";

const CITY_BYTES = Buffer.from("CITY-MMDB-CONTENT-\x01\x02\x03");
const ASN_BYTES = Buffer.from("ASN-MMDB-CONTENT-\x04\x05\x06");

/** Build a MaxMind-shaped tar.gz: `<Edition>_<date>/<Edition>.mmdb`. */
function buildEditionTarball(
  editionId: string,
  mmdbBytes: Buffer,
): ArrayBuffer {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "geolite2-fixture-"));
  try {
    const inner = `${editionId}_20260808`;
    fs.mkdirSync(path.join(stage, inner));
    fs.writeFileSync(path.join(stage, inner, `${editionId}.mmdb`), mmdbBytes);
    const tarball = path.join(stage, `${editionId}.tar.gz`);
    execFileSync("tar", ["-czf", tarball, "-C", stage, inner]);
    const buf = fs.readFileSync(tarball);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function okResponse(body: ArrayBuffer): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => body,
  } as unknown as Response;
}

let geoDir: string;
const ORIGINAL_KEY = process.env.MAXMIND_LICENSE_KEY;
const ORIGINAL_DISABLED = process.env.IP_GEO_LOOKUP_DISABLED;
const ORIGINAL_DIR = process.env.GEOLITE2_DIR;

beforeEach(() => {
  safeFetchMock.mockReset();
  resetCacheSpy.mockReset();
  geoDir = fs.mkdtempSync(path.join(os.tmpdir(), "geolite2-target-"));
  process.env.GEOLITE2_DIR = geoDir;
  process.env.MAXMIND_LICENSE_KEY = "test-licence-key";
  delete process.env.IP_GEO_LOOKUP_DISABLED;
});

afterEach(() => {
  fs.rmSync(geoDir, { recursive: true, force: true });
  if (ORIGINAL_KEY === undefined) delete process.env.MAXMIND_LICENSE_KEY;
  else process.env.MAXMIND_LICENSE_KEY = ORIGINAL_KEY;
  if (ORIGINAL_DISABLED === undefined)
    delete process.env.IP_GEO_LOOKUP_DISABLED;
  else process.env.IP_GEO_LOOKUP_DISABLED = ORIGINAL_DISABLED;
  if (ORIGINAL_DIR === undefined) delete process.env.GEOLITE2_DIR;
  else process.env.GEOLITE2_DIR = ORIGINAL_DIR;
});

/** Route each edition's mocked download to its fixture tarball. */
function wireTarballDownloads(): void {
  const city = buildEditionTarball("GeoLite2-City", CITY_BYTES);
  const asn = buildEditionTarball("GeoLite2-ASN", ASN_BYTES);
  safeFetchMock.mockImplementation(async (url: string) => {
    if (url.includes("GeoLite2-City")) return okResponse(city);
    if (url.includes("GeoLite2-ASN")) return okResponse(asn);
    throw new Error(`unexpected url ${url}`);
  });
}

describe("buildMaxmindDownloadUrl", () => {
  it("builds the permalink URL per edition with the key + tar.gz suffix", () => {
    const url = buildMaxmindDownloadUrl("GeoLite2-City", "abc123");
    expect(url.startsWith(`${MAXMIND_DOWNLOAD_BASE}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("edition_id")).toBe("GeoLite2-City");
    expect(params.get("license_key")).toBe("abc123");
    expect(params.get("suffix")).toBe("tar.gz");
  });
});

describe("fetchGeoLite2Databases — success", () => {
  it("downloads both editions and places the mmdbs atomically", async () => {
    wireTarballDownloads();
    fs.writeFileSync(path.join(geoDir, ".empty"), ""); // stale keyless marker

    const result = await fetchGeoLite2Databases();

    expect(result.status).toBe("fetched");
    expect(result.editions).toEqual(["GeoLite2-City", "GeoLite2-ASN"]);

    // Both databases landed with the exact fixture bytes.
    expect(fs.readFileSync(path.join(geoDir, "GeoLite2-City.mmdb"))).toEqual(
      CITY_BYTES,
    );
    expect(fs.readFileSync(path.join(geoDir, "GeoLite2-ASN.mmdb"))).toEqual(
      ASN_BYTES,
    );

    // The stale `.empty` marker is gone and no temp/work residue remains.
    expect(fs.existsSync(path.join(geoDir, ".empty"))).toBe(false);
    const leftovers = fs
      .readdirSync(geoDir)
      .filter((n) => n.startsWith(".geolite2-") || n.includes(".tmp-"));
    expect(leftovers).toEqual([]);

    // The running worker's reader cache is reset so it re-reads the new files.
    expect(resetCacheSpy).toHaveBeenCalledTimes(1);
  });

  it("requests each edition with redirect-following + the public-host pin", async () => {
    wireTarballDownloads();

    await fetchGeoLite2Databases();

    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    for (const call of safeFetchMock.mock.calls) {
      const [url, , opts] = call;
      expect(url).toContain("license_key=test-licence-key");
      expect(url).toContain("suffix=tar.gz");
      expect(opts).toMatchObject({
        followRedirects: true,
        requirePublicHost: true,
      });
      expect(typeof opts.timeoutMs).toBe("number");
    }
    const urls = safeFetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("edition_id=GeoLite2-City"))).toBe(true);
    expect(urls.some((u) => u.includes("edition_id=GeoLite2-ASN"))).toBe(true);
  });
});

describe("fetchGeoLite2Databases — fail-soft", () => {
  it("leaves an existing database untouched and writes no partial file on a download error", async () => {
    const existing = Buffer.from("EXISTING-GOOD-CITY-DB");
    fs.writeFileSync(path.join(geoDir, "GeoLite2-City.mmdb"), existing);

    safeFetchMock.mockRejectedValue(new SafeFetchError("boom", "network"));

    const result = await fetchGeoLite2Databases();

    expect(result.status).toBe("failed");
    // The pre-existing database is byte-for-byte intact.
    expect(fs.readFileSync(path.join(geoDir, "GeoLite2-City.mmdb"))).toEqual(
      existing,
    );
    // No partial temp file, no orphaned work directory.
    const residue = fs
      .readdirSync(geoDir)
      .filter((n) => n.startsWith(".geolite2-") || n.includes(".tmp-"));
    expect(residue).toEqual([]);
    // A failed fetch must NOT reset the reader cache.
    expect(resetCacheSpy).not.toHaveBeenCalled();
  });

  it("never leaks the licence key into the error on a fetch-layer throw", async () => {
    // safeFetch embeds the full target URL — which carries `license_key=<secret>`
    // — in its thrown message. The download timeout was raised to 120s for slow
    // self-host links, so timeouts are an expected path; the reported error must
    // name the failure without the URL, or the key lands on stdout / Loki.
    safeFetchMock.mockRejectedValue(
      new SafeFetchError(
        "safeFetch aborted (TimeoutError): https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=test-licence-key&suffix=tar.gz",
        "timeout",
      ),
    );

    const result = await fetchGeoLite2Databases();

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("test-licence-key");
    expect(result.error).not.toContain("license_key");
  });

  it("promotes nothing when the first edition succeeds but the second fails", async () => {
    // The atomicity contract: City downloads + extracts fine, ASN 401s. Since
    // not every edition was staged, NOTHING is promoted — no GeoLite2-City.mmdb
    // appears — and the City temp file is cleaned up.
    const city = buildEditionTarball("GeoLite2-City", CITY_BYTES);
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("GeoLite2-City")) return okResponse(city);
      return {
        ok: false,
        status: 401,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    });

    const result = await fetchGeoLite2Databases();

    expect(result.status).toBe("failed");
    // City must NOT have been promoted — the place is all-or-nothing.
    expect(fs.existsSync(path.join(geoDir, "GeoLite2-City.mmdb"))).toBe(false);
    // And its staged temp file must be gone.
    const residue = fs
      .readdirSync(geoDir)
      .filter((n) => n.startsWith(".geolite2-") || n.includes(".tmp-"));
    expect(residue).toEqual([]);
    expect(resetCacheSpy).not.toHaveBeenCalled();
  });

  it("fails soft when a non-ok HTTP status comes back", async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);

    const result = await fetchGeoLite2Databases();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("401");
    expect(fs.existsSync(path.join(geoDir, "GeoLite2-City.mmdb"))).toBe(false);
  });
});

describe("fetchGeoLite2Databases — gating", () => {
  it("skips when IP_GEO_LOOKUP_DISABLED=1", async () => {
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const result = await fetchGeoLite2Databases();
    expect(result.status).toBe("skipped_disabled");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("skips when no MAXMIND_LICENSE_KEY is set", async () => {
    delete process.env.MAXMIND_LICENSE_KEY;
    const result = await fetchGeoLite2Databases();
    expect(result.status).toBe("skipped_no_key");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("skips a boot-mode fetch when the offline tier is already present", async () => {
    fs.writeFileSync(
      path.join(geoDir, "GeoLite2-City.mmdb"),
      Buffer.from("already-here"),
    );
    const result = await fetchGeoLite2Databases({ skipIfPresent: true });
    expect(result.status).toBe("skipped_present");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("fetches anyway (refresh) when present but skipIfPresent is not set", async () => {
    wireTarballDownloads();
    fs.writeFileSync(
      path.join(geoDir, "GeoLite2-City.mmdb"),
      Buffer.from("old-city"),
    );
    const result = await fetchGeoLite2Databases();
    expect(result.status).toBe("fetched");
    expect(fs.readFileSync(path.join(geoDir, "GeoLite2-City.mmdb"))).toEqual(
      CITY_BYTES,
    );
  });
});

describe("makeDirectory", () => {
  it("creates every missing level and accepts an existing one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hl-geo-mkdir-"));
    try {
      const dir = path.join(root, "a", "b");
      await makeDirectory(dir);
      await makeDirectory(dir);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The recursive form never settles below /proc; this one rejects.
  it.runIf(process.platform === "linux")(
    "rejects below /proc instead of never settling",
    async () => {
      await expect(
        makeDirectory("/proc/healthlog-cannot-write-here/nested"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    5_000,
  );
});
