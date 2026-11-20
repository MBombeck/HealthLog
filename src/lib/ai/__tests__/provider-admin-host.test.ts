import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Client selection for the operator's global AI provider.
 *
 * The claim this file keeps true: the admin base URL decides which wire the
 * operator's key rides. An Anthropic host gets the Anthropic Messages wire,
 * everything else keeps the OpenAI chat-completions wire — including an
 * OpenAI-compatible endpoint the operator allowlisted, an unset base URL and
 * a value that does not parse as a URL. Every case is asserted at the wire:
 * the test resolves a provider and runs a completion through a stubbed
 * transport, so what is checked is the request that would leave the process.
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

import { resolveProvider } from "../provider";
import { singleUserTurn } from "../types";
import { prisma } from "@/lib/db";

/** A user with nothing configured, so resolution falls through to the admin key. */
function emptyUserRow() {
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
  } as never;
}

function adminSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: "singleton",
    adminAiKeyEncrypted: "enc-admin-key",
    adminAiModel: null,
    adminAiBaseUrl: null,
    ...overrides,
  } as never;
}

/**
 * One transport stub for both wires: the OpenAI body reads `choices`, the
 * Anthropic body reads `content`, and each client ignores the other's field.
 */
function stubTransport() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 1 },
        content: [{ type: "text", text: '{"ok":true}' }],
      }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const probe = () =>
  singleUserTurn({ system: "s", user: "u", responseFormat: "json" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(emptyUserRow());
});

describe("the admin base URL picks the client", () => {
  it("sends an Anthropic base URL down the Anthropic wire", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(
      adminSettings({
        adminAiBaseUrl: "https://api.anthropic.com/v1",
        adminAiModel: "claude-sonnet-4-6",
      }),
    );

    const provider = await resolveProvider("u-1");
    expect(provider.type).toBe("anthropic");

    const result = await provider.generateCompletion(probe());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("decrypted:enc-admin-key");
    expect(JSON.parse(init.body).model).toBe("claude-sonnet-4-6");
    expect(result.providerType).toBe("anthropic");
  });

  it("treats a subdomain of anthropic.com as Anthropic, case-insensitively", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(
      adminSettings({
        adminAiBaseUrl: "https://API.EU.Anthropic.COM/v1",
        adminAiModel: "claude-sonnet-4-6",
      }),
    );

    const provider = await resolveProvider("u-1");
    expect(provider.type).toBe("anthropic");

    await provider.generateCompletion(probe());
    // The base URL rides through verbatim; only the host MATCH folds case.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://API.EU.Anthropic.COM/v1/messages",
    );
  });

  it("keeps the OpenAI wire for the OpenAI host", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(
      adminSettings({
        adminAiBaseUrl: "https://api.openai.com/v1",
        adminAiModel: "gpt-4o-mini",
      }),
    );

    const provider = await resolveProvider("u-1");
    expect(provider.type).toBe("admin-key");

    await provider.generateCompletion(probe());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer decrypted:enc-admin-key");
    expect(JSON.parse(init.body).model).toBe("gpt-4o-mini");
  });

  it("keeps the OpenAI wire for an OpenAI-compatible endpoint", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(
      adminSettings({
        adminAiBaseUrl: "https://llm.example.com/v1",
        adminAiModel: "llama-3.1-70b",
      }),
    );

    const provider = await resolveProvider("u-1");
    expect(provider.type).toBe("admin-key");

    await provider.generateCompletion(probe());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://llm.example.com/v1/chat/completions",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      "llama-3.1-70b",
    );
  });

  it("keeps the OpenAI default when no base URL is set", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(adminSettings());

    const provider = await resolveProvider("u-1");
    expect(provider.type).toBe("admin-key");

    await provider.generateCompletion(probe());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe("gpt-4o");
  });

  it("keeps the OpenAI path for a base URL that does not parse", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(
      adminSettings({ adminAiBaseUrl: "api.anthropic.com" }),
    );

    const provider = await resolveProvider("u-1");
    expect(provider.type).toBe("admin-key");
  });

  it("defaults the model to a Claude model on the Anthropic wire", async () => {
    const fetchMock = stubTransport();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(
      adminSettings({ adminAiBaseUrl: "https://api.anthropic.com/v1" }),
    );

    const provider = await resolveProvider("u-1");
    await provider.generateCompletion(probe());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      "claude-sonnet-4-6",
    );
  });
});
