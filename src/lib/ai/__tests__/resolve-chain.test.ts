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
vi.mock("@/lib/ai/codex-oauth", () => ({
  refreshDeviceTokens: vi.fn(),
  encryptCodexCreds: vi.fn(),
  decryptCodexCreds: vi.fn(),
}));

import { resolveProviderChain } from "../provider";
import {
  chainWithReasoningEffort,
  PROVIDER_CHAIN_DEFAULT,
} from "../provider-chain";
import { prisma } from "@/lib/db";
import { decryptCodexCreds } from "@/lib/ai/codex-oauth";

beforeEach(() => {
  vi.resetAllMocks();
});

/** Queue the user rows the resolver reads, in the order it reads them. */
function userRows(...rows: Record<string, unknown>[]) {
  const findUnique = vi.mocked(prisma.user.findUnique);
  for (const row of rows) findUnique.mockResolvedValueOnce(row as never);
}

/** The operator's settings row. */
function operator(settings: Record<string, unknown>) {
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(settings as never);
}

describe("resolveProviderChain", () => {
  it("returns the default chain when user.aiProviderChain is null", async () => {
    vi.mocked(decryptCodexCreds).mockReturnValue({
      accessToken: "tok",
      refreshToken: "ref",
      accountId: "acct",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    userRows(
      // user-level config read
      {
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: null,
        aiProviderChain: null,
      },
      // codex tokens read
      {
        codexAccessTokenEncrypted: "enc-a",
        codexRefreshTokenEncrypted: "enc-r",
        codexTokenExpiresAt: new Date(Date.now() + 3600_000),
        codexConnectionStatus: "connected",
      },
    );
    operator({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    });

    const chain = await resolveProviderChain("user-1");
    // Default chain trims out entries with no creds; codex (tokens
    // present) and admin-openai (key present) survive.
    const types = chain.map((c) => c.providerType);
    expect(types).toContain("codex");
    expect(types).toContain("admin-openai");
    // No anthropic/local/openai key configured → those entries dropped.
    expect(types).not.toContain("anthropic");
    expect(types).not.toContain("local");
    expect(types).not.toContain("openai");
  });

  it("respects user-defined chain priority order", async () => {
    userRows({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: "enc-anth",
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-openai",
      // user puts openai first, anthropic second; admin disabled
      aiProviderChain: [
        { providerType: "openai", priority: 1, enabled: true },
        { providerType: "anthropic", priority: 2, enabled: true },
        { providerType: "admin-openai", priority: 3, enabled: false },
      ],
    });
    operator({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    });

    const chain = await resolveProviderChain("user-1");
    const types = chain.map((c) => c.providerType);
    expect(types).toEqual(["openai", "anthropic"]);
  });

  it("filters out chain entries the user has not credentialed", async () => {
    userRows({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null, // no anthropic key
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-openai",
      aiProviderChain: [
        { providerType: "anthropic", priority: 1, enabled: true },
        { providerType: "openai", priority: 2, enabled: true },
      ],
    });
    operator({
      adminAiKeyEncrypted: null,
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    });

    const chain = await resolveProviderChain("user-1");
    const types = chain.map((c) => c.providerType);
    expect(types).toEqual(["openai"]);
  });

  it("skips disabled entries even if the credential is present", async () => {
    userRows({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-openai",
      aiProviderChain: [
        { providerType: "openai", priority: 1, enabled: false }, // disabled
        { providerType: "admin-openai", priority: 2, enabled: true },
      ],
    });
    operator({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    });

    const chain = await resolveProviderChain("user-1");
    const types = chain.map((c) => c.providerType);
    expect(types).toEqual(["admin-openai"]);
  });

  it("returns an empty array when nothing is configured at all", async () => {
    userRows(
      {
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: null,
        aiProviderChain: null,
      },
      {
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectionStatus: "disconnected",
      },
    );
    operator({
      adminAiKeyEncrypted: null,
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    });

    const chain = await resolveProviderChain("user-1");
    expect(chain).toEqual([]);
  });

  it("stays empty on a saved chain with every entry switched off", async () => {
    // Only the local model on, its address missing; the person's own key and
    // the operator's key are both switched off. Nothing may serve behind those
    // switches, however the record's single provider field reads.
    userRows({
      aiProvider: "OPENAI",
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-openai",
      aiProviderChain: [
        { providerType: "local", priority: 1, enabled: true },
        { providerType: "openai", priority: 2, enabled: false },
        { providerType: "admin-openai", priority: 3, enabled: false },
      ],
    });
    operator({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    });

    expect(await resolveProviderChain("user-1")).toEqual([]);
  });
});

describe("resolveProviderChain and the picked gateway", () => {
  const gatewayRow = {
    aiProvider: "OPENAI_COMPATIBLE",
    aiModel: null,
    aiBaseUrl: null,
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiCompatBaseUrl: "https://gateway.example/v1",
    aiCompatKeyEncrypted: null,
    aiCompatModel: "llama-3",
    role: "USER",
  };
  const DEFAULT_SAVED = PROVIDER_CHAIN_DEFAULT.map((entry) => ({ ...entry }));

  /** Serve `chain` as the record's saved chain; Codex is not connected. */
  async function resolveWith(chain: unknown) {
    const read = async (args: { select?: Record<string, unknown> }) =>
      args.select?.codexAccessTokenEncrypted
        ? {
            codexAccessTokenEncrypted: null,
            codexRefreshTokenEncrypted: null,
            codexTokenExpiresAt: null,
            codexConnectionStatus: "disconnected",
          }
        : { ...gatewayRow, aiProviderChain: chain };
    vi.mocked(prisma.user.findUnique).mockImplementation(
      read as unknown as typeof prisma.user.findUnique,
    );
    operator({ adminAiKeyEncrypted: null });
    return (await resolveProviderChain("user-1")).map((c) => c.providerType);
  }

  it.each([
    ["never saved", null],
    ["saved with the default content", DEFAULT_SAVED],
    [
      "reset to the default and saved",
      JSON.parse(JSON.stringify(DEFAULT_SAVED)),
    ],
    ["reordered without the gateway", [...DEFAULT_SAVED].reverse()],
    [
      "holding a reasoning effort the gateway form wrote switched off",
      chainWithReasoningEffort(null, "openai-compatible", "low"),
    ],
    [
      "holding a reasoning effort the gateway form writes now",
      chainWithReasoningEffort(null, "openai-compatible", "low", true),
    ],
  ])("serves the gateway on a chain %s", async (_case, chain) => {
    expect(await resolveWith(chain)).toEqual(["openai-compatible"]);
  });

  it("serves nothing once the person switched the gateway off in the chain", async () => {
    expect(
      await resolveWith([
        ...DEFAULT_SAVED,
        { providerType: "openai-compatible", priority: 6, enabled: false },
      ]),
    ).toEqual([]);
  });
});
