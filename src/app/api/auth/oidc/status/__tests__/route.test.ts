import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/oidc", () => ({
  getOidcConfig: vi.fn(),
  isOidcOnly: vi.fn(() => false),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

import { GET } from "../route";
import { getOidcConfig, isOidcOnly } from "@/lib/auth/oidc";

const CONFIG = {
  issuerUrl: "https://idp.example.com",
  clientId: "client-1",
  clientSecret: "x",
  scopes: "openid email profile",
  buttonLabel: "SSO",
};

async function status(): Promise<Record<string, unknown>> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

beforeEach(() => {
  vi.mocked(isOidcOnly).mockReturnValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/auth/oidc/status — nativeReturnPath", () => {
  it("announces the fixed https return path on an https instance with SSO on", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://healthlog.example.com");
    vi.mocked(getOidcConfig).mockReturnValue(CONFIG);
    expect(await status()).toEqual({
      enabled: true,
      buttonLabel: "SSO",
      only: false,
      nativeReturnPath: "/auth/native-return",
    });
  });

  it("announces none on an instance served over plain http", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://192.168.1.10:3000");
    vi.mocked(getOidcConfig).mockReturnValue(CONFIG);
    expect((await status()).nativeReturnPath).toBeNull();
  });

  it("announces none while SSO is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://healthlog.example.com");
    vi.mocked(getOidcConfig).mockReturnValue(null);
    expect((await status()).nativeReturnPath).toBeNull();
  });
});
