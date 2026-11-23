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
  decryptAdminCodexCreds: vi.fn(),
}));

import {
  resolveProviderChain,
  resolveProviderForTest,
  resolveProviderAvailability,
} from "../provider";
import { OpenAIClient } from "../openai-client";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import {
  decryptAdminCodexCreds,
  decryptCodexCreds,
  encryptCodexCreds,
} from "@/lib/ai/codex-oauth";

/** Every column `resolveProviderChain` selects, with nothing configured. */
const EMPTY_USER = {
  aiProvider: null,
  aiModel: null,
  aiLocalBaseUrl: null,
  aiLocalModel: null,
  aiAnthropicKeyEncrypted: null,
  aiLocalKeyEncrypted: null,
  aiOpenaiKeyEncrypted: null,
  aiCompatBaseUrl: null,
  aiCompatKeyEncrypted: null,
  aiCompatModel: null,
  role: "USER",
  aiProviderChain: null,
  aiNamedChains: null,
  useCentralCodex: false,
  managedProfileAt: null,
  aiResponseTimeoutSeconds: null,
};

const DISCONNECTED_CODEX = {
  codexAccessTokenEncrypted: null,
  codexRefreshTokenEncrypted: null,
  codexConnectionStatus: "disconnected",
};

/**
 * The chain reads the user's AI row once, then the Codex columns when its
 * `codex` entry is tried. The two reads are told apart by what they select,
 * so the order the chain walks its entries in does not matter to the mock.
 */
function mockUser(
  user: Record<string, unknown>,
  codex: Record<string, unknown> = DISCONNECTED_CODEX,
) {
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
    select?: Record<string, unknown>;
  }) =>
    args?.select && "codexAccessTokenEncrypted" in args.select
      ? codex
      : { ...EMPTY_USER, ...user }) as never);
}

function mockAdminKey(model = "gpt-4o-mini") {
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    adminAiKeyEncrypted: "enc-admin-key",
    adminAiModel: model,
    adminAiBaseUrl: "https://api.openai.com/v1",
  } as never);
}

const types = async () =>
  (await resolveProviderChain("user-123", null)).map((e) => e.providerType);

describe("resolveProviderChain — the default chain", () => {
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
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  });

  function connectCodex() {
    vi.mocked(decryptCodexCreds).mockReturnValue({
      accessToken: "access",
      refreshToken: "refresh",
      accountId: "acct-123",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return {
      codexAccessTokenEncrypted: "enc-access",
      codexRefreshTokenEncrypted: "enc-refresh",
      codexConnectionStatus: "connected",
    };
  }

  it("leads with Codex when the user has valid tokens and nothing picked", async () => {
    mockUser({}, connectCodex());
    mockAdminKey();

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual(["codex", "admin-openai"]);
    expect(chain[0].instance.type).toBe("codex");
  });

  it("serves the admin key when the user has no Codex connection", async () => {
    mockUser({});
    mockAdminKey();

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual(["admin-openai"]);
    expect(chain[0].instance.type).toBe("admin-key");
  });

  it("is empty when nothing is configured", async () => {
    mockUser({});
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as never);

    await expect(resolveProviderChain("user-123", null)).resolves.toEqual([]);
  });

  it("drops an expired Codex connection and serves the admin key", async () => {
    mockUser(
      {},
      {
        codexAccessTokenEncrypted: "enc-access",
        codexRefreshTokenEncrypted: "enc-refresh",
        codexConnectionStatus: "expired",
      },
    );
    mockAdminKey("gpt-4o");

    expect(await types()).toEqual(["admin-openai"]);
  });

  it("puts the user's Anthropic key ahead of the admin key", async () => {
    mockUser({
      aiProvider: "ANTHROPIC",
      aiModel: "claude-3-5-sonnet-latest",
      aiAnthropicKeyEncrypted: "enc-anthropic-key",
    });
    mockAdminKey();

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual([
      "anthropic",
      "admin-openai",
    ]);
    expect(chain[0].instance.type).toBe("anthropic");
  });

  it("drops the Anthropic entry when the user picked ANTHROPIC but has no key", async () => {
    mockUser({ aiProvider: "ANTHROPIC", aiModel: "claude-3-5-sonnet-latest" });
    mockAdminKey();

    expect(await types()).toEqual(["admin-openai"]);
  });

  it("serves Local when the user picked LOCAL with a base URL", async () => {
    mockUser({
      aiProvider: "LOCAL",
      aiModel: "llama3:8b",
      aiLocalBaseUrl: "http://localhost:11434/v1",
    });

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual(["local"]);
    expect(chain[0].instance.type).toBe("local");
  });

  it("an OPENAI pick without a personal key is served by the admin key", async () => {
    mockUser({ aiProvider: "OPENAI" });
    mockAdminKey();

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual(["admin-openai"]);
    expect(chain[0].instance.type).toBe("admin-key");
  });

  it("the openai entry ignores a stored aiLocalBaseUrl (provider-leak guard)", async () => {
    // Regression for v1.4.6 T4: a user who had configured LOCAL with a
    // private LAN URL and later switched to OPENAI must NOT have their
    // OpenAI key forwarded to that URL. The persisted `aiLocalBaseUrl` stays
    // set (#1417), so the openai entry hardcodes api.openai.com, and the
    // main chain's Local entry stays out while another provider is picked.
    mockUser({
      aiProvider: "OPENAI",
      aiLocalBaseUrl: "http://192.168.0.42/v1", // stale LOCAL value
      aiOpenaiKeyEncrypted: "enc-user-openai-key",
    });

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual(["openai"]);
    const inspect = chain[0].instance as unknown as {
      config: { baseUrl: string };
    };
    expect(inspect.config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("the anthropic entry ignores a stored aiLocalBaseUrl (provider-leak guard)", async () => {
    mockUser({
      aiProvider: "ANTHROPIC",
      aiModel: "claude-3-5-sonnet-latest",
      aiLocalBaseUrl: "http://192.168.0.42/v1", // stale LOCAL value
      aiAnthropicKeyEncrypted: "enc-user-anthropic-key",
    });

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual(["anthropic"]);
    // AnthropicClient should default to its SDK baseUrl, never the LAN URL.
    const inspect = chain[0].instance as unknown as {
      config: { baseUrl?: string };
    };
    expect(inspect.config.baseUrl).toBeUndefined();
  });

  it("a CHATGPT_OAUTH pick is served by Codex when connected", async () => {
    mockUser({ aiProvider: "CHATGPT_OAUTH" }, connectCodex());

    const chain = await resolveProviderChain("user-123", null);
    expect(chain.map((e) => e.providerType)).toEqual(["codex"]);
    expect(chain[0].instance.type).toBe("codex");
  });

  it("follows the saved chain's order, not the picked provider", async () => {
    mockUser({
      aiProvider: "ANTHROPIC",
      aiAnthropicKeyEncrypted: "enc-anthropic-key",
      aiOpenaiKeyEncrypted: "enc-openai-key",
      aiProviderChain: [
        { providerType: "openai", priority: 1, enabled: true },
        { providerType: "anthropic", priority: 2, enabled: true },
      ],
    });

    expect(await types()).toEqual(["openai", "anthropic"]);
  });

  it("appends the central Codex last, and only behind the opt-in", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockImplementation((async (args: {
      select?: Record<string, unknown>;
    }) =>
      args?.select && "adminCodexConnectionStatus" in args.select
        ? {
            adminCodexConnectionStatus: "connected",
            adminCodexAccessTokenEncrypted: "enc-a",
            adminCodexRefreshTokenEncrypted: "enc-r",
            adminCodexAccountIdEncrypted: "enc-id",
            adminCodexTokenExpiresAt: new Date(Date.now() + 3600_000),
          }
        : null) as never);
    vi.mocked(decryptAdminCodexCreds).mockReturnValue({
      accessToken: "access",
      refreshToken: "refresh",
      accountId: "acct-central",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    mockUser({ aiAnthropicKeyEncrypted: "enc-anthropic-key" });
    expect(await types()).toEqual(["anthropic"]);

    mockUser({
      aiAnthropicKeyEncrypted: "enc-anthropic-key",
      useCentralCodex: true,
    });
    expect(await types()).toEqual(["anthropic", "admin-codex"]);
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
        aiLocalBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "enc-user-openai",
      } as never)
      // 2nd: resolveProviderChain's read
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiLocalBaseUrl: null,
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
      aiLocalBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
      aiProviderChain: [{ providerType: "openai", priority: 1, enabled: true }],
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

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
    aiLocalBaseUrl: null,
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
      aiLocalBaseUrl: "https://ollama.example/v1",
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
