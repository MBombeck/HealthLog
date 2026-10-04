/**
 * #1126 — every exported resolver hands out providers carrying their own
 * chain entry's reasoning setting, and the request each one then sends
 * carries exactly that value. A chain mixing a thinking model with one that
 * does not know the field is the case the setting exists for.
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
vi.mock("@/lib/logging/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/context")>()),
  annotate: vi.fn(),
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

import { prisma } from "@/lib/db";
import {
  resolveProvider,
  resolveProviderChain,
  resolveProviderForTest,
} from "../provider";
import { resetLocalJsonDialectCache } from "../local-client";
import { singleUserTurn, type AIProvider } from "../types";

const ROW = {
  aiProvider: "LOCAL",
  aiModel: "gemma4:12b",
  aiBaseUrl: "https://ollama.example.org/v1",
  aiAnthropicKeyEncrypted: null,
  aiLocalKeyEncrypted: null,
  aiOpenaiKeyEncrypted: "openai-key",
  aiCompatBaseUrl: "https://gateway.example.org/v1",
  aiCompatKeyEncrypted: null,
  aiCompatModel: "llama3",
  role: "USER",
  useCentralCodex: false,
  managedProfileAt: null,
  aiResponseTimeoutSeconds: null,
};

function withChain(aiProviderChain: unknown) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    ...ROW,
    aiProviderChain,
  } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
}

const MIXED = [
  {
    providerType: "local",
    priority: 1,
    enabled: true,
    reasoningEffort: "none",
  },
  { providerType: "openai-compatible", priority: 2, enabled: true },
  { providerType: "openai", priority: 3, enabled: true },
];

/** The `reasoning_effort` the provider actually puts on the wire. */
async function sentEffort(provider: AIProvider): Promise<unknown> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { total_tokens: 1 },
      }),
  });
  vi.stubGlobal("fetch", mock);
  await provider.generateCompletion(singleUserTurn({ system: "s", user: "u" }));
  vi.unstubAllGlobals();
  const body = JSON.parse(mock.mock.calls[0][1].body as string);
  return "reasoning_effort" in body ? body.reasoning_effort : "(absent)";
}

beforeEach(() => {
  vi.resetAllMocks();
  resetLocalJsonDialectCache();
});

describe("resolveProviderChain binds each entry's own setting", () => {
  it("a mixed chain sends none, nothing, nothing", async () => {
    withChain(MIXED);
    const chain = await resolveProviderChain("user-1");
    expect(chain.map((e) => e.providerType)).toEqual([
      "local",
      "openai-compatible",
      "openai",
    ]);
    expect(chain.map((e) => e.instance.reasoningEffort)).toEqual([
      "none",
      null,
      null,
    ]);
    const sent = [];
    for (const entry of chain) sent.push(await sentEffort(entry.instance));
    expect(sent).toEqual(["none", "(absent)", "(absent)"]);
  });

  it("the gateway's own value reaches the gateway", async () => {
    withChain([
      { providerType: "local", priority: 1, enabled: true },
      {
        providerType: "openai-compatible",
        priority: 2,
        enabled: true,
        reasoningEffort: "high",
      },
    ]);
    const chain = await resolveProviderChain("user-1");
    expect(await sentEffort(chain[0].instance)).toBe("(absent)");
    expect(await sentEffort(chain[1].instance)).toBe("high");
  });
});

describe("resolveProvider", () => {
  it("binds the selected Local provider's setting", async () => {
    withChain(MIXED);
    const provider = await resolveProvider("user-1");
    expect(provider.type).toBe("local");
    expect(await sentEffort(provider)).toBe("none");
  });

  it("reaches a selected gateway whose value sits on a disabled entry", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...ROW,
      aiProvider: "OPENAI_COMPATIBLE",
      aiProviderChain: [
        { providerType: "codex", priority: 1, enabled: true },
        {
          providerType: "openai-compatible",
          priority: 2,
          enabled: false,
          reasoningEffort: "low",
        },
      ],
    } as never);
    const provider = await resolveProvider("user-1");
    expect(provider.type).toBe("openai-compatible");
    expect(await sentEffort(provider)).toBe("low");
  });
});

describe("resolveProviderForTest — the test button runs with the setting", () => {
  it("testing the saved config (empty body) uses the saved provider's entry", async () => {
    withChain(MIXED);
    const provider = await resolveProviderForTest("user-1", {});
    expect(provider.type).toBe("local");
    expect(await sentEffort(provider)).toBe("none");
  });

  it("with no provider selected, the test runs the chain head with its value", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...ROW,
      aiProvider: null,
      aiProviderChain: MIXED,
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
    const provider = await resolveProviderForTest("user-1", {});
    expect(provider.type).toBe("local");
    expect(await sentEffort(provider)).toBe("none");
  });

  it("testing a named Local provider uses its entry's value", async () => {
    withChain(MIXED);
    const provider = await resolveProviderForTest("user-1", {
      provider: "LOCAL",
    });
    expect(await sentEffort(provider)).toBe("none");
  });

  it("testing the personal OpenAI key never sends it", async () => {
    withChain(MIXED);
    const provider = await resolveProviderForTest("user-1", {
      provider: "OPENAI",
    });
    expect(await sentEffort(provider)).toBe("(absent)");
  });
});
