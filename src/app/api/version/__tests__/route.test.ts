import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

const offlineGeoReadyMock = vi.fn(() => false);
const resolveGeoProviderHostMock = vi.fn(() => "ipwho.is");
vi.mock("@/lib/geo", () => ({
  offlineGeoReady: () => offlineGeoReadyMock(),
  resolveGeoProviderHost: () => resolveGeoProviderHostMock(),
  geoLookupMode: () => (offlineGeoReadyMock() ? "offline" : "online"),
  geoProviderChosen: () => false,
}));

import { GET } from "../route";

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_BUILD_SHA;
  delete process.env.NEXT_PUBLIC_APP_BUILT_AT;
  delete process.env.NEXT_PUBLIC_APP_VERSION;
  offlineGeoReadyMock.mockReturnValue(false);
  resolveGeoProviderHostMock.mockReturnValue("ipwho.is");
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
    geoProviderHost: string;
  };
}

describe("GET /api/version", () => {
  it("returns the package.json version", async () => {
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.version).toMatch(
      /^\d+\.\d+\.\d+(\.\d+)?(-[a-z0-9.-]+)?$/i,
    );
    expect(body.data.license).toBe("PolyForm-Noncommercial-1.0.0");
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

  it("prefers NEXT_PUBLIC_APP_VERSION over package.json when set (v1.4.43 B11)", async () => {
    // Build-arg-injected version wins over the bundled package.json so a
    // BuildKit layer-cache hit on `pnpm build` cannot ship a stale version
    // string. The CI tag ref (`v1.4.43`, etc.) is forwarded straight to
    // the env so the runtime answer can never drift from the release tag.
    process.env.NEXT_PUBLIC_APP_VERSION = "v1.4.43";
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.version).toBe("v1.4.43");
  });

  it("falls through to package.json when NEXT_PUBLIC_APP_VERSION is blank", async () => {
    // A whitespace-only env value must NOT shadow the package.json read --
    // the trim()+OR pattern ensures the fallback still kicks in.
    process.env.NEXT_PUBLIC_APP_VERSION = "   ";
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.version).toMatch(
      /^\d+\.\d+\.\d+(\.\d+)?(-[a-z0-9.-]+)?$/i,
    );
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

  it("surfaces the resolved online geo provider host", async () => {
    resolveGeoProviderHostMock.mockReturnValue("ip-api.com");
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = (await response.json()) as VersionEnvelope;
    expect(body.data.geoProviderHost).toBe("ip-api.com");
  });
});
