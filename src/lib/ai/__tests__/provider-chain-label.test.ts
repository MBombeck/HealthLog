/**
 * #1404 — every entry `resolveProviderChain` hands out carries the label of
 * the chain it came from, so each call it makes is logged under that chain
 * (`chain-call-log.ts`): a capability attached to a named chain is `pinned`,
 * one following a named default is `default`, everything else `main`.
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
vi.mock("../chain-call-log", async (importActual) => {
  const actual = await importActual<typeof import("../chain-call-log")>();
  return {
    ...actual,
    logChainCalls: vi.fn((provider: unknown) => provider),
  };
});

import { prisma } from "@/lib/db";
import { logChainCalls } from "../chain-call-log";
import { resolveProviderChain } from "../provider";

/** A user row with just the columns the resolver reads. */
type UserRow = NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
const userRow = (row: Partial<UserRow>): UserRow => row as UserRow;

const ROW = userRow({
  aiProvider: "OPENAI_COMPATIBLE",
  aiModel: "shared",
  aiLocalBaseUrl: "https://llm.example.org/v1",
  aiLocalModel: "local-model",
  aiAnthropicKeyEncrypted: "anthropic-key",
  aiLocalKeyEncrypted: null,
  aiOpenaiKeyEncrypted: null,
  aiCompatBaseUrl: "https://gateway.example.org/v1",
  aiCompatKeyEncrypted: null,
  aiCompatModel: "gateway-model",
  role: "USER",
  aiProviderChain: [
    { providerType: "openai-compatible", priority: 1, enabled: true },
  ],
  aiNamedChains: {
    chains: [
      { id: "localonly", name: "Local only", entries: ["local"] },
      {
        id: "cloud",
        name: "Cloud",
        entries: ["openai-compatible", "local"],
      },
    ],
    defaultChainId: "cloud",
    attachments: { documentAi: "localonly" },
  },
  useCentralCodex: false,
  managedProfileAt: null,
  aiResponseTimeoutSeconds: null,
});

beforeEach(() => {
  vi.mocked(logChainCalls).mockClear();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(ROW);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
});

function labels() {
  return vi.mocked(logChainCalls).mock.calls.map(([, type, label]) => ({
    type,
    ...label,
  }));
}

describe("resolveProviderChain labels its entries", () => {
  it("as pinned for a capability attached to a named chain", async () => {
    await resolveProviderChain("user-1", "documentAi");
    expect(labels()).toEqual([
      { type: "local", chain: "pinned:localonly", capability: "documentAi" },
    ]);
  });

  it("as the named default for a capability left unattached", async () => {
    await resolveProviderChain("user-1", "coach");
    expect(labels()).toEqual([
      {
        type: "openai-compatible",
        chain: "default:cloud",
        capability: "coach",
      },
      { type: "local", chain: "default:cloud", capability: "coach" },
    ]);
  });

  it("as main without named chains", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({ ...ROW, aiNamedChains: null }),
    );
    await resolveProviderChain("user-1", null);
    expect(labels()).toEqual([
      { type: "openai-compatible", chain: "main", capability: null },
    ]);
  });
});
