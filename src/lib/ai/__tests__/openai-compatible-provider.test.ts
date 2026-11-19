import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resolution for the OpenAI-compatible gateway provider (#470).
 *
 * The claim this file has to keep true: the gateway resolves against the base
 * URL the user saved, and the pinned OpenAI arm cannot see that base URL or
 * be redirected by it. Both are asserted at the wire — each test resolves a
 * provider and runs a completion through a stubbed transport, so what is
 * checked is the request that would actually leave the process.
 */

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
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => undefined),
}));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});

import {
  AITestConfigError,
  resolveProvider,
  resolveProviderAvailability,
  resolveProviderChain,
  resolveProviderForTest,
} from "../provider";
import {
  PROVIDER_CHAIN_DEFAULT,
  PROVIDER_CHAIN_TYPES,
} from "../provider-chain";
import { singleUserTurn } from "../types";
import { prisma } from "@/lib/db";

/** A user row with every AI column present, overridable per test. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    aiProvider: null,
    aiModel: null,
    aiLocalBaseUrl: null,
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiCompatBaseUrl: null,
    aiCompatKeyEncrypted: null,
    aiCompatModel: null,
    aiProviderChain: null,
    useCentralCodex: false,
    codexConnectionStatus: null,
    codexAccessTokenEncrypted: null,
    codexRefreshTokenEncrypted: null,
    ...overrides,
  } as never;
}

function stubTransport() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 1 },
      }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const probe = () =>
  singleUserTurn({ system: "s", user: "u", responseFormat: "json" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
});

describe("the gateway resolves against its own columns", () => {
  it("posts to the saved base URL with the saved bearer and model", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiProvider: "OPENAI_COMPATIBLE",
        aiCompatBaseUrl: "https://litellm.example.com/v1",
        aiCompatKeyEncrypted: "enc-gateway",
        aiCompatModel: "anthropic/claude-sonnet-4-6",
      }),
    );

    const provider = await resolveProvider("u-1");
    const result = await provider.generateCompletion(probe());

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://litellm.example.com/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer decrypted:enc-gateway",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(result.providerType).toBe("openai-compatible");
  });

  it("works with no bearer at all — a gateway may need none", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiProvider: "OPENAI_COMPATIBLE",
        aiCompatBaseUrl: "https://gateway.example.com/v1",
        aiCompatModel: "qwen2.5",
      }),
    );

    const provider = await resolveProvider("u-1");
    await provider.generateCompletion(probe());

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      "Authorization",
    );
  });

  it("falls back to the shared model when no gateway model is set", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiProvider: "OPENAI_COMPATIBLE",
        aiModel: "shared-model",
        aiCompatBaseUrl: "https://gateway.example.com/v1",
      }),
    );

    const provider = await resolveProvider("u-1");
    await provider.generateCompletion(probe());

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      "shared-model",
    );
  });
});

describe("the pinned OpenAI arm never reads the gateway's base URL", () => {
  it("still posts to api.openai.com when a gateway base URL is saved", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiProvider: "OPENAI",
        aiOpenaiKeyEncrypted: "enc-openai",
        // A configured gateway sits right there in the row.
        aiCompatBaseUrl: "https://attacker.example.com/v1",
        aiCompatKeyEncrypted: "enc-gateway",
      }),
    );

    const provider = await resolveProvider("u-1");
    await provider.generateCompletion(probe());

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer decrypted:enc-openai",
    );
  });

  it("resolves the chain's openai entry against api.openai.com regardless of the gateway", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiOpenaiKeyEncrypted: "enc-openai",
        aiCompatBaseUrl: "https://attacker.example.com/v1",
        aiProviderChain: [
          { providerType: "openai", priority: 1, enabled: true },
        ],
      }),
    );

    const chain = await resolveProviderChain("u-1", null);
    expect(chain).toHaveLength(1);
    await chain[0].instance.generateCompletion(probe());

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("keeps the test endpoint's OpenAI arm pinned too", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiProvider: "OPENAI",
        aiOpenaiKeyEncrypted: "enc-openai",
        aiCompatBaseUrl: "https://attacker.example.com/v1",
      }),
    );

    const provider = await resolveProviderForTest("u-1", {});
    await provider.generateCompletion(probe());

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("never sends the OpenAI key to the gateway", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiProvider: "OPENAI_COMPATIBLE",
        aiOpenaiKeyEncrypted: "enc-openai",
        aiCompatBaseUrl: "https://gateway.example.com/v1",
        aiCompatModel: "m",
      }),
    );

    const provider = await resolveProvider("u-1");
    await provider.generateCompletion(probe());

    const authorization = fetchMock.mock.calls[0][1].headers.Authorization;
    expect(authorization).toBeUndefined();
  });
});

describe("an unconfigured gateway entry is skipped, not an error", () => {
  it("drops the chain entry when no base URL is saved", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiCompatModel: "m",
        aiProviderChain: [
          { providerType: "openai-compatible", priority: 1, enabled: true },
        ],
      }),
    );

    await expect(resolveProviderChain("u-1", null)).resolves.toEqual([]);
  });

  it("drops the chain entry when no model can be resolved", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiCompatBaseUrl: "https://gateway.example.com/v1",
        aiProviderChain: [
          { providerType: "openai-compatible", priority: 1, enabled: true },
        ],
      }),
    );

    await expect(resolveProviderChain("u-1", null)).resolves.toEqual([]);
  });

  it("resolves the entry once both are present", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiCompatBaseUrl: "https://gateway.example.com/v1",
        aiCompatModel: "m",
        aiProviderChain: [
          { providerType: "openai-compatible", priority: 1, enabled: true },
        ],
      }),
    );

    const chain = await resolveProviderChain("u-1", null);
    expect(chain.map((e) => e.providerType)).toEqual(["openai-compatible"]);
  });
});

describe("chain vocabulary", () => {
  it("offers the gateway as a chain type", () => {
    expect(PROVIDER_CHAIN_TYPES).toContain("openai-compatible");
  });

  it("keeps it out of the default chain — it can only resolve once configured", () => {
    expect(
      PROVIDER_CHAIN_DEFAULT.map((entry) => entry.providerType),
    ).not.toContain("openai-compatible");
  });
});

describe("availability reporting", () => {
  it("reports a configured gateway as the user's own provider", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiCompatBaseUrl: "https://gateway.example.com/v1",
        aiCompatModel: "m",
        aiProviderChain: [
          { providerType: "openai-compatible", priority: 1, enabled: true },
        ],
      }),
    );

    await expect(resolveProviderAvailability("u-1")).resolves.toEqual({
      aiAvailable: true,
      managedBy: "user",
    });
  });
});

describe("the connection test's gateway arm", () => {
  it("refuses a private base URL the operator has not allowlisted", async () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "");
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({
        aiProvider: "OPENAI_COMPATIBLE",
        aiCompatBaseUrl: "http://169.254.169.254/v1",
        aiCompatModel: "m",
      }),
    );

    await expect(
      resolveProviderForTest("u-1", { provider: "OPENAI_COMPATIBLE" }),
    ).rejects.toBeInstanceOf(AITestConfigError);
    vi.unstubAllEnvs();
  });

  it("refuses an unsaved gateway config with no base URL", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(userRow());

    await expect(
      resolveProviderForTest("u-1", { provider: "OPENAI_COMPATIBLE" }),
    ).rejects.toThrow(/base URL/i);
  });

  it("refuses an unsaved gateway config with no model", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(userRow());

    await expect(
      resolveProviderForTest("u-1", {
        provider: "OPENAI_COMPATIBLE",
        compatBaseUrl: "https://gateway.example.com/v1",
      }),
    ).rejects.toThrow(/model/i);
  });

  it("tests an unsaved gateway config without persisting anything", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(userRow());

    const provider = await resolveProviderForTest("u-1", {
      provider: "OPENAI_COMPATIBLE",
      compatBaseUrl: "https://unsaved.example.com/v1",
      compatKey: "typed-but-unsaved",
      compatModel: "typed-model",
    });
    await provider.generateCompletion(probe());

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://unsaved.example.com/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer typed-but-unsaved",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
