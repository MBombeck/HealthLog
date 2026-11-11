import { describe, it, expect, vi, beforeEach } from "vitest";

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
  encryptCodexCreds: vi.fn(
    (c: { accessToken: string; refreshToken: string; accountId: string }) => ({
      accessEncrypted: `enc:${c.accessToken}|${c.accountId}`,
      refreshEncrypted: `enc:${c.refreshToken}`,
    }),
  ),
  decryptCodexCreds: vi.fn(),
}));

import {
  resolveProvider,
  resolveProviderForTest,
  resolveProviderAvailability,
} from "../provider";
import { OpenAIClient } from "../openai-client";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { decryptCodexCreds, encryptCodexCreds } from "@/lib/ai/codex-oauth";

/**
 * resolveProvider() makes up to TWO findUnique calls per invocation:
 *   1. Read user-level AI config (aiProvider/...).
 *   2. If falling back to codex, read codex token fields.
 * We use mockResolvedValueOnce in order so each call returns the right shape.
 */

describe("resolveProvider", () => {
  beforeEach(() => {
    // Reset mocks AND mockResolvedValueOnce queues, then re-establish
    // the deterministic factory implementations for crypto/oauth helpers.
    vi.resetAllMocks();
    vi.mocked(decrypt).mockImplementation((v: string) => `decrypted:${v}`);
    vi.mocked(encrypt).mockImplementation((v: string) => `encrypted:${v}`);
    vi.mocked(encryptCodexCreds).mockImplementation(
      (c: {
        accessToken: string;
        refreshToken: string;
        accountId: string;
      }) => ({
        accessEncrypted: `enc:${c.accessToken}|${c.accountId}`,
        refreshEncrypted: `enc:${c.refreshToken}`,
      }),
    );
  });

  it("returns codex provider when user has valid tokens (no explicit choice)", async () => {
    vi.mocked(decryptCodexCreds).mockReturnValue({
      accessToken: "oauth-access",
      refreshToken: "decrypted-refresh",
      accountId: "acct-123",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    vi.mocked(prisma.user.findUnique)
      // 1st call: user AI config — none selected
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      // 2nd call: codex tokens
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: "enc-access",
        codexRefreshTokenEncrypted: "enc-refresh",
        codexTokenExpiresAt: new Date(Date.now() + 3600000),
        codexConnectionStatus: "connected",
      } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("codex");
  });

  it("returns admin-key when user has no codex but admin key exists", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectionStatus: "disconnected",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin-key",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("returns none when nothing is configured", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectionStatus: "disconnected",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("none");
  });

  it("falls back to admin-key when codex status is expired", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: "enc-access",
        codexRefreshTokenEncrypted: "enc-refresh",
        codexTokenExpiresAt: new Date(Date.now() - 1000),
        codexConnectionStatus: "expired",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("returns Anthropic provider when user picks ANTHROPIC and has key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "ANTHROPIC",
      aiModel: "claude-3-5-sonnet-latest",
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: "enc-anthropic-key",
      aiLocalKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("anthropic");
    // Codex/admin lookups must NOT happen when user provider resolved.
    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
  });

  it("falls back when user picks ANTHROPIC but has no key", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: "ANTHROPIC",
        aiModel: "claude-3-5-sonnet-latest",
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: null,
        codexConnectionStatus: "disconnected",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    // ANTHROPIC explicit choice ≠ CHATGPT_OAUTH/null → codex branch is skipped.
    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("returns Local provider when user picks LOCAL with baseUrl", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "LOCAL",
      aiModel: "llama3:8b",
      aiBaseUrl: "http://localhost:11434/v1",
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("local");
  });

  it("OPENAI selection routes through admin OpenAI key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "OPENAI",
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
    } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("OPENAI with user key ignores stored aiBaseUrl (provider-leak guard)", async () => {
    // Regression for v1.4.6 T4: a user who had configured LOCAL with a
    // private LAN URL and later switched to OPENAI must NOT have their
    // OpenAI key forwarded to that URL. The persisted `aiBaseUrl` is
    // shared across providers, so `buildUserProvider` hardcodes
    // api.openai.com for OPENAI regardless of what the column carries.
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "OPENAI",
      aiModel: null,
      aiBaseUrl: "http://192.168.0.42/v1", // stale LOCAL value
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-user-openai-key",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
    const inspect = provider as unknown as {
      config: { baseUrl: string };
    };
    expect(inspect.config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("ANTHROPIC ignores stored aiBaseUrl (provider-leak guard)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "ANTHROPIC",
      aiModel: "claude-3-5-sonnet-latest",
      aiBaseUrl: "http://192.168.0.42/v1", // stale LOCAL value
      aiAnthropicKeyEncrypted: "enc-user-anthropic-key",
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("anthropic");
    // AnthropicClient should default to its SDK baseUrl, never the LAN URL.
    const inspect = provider as unknown as {
      config: { baseUrl?: string };
    };
    expect(inspect.config.baseUrl).toBeUndefined();
  });

  it("CHATGPT_OAUTH selection routes through Codex when connected", async () => {
    vi.mocked(decryptCodexCreds).mockReturnValue({
      accessToken: "oauth-access",
      refreshToken: "decrypted-refresh",
      accountId: "acct-123",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: "CHATGPT_OAUTH",
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: "enc-access",
        codexRefreshTokenEncrypted: "enc-refresh",
        codexTokenExpiresAt: new Date(Date.now() + 3600000),
        codexConnectionStatus: "connected",
      } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("codex");
  });
});

/**
 * The connection-test "test my saved config" path (empty override body)
 * MUST resolve via the SAME chain generation uses, so a green test means
 * generation will actually work. Previously it probed codex→admin
 * directly, which could test a different provider than generation ran.
 */
describe("resolveProviderForTest — empty override resolves via the chain", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(decrypt).mockImplementation((v: string) => `decrypted:${v}`);
  });

  it("returns the first enabled+credentialed chain entry (the same provider generation runs)", async () => {
    // resolveProviderForTest first reads the test row (no chain), then
    // resolveProviderChain reads the chain row. The chain enables openai
    // and the user has an OpenAI key → first chain entry is OpenAIClient.
    vi.mocked(prisma.user.findUnique)
      // 1st: resolveProviderForTest's own read
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "enc-user-openai",
      } as never)
      // 2nd: resolveProviderChain's read
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "enc-user-openai",
        aiProviderChain: [
          { providerType: "openai", priority: 1, enabled: true },
        ],
      } as never);

    const provider = await resolveProviderForTest("user-123", {});
    // The user-OpenAI client is an OpenAIClient; its runtime tag defaults
    // to "admin-key" (no providerType passed). What matters is that the
    // empty-override path materialised the chain's first entry rather than
    // the legacy codex→admin probe — a NoProvider/none would mean the
    // chain was bypassed.
    expect(provider.type).not.toBe("none");
    expect(provider).toBeInstanceOf(OpenAIClient);
  });

  it("answers no provider, which the route names, when the chain resolves empty", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
      aiProviderChain: [{ providerType: "openai", priority: 1, enabled: true }],
    } as never);

    const provider = await resolveProviderForTest("user-123", {});
    expect(provider.type).toBe("none");
  });
});

describe("resolveProviderAvailability", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const emptyUserRow = {
    aiProvider: null,
    aiProviderChain: null,
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiBaseUrl: null,
    codexConnectionStatus: null,
    codexAccessTokenEncrypted: null,
    codexRefreshTokenEncrypted: null,
  };

  it("returns managedBy:user when the user holds a BYO key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...emptyUserRow,
      aiOpenaiKeyEncrypted: "enc-user-openai",
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as never);

    const result = await resolveProviderAvailability("user-123");
    expect(result).toEqual({ aiAvailable: true, managedBy: "user" });
  });

  it("returns managedBy:server when only an admin-managed key is present", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...emptyUserRow,
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin-key",
    } as never);

    const result = await resolveProviderAvailability("user-123");
    expect(result).toEqual({ aiAvailable: true, managedBy: "server" });
  });

  it("returns managedBy:local when the user set a self-hosted base URL", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...emptyUserRow,
      aiProvider: "LOCAL",
      aiBaseUrl: "https://ollama.example/v1",
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as never);

    const result = await resolveProviderAvailability("user-123");
    expect(result).toEqual({ aiAvailable: true, managedBy: "local" });
  });

  it("prefers a personal credential over the admin key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...emptyUserRow,
      aiAnthropicKeyEncrypted: "enc-anthropic",
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin-key",
    } as never);

    const result = await resolveProviderAvailability("user-123");
    expect(result).toEqual({ aiAvailable: true, managedBy: "user" });
  });

  it("returns aiAvailable:false + managedBy:null when nothing is configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...emptyUserRow,
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as never);

    const result = await resolveProviderAvailability("user-123");
    expect(result).toEqual({ aiAvailable: false, managedBy: null });
  });

  it("returns aiAvailable:false when the user row is missing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    const result = await resolveProviderAvailability("user-123");
    expect(result).toEqual({ aiAvailable: false, managedBy: null });
  });
});
