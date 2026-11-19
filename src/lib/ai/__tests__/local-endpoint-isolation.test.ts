/**
 * #1417 — Local's base URL is no longer cleared when another provider is
 * selected, so the guarantee that a cloud key never reaches that address now
 * rests on the resolvers alone: only the Local arm may read `aiLocalBaseUrl`.
 * This pins it on every path that builds a client — the provider in use, each
 * chain entry, and the connection test — for each provider holding a key of
 * its own, with a Local address parked on the row the whole time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { AIProvider } from "../types";
import {
  resolveProvider,
  resolveProviderChain,
  resolveProviderForTest,
} from "../provider";

/** A user row with just the columns the resolver reads. */
type UserRow = NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
const userRow = (row: Partial<UserRow>): UserRow => row as UserRow;

const LAN_HOST = "192.168.1.20";
const LOCAL_URL = `http://${LAN_HOST}:11434/v1`;

function row(aiProvider: string, chain: string[]): UserRow {
  return userRow({
    aiProvider,
    aiModel: "shared-model",
    aiLocalBaseUrl: LOCAL_URL,
    aiLocalModel: "local-model-name",
    aiAnthropicKeyEncrypted: "anthropic-key",
    aiLocalKeyEncrypted: "local-key",
    aiOpenaiKeyEncrypted: "openai-key",
    aiCompatBaseUrl: "https://gateway.example.com/v1",
    aiCompatKeyEncrypted: "compat-key",
    aiCompatModel: "gateway-model",
    role: "ADMIN",
    aiProviderChain: chain.map((providerType, i) => ({
      providerType,
      priority: i + 1,
      enabled: true,
    })),
    aiNamedChains: null,
    useCentralCodex: false,
    managedProfileAt: null,
    aiResponseTimeoutSeconds: null,
    codexConnectionStatus: "disconnected",
    codexAccessTokenEncrypted: null,
    codexRefreshTokenEncrypted: null,
  });
}

/** Everything the client was built with, as one searchable string. */
function wiring(provider: AIProvider): string {
  return JSON.stringify(provider);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
});

const CLOUD = [
  ["OPENAI", "openai"],
  ["ANTHROPIC", "anthropic"],
  ["OPENAI_COMPATIBLE", "openai-compatible"],
] as const;

describe("a cloud key never reaches Local's address", () => {
  it.each(CLOUD)(
    "the provider in use, with %s selected",
    async (selected, chainType) => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        row(selected, [chainType]),
      );
      const provider = await resolveProvider("user-1");
      expect(provider.type).not.toBe("local");
      expect(provider.type).not.toBe("none");
      expect(wiring(provider)).not.toContain(LAN_HOST);
    },
  );

  it("every chain entry but Local's own", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      row("OPENAI_COMPATIBLE", [
        "openai",
        "anthropic",
        "openai-compatible",
        "local",
      ]),
    );
    const chain = await resolveProviderChain("user-1", null);
    expect(chain.map((entry) => entry.providerType)).toEqual([
      "openai",
      "anthropic",
      "openai-compatible",
      "local",
    ]);
    for (const entry of chain) {
      if (entry.providerType === "local") {
        // Local itself gets its address, its model and its own key.
        expect(wiring(entry.instance)).toContain(LOCAL_URL);
        expect(wiring(entry.instance)).toContain("local-model-name");
        expect(wiring(entry.instance)).toContain("decrypted:local-key");
      } else {
        expect(wiring(entry.instance)).not.toContain(LAN_HOST);
      }
    }
  });

  it.each(CLOUD)("the connection test of %s", async (selected, chainType) => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      row("LOCAL", [chainType]),
    );
    const provider = await resolveProviderForTest("user-1", {
      provider: selected,
    });
    expect(provider.type).not.toBe("local");
    expect(wiring(provider)).not.toContain(LAN_HOST);
  });

  it("the Local test reads Local's own address and model", async () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", `http://${LAN_HOST}:11434`);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      row("OPENAI_COMPATIBLE", ["openai-compatible"]),
    );
    const provider = await resolveProviderForTest("user-1", {
      provider: "LOCAL",
    });
    expect(provider.type).toBe("local");
    expect(wiring(provider)).toContain(LOCAL_URL);
    expect(wiring(provider)).toContain("local-model-name");
    expect(wiring(provider)).not.toContain("decrypted:openai-key");
    expect(wiring(provider)).not.toContain("decrypted:compat-key");
  });
});
