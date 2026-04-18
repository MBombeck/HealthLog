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
  refreshAccessToken: vi.fn(),
  encryptTokens: vi.fn((t: { accessToken: string; refreshToken: string }) => ({
    accessEncrypted: `enc:${t.accessToken}`,
    refreshEncrypted: `enc:${t.refreshToken}`,
  })),
  decryptTokens: vi.fn(),
}));

import { resolveProvider } from "../provider";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import {
  decryptTokens,
  encryptTokens,
} from "@/lib/ai/codex-oauth";

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
    vi.mocked(encryptTokens).mockImplementation(
      (t: { accessToken: string; refreshToken: string }) => ({
        accessEncrypted: `enc:${t.accessToken}`,
        refreshEncrypted: `enc:${t.refreshToken}`,
      }),
    );
  });

  it("returns codex provider when user has valid tokens (no explicit choice)", async () => {
    vi.mocked(decryptTokens).mockReturnValue({
      accessToken: "decrypted-access",
      refreshToken: "decrypted-refresh",
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

  it("CHATGPT_OAUTH selection routes through Codex when connected", async () => {
    vi.mocked(decryptTokens).mockReturnValue({
      accessToken: "decrypted-access",
      refreshToken: "decrypted-refresh",
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
