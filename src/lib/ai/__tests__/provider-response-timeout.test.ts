/**
 * Every exported resolver hands out providers carrying the record owner's
 * response-timeout setting. This is the end of the pipe that makes the
 * setting unforgettable at the call site: the surface functions never see it,
 * the provider they are given already does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
}));

import { prisma } from "@/lib/db";
import {
  resolveProvider,
  resolveProviderChain,
  resolveProviderForTest,
} from "../provider";

const LOCAL_ROW = {
  aiProvider: "LOCAL",
  aiModel: "llama",
  aiBaseUrl: "https://llm.example.org/v1",
  aiAnthropicKeyEncrypted: null,
  aiLocalKeyEncrypted: null,
  aiOpenaiKeyEncrypted: null,
  aiCompatBaseUrl: null,
  aiCompatKeyEncrypted: null,
  aiCompatModel: null,
  role: "USER",
  aiProviderChain: [{ providerType: "local", priority: 1, enabled: true }],
  useCentralCodex: false,
  managedProfileAt: null,
};

function withSetting(seconds: number | null) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    ...LOCAL_ROW,
    aiResponseTimeoutSeconds: seconds,
  } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("the resolvers bind the record's response-timeout setting", () => {
  it("resolveProvider", async () => {
    withSetting(300);
    const provider = await resolveProvider("user-1");
    expect(provider.type).toBe("local");
    expect(provider.responseTimeoutSeconds).toBe(300);
  });

  it("resolveProviderChain, every entry", async () => {
    withSetting(300);
    const chain = await resolveProviderChain("user-1", null);
    expect(chain.length).toBeGreaterThan(0);
    for (const entry of chain) {
      expect(entry.instance.responseTimeoutSeconds).toBe(300);
    }
  });

  it("resolveProviderForTest, so the connection test waits as long as a read", async () => {
    withSetting(300);
    const provider = await resolveProviderForTest("user-1", {
      provider: "LOCAL",
    });
    expect(provider.responseTimeoutSeconds).toBe(300);
  });

  it("binds nothing when the setting is unset", async () => {
    withSetting(null);
    const provider = await resolveProvider("user-1");
    expect(provider.responseTimeoutSeconds).toBeNull();
  });
});
