import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearAntigravityReleaseCache,
  getLatestAntigravityRelease,
  parseAntigravityRelease,
  parseSemverTag,
  parseSha256Digest,
  AntigravityReleaseError,
  AGY_LATEST_RELEASE_URL,
  RELEASE_CACHE_TTL_MS,
} from "../antigravity-release";

describe("Antigravity Release Parsing & Validation", () => {
  const validSha256 =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  const validPayload = {
    tag_name: "v1.5.11",
    name: "1.5.11",
    draft: false,
    prerelease: false,
    published_at: "2026-11-15T12:00:00Z",
    assets: [
      {
        name: "agy_cli_linux_x64.tar.gz",
        browser_download_url:
          "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
        digest: `sha256:${validSha256}`,
      },
      {
        name: "agy_cli_linux_arm64.tar.gz",
        browser_download_url:
          "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_arm64.tar.gz",
        digest: `sha256:${validSha256}`,
      },
    ],
  };

  describe("parseSha256Digest", () => {
    it("parses digests with sha256: prefix", () => {
      expect(parseSha256Digest(`sha256:${validSha256}`)).toBe(validSha256);
      expect(parseSha256Digest(`SHA256:${validSha256.toUpperCase()}`)).toBe(
        validSha256,
      );
    });

    it("parses raw 64-character hex digests without prefix", () => {
      expect(parseSha256Digest(validSha256)).toBe(validSha256);
    });

    it("rejects non-SHA256 digests or invalid inputs", () => {
      expect(parseSha256Digest(null)).toBeNull();
      expect(parseSha256Digest(undefined)).toBeNull();
      expect(parseSha256Digest("")).toBeNull();
      expect(
        parseSha256Digest("md5:1234567890abcdef1234567890abcdef"),
      ).toBeNull();
      expect(parseSha256Digest(validSha256.slice(0, 63))).toBeNull(); // too short
      expect(parseSha256Digest(validSha256 + "a")).toBeNull(); // too long
      expect(
        parseSha256Digest("not-a-hex-string-at-all-xyz0123456789abcdef"),
      ).toBeNull();
    });
  });

  describe("parseSemverTag", () => {
    it("strips leading 'v' and returns semver", () => {
      expect(parseSemverTag("v1.5.11")).toBe("1.5.11");
      expect(parseSemverTag("1.5.11")).toBe("1.5.11");
      expect(parseSemverTag("v2.0.0-rc.1")).toBe("2.0.0-rc.1");
    });

    it("rejects non-semver tags", () => {
      expect(parseSemverTag("latest")).toBeNull();
      expect(parseSemverTag("")).toBeNull();
      expect(parseSemverTag(null)).toBeNull();
      expect(parseSemverTag("nightly-build")).toBeNull();
    });
  });

  describe("parseAntigravityRelease", () => {
    it("parses a valid Linux x64 release payload", () => {
      const result = parseAntigravityRelease(validPayload, {
        platform: "linux",
        arch: "x64",
      });

      expect(result).toEqual({
        version: "1.5.11",
        tagName: "v1.5.11",
        assetName: "agy_cli_linux_x64.tar.gz",
        downloadUrl:
          "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
        sha256: validSha256,
        publishedAt: "2026-11-15T12:00:00Z",
      });
    });

    it("parses a valid Linux arm64 release payload", () => {
      const result = parseAntigravityRelease(validPayload, {
        platform: "linux",
        arch: "arm64",
      });

      expect(result).toEqual({
        version: "1.5.11",
        tagName: "v1.5.11",
        assetName: "agy_cli_linux_arm64.tar.gz",
        downloadUrl:
          "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_arm64.tar.gz",
        sha256: validSha256,
        publishedAt: "2026-11-15T12:00:00Z",
      });
    });

    it("refuses draft releases", () => {
      const draft = { ...validPayload, draft: true };
      expect(() =>
        parseAntigravityRelease(draft, { platform: "linux", arch: "x64" }),
      ).toThrowError(AntigravityReleaseError);
    });

    it("refuses prerelease versions", () => {
      const prerelease = { ...validPayload, prerelease: true };
      expect(() =>
        parseAntigravityRelease(prerelease, { platform: "linux", arch: "x64" }),
      ).toThrowError(/prerelease/);
    });

    it("refuses unsupported platforms", () => {
      expect(() =>
        parseAntigravityRelease(validPayload, {
          platform: "darwin",
          arch: "x64",
        }),
      ).toThrowError(/Unsupported platform/);
    });

    it("refuses unsupported architectures", () => {
      expect(() =>
        parseAntigravityRelease(validPayload, {
          platform: "linux",
          arch: "s390x",
        }),
      ).toThrowError(/Unsupported architecture/);
    });

    it("refuses payloads missing the target platform asset", () => {
      const missingAsset = {
        ...validPayload,
        assets: [validPayload.assets[1]], // arm64 only
      };
      expect(() =>
        parseAntigravityRelease(missingAsset, {
          platform: "linux",
          arch: "x64",
        }),
      ).toThrowError(/does not contain asset/);
    });

    it("refuses assets with non-HTTPS or non-matching download URLs", () => {
      const insecureUrl = {
        ...validPayload,
        assets: [
          {
            name: "agy_cli_linux_x64.tar.gz",
            browser_download_url:
              "http://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
            digest: `sha256:${validSha256}`,
          },
        ],
      };
      expect(() =>
        parseAntigravityRelease(insecureUrl, {
          platform: "linux",
          arch: "x64",
        }),
      ).toThrowError(/download URL does not match official GitHub release URL/);

      const arbitraryHost = {
        ...validPayload,
        assets: [
          {
            name: "agy_cli_linux_x64.tar.gz",
            browser_download_url:
              "https://evil.example.com/agy_cli_linux_x64.tar.gz",
            digest: `sha256:${validSha256}`,
          },
        ],
      };
      expect(() =>
        parseAntigravityRelease(arbitraryHost, {
          platform: "linux",
          arch: "x64",
        }),
      ).toThrowError(/download URL does not match official GitHub release URL/);

      const wrongRepo = {
        ...validPayload,
        assets: [
          {
            name: "agy_cli_linux_x64.tar.gz",
            browser_download_url:
              "https://github.com/other-org/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
            digest: `sha256:${validSha256}`,
          },
        ],
      };
      expect(() =>
        parseAntigravityRelease(wrongRepo, { platform: "linux", arch: "x64" }),
      ).toThrowError(/download URL does not match official GitHub release URL/);

      const wrongTag = {
        ...validPayload,
        assets: [
          {
            name: "agy_cli_linux_x64.tar.gz",
            browser_download_url:
              "https://github.com/google-antigravity/antigravity-cli/releases/download/v9.9.9/agy_cli_linux_x64.tar.gz",
            digest: `sha256:${validSha256}`,
          },
        ],
      };
      expect(() =>
        parseAntigravityRelease(wrongTag, { platform: "linux", arch: "x64" }),
      ).toThrowError(/download URL does not match official GitHub release URL/);
    });

    it("refuses assets missing a valid SHA-256 digest", () => {
      const missingDigest = {
        ...validPayload,
        assets: [
          {
            name: "agy_cli_linux_x64.tar.gz",
            browser_download_url:
              "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
            digest: "invalid-hash",
          },
        ],
      };
      expect(() =>
        parseAntigravityRelease(missingDigest, {
          platform: "linux",
          arch: "x64",
        }),
      ).toThrowError(/missing a valid SHA-256 digest/);
    });
  });

  describe("getLatestAntigravityRelease caching and error handling", () => {
    beforeEach(() => {
      clearAntigravityReleaseCache();
    });

    afterEach(() => {
      clearAntigravityReleaseCache();
    });

    it("fetches from the official releases/latest endpoint and populates the cache", async () => {
      const mockFetch = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify(validPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

      let mockNow = 1000;
      const release1 = await getLatestAntigravityRelease({
        fetchFn: mockFetch as unknown as typeof fetch,
        now: () => mockNow,
        platform: "linux",
        arch: "x64",
      });

      expect(release1.version).toBe("1.5.11");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        AGY_LATEST_RELEASE_URL,
        expect.objectContaining({
          headers: {
            "User-Agent": "HealthLog",
            Accept: "application/vnd.github+json",
          },
        }),
        expect.objectContaining({
          requirePublicHost: true,
          followRedirects: true,
        }),
      );

      // Second call within TTL should return cached release without another fetch
      mockNow += 60_000; // 1 minute later (< 5 minutes TTL)
      const release2 = await getLatestAntigravityRelease({
        fetchFn: mockFetch as unknown as typeof fetch,
        now: () => mockNow,
        platform: "linux",
        arch: "x64",
      });

      expect(release2).toEqual(release1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // forceFresh should bypass the cache
      const release3 = await getLatestAntigravityRelease({
        fetchFn: mockFetch as unknown as typeof fetch,
        now: () => mockNow,
        forceFresh: true,
        platform: "linux",
        arch: "x64",
      });

      expect(release3.version).toBe("1.5.11");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("shares a single in-flight Promise between concurrent requests", async () => {
      let resolveFetch!: (res: Response) => void;
      const mockFetch = vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const p1 = getLatestAntigravityRelease({
        fetchFn: mockFetch as unknown as typeof fetch,
        platform: "linux",
        arch: "x64",
      });
      const p2 = getLatestAntigravityRelease({
        fetchFn: mockFetch as unknown as typeof fetch,
        platform: "linux",
        arch: "x64",
      });

      resolveFetch(
        new Response(JSON.stringify(validPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(r2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles GitHub rate limits (403/429) safely without leaking response body", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("upstream secret error details here", {
          status: 403,
          headers: { "X-RateLimit-Remaining": "0" },
        }),
      );

      await expect(
        getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("GitHub releases API rate limit exceeded");

      // Verify upstream error body was not leaked in error message
      try {
        await getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          platform: "linux",
          arch: "x64",
        });
      } catch (err) {
        expect((err as Error).message).not.toContain("upstream secret");
      }
    });

    it("handles 404 not found cleanly", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("not found", {
          status: 404,
        }),
      );

      await expect(
        getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("No Antigravity CLI release found on GitHub");
    });

    it("handles network failures cleanly", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection reset"));

      await expect(
        getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("Failed to reach GitHub releases API");
    });

    it("caches lookup failures for bounded TTL to prevent rate limit hammering", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));
      let mockNow = 1000;

      // First call fails and caches the error
      await expect(
        getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          now: () => mockNow,
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("Failed to reach GitHub releases API");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call 1 minute later within 5-min TTL should throw cached error without fetch
      mockNow += 60_000;
      await expect(
        getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          now: () => mockNow,
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("Failed to reach GitHub releases API");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // forceFresh should bypass the cached failure and attempt fetch again
      await expect(
        getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          now: () => mockNow,
          forceFresh: true,
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("Failed to reach GitHub releases API");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After TTL expires, a new fetch should be attempted
      mockNow += RELEASE_CACHE_TTL_MS + 1000;
      await expect(
        getLatestAntigravityRelease({
          fetchFn: mockFetch as unknown as typeof fetch,
          now: () => mockNow,
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("Failed to reach GitHub releases API");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("uses a reasonable default request timeout of 5 seconds", async () => {
      const mockFetch = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify(validPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

      await getLatestAntigravityRelease({
        fetchFn: mockFetch as unknown as typeof fetch,
        platform: "linux",
        arch: "x64",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        AGY_LATEST_RELEASE_URL,
        expect.anything(),
        expect.objectContaining({
          timeoutMs: 5_000,
        }),
      );
    });
  });
});
