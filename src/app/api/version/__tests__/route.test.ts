import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

const offlineGeoReadyMock = vi.fn(() => false);
vi.mock("@/lib/geo", () => ({
  offlineGeoReady: () => offlineGeoReadyMock(),
}));

import { GET } from "../route";

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_BUILD_SHA;
  delete process.env.NEXT_PUBLIC_APP_BUILT_AT;
  offlineGeoReadyMock.mockReturnValue(false);
});

interface VersionEnvelope {
  data: {
    version: string;
    buildSha: string | null;
    builtAt: string | null;
    license: string;
    repository: string;
    changelog: string;
    docs: string;
    offlineGeoEnabled: boolean;
  };
}

describe("GET /api/version", () => {
  it("returns the package.json version", async () => {
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.version).toMatch(/^\d+\.\d+\.\d+(\.\d+)?(-[a-z0-9.-]+)?$/i);
    expect(body.data.license).toBe("AGPL-3.0");
    expect(body.data.repository).toContain("github.com");
    expect(body.data.changelog).toContain("CHANGELOG");
    expect(body.data.docs).toContain("docs.healthlog.dev");
  });

  it("returns null buildSha / builtAt for a `pnpm dev` build", async () => {
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.buildSha).toBeNull();
    expect(body.data.builtAt).toBeNull();
  });

  it("surfaces the build SHA and timestamp when the env vars are set", async () => {
    process.env.NEXT_PUBLIC_APP_BUILD_SHA = "abc1234";
    process.env.NEXT_PUBLIC_APP_BUILT_AT = "2026-05-08T12:00:00.000Z";
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.buildSha).toBe("abc1234");
    expect(body.data.builtAt).toBe("2026-05-08T12:00:00.000Z");
  });

  it("reports offlineGeoEnabled=false when the GeoLite2 databases are absent", async () => {
    offlineGeoReadyMock.mockReturnValue(false);
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.offlineGeoEnabled).toBe(false);
  });

  it("reports offlineGeoEnabled=true when the GeoLite2 databases are present", async () => {
    offlineGeoReadyMock.mockReturnValue(true);
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.offlineGeoEnabled).toBe(true);
  });
});
