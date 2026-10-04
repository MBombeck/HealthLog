/**
 * #1126 — the per-entry reasoning setting on the wire and in the schemas.
 *
 * Default must leave the request body byte-identical to what a setup that
 * never touched the setting has always sent, so the Default cases compare the
 * whole body string against a literal captured before the setting existed.
 * Every other choice adds exactly one key, `reasoning_effort`, and only on the
 * Local client and the OpenAI-compatible gateway.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../local-host-allowlist", () => ({
  aiEgressPolicyFor: () => ({}),
  isLocalAiHostAllowed: () => false,
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
// The pinned tags dial through undici's own fetch; route every call to the
// stubbed global so the body can be read whatever the egress policy.
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

import { bindReasoningEffort, reasoningEffortFor } from "../reasoning-effort";
import {
  LocalOpenAICompatibleClient,
  resetLocalJsonDialectCache,
} from "../local-client";
import { OpenAIClient } from "../openai-client";
import { AnthropicClient } from "../anthropic-client";
import {
  chainWithReasoningEffort,
  parseProviderChain,
  PROVIDER_CHAIN_DEFAULT,
  serializeProviderChain,
} from "../provider-chain";
import { singleUserTurn, type AIProvider } from "../types";
import {
  aiProviderPatchSchema,
  providerChainEntrySchema,
  providerChainPutSchema,
} from "@/lib/validations/ai-provider";

const PARAMS = {
  ...singleUserTurn({ system: "s", user: "u" }),
  maxTokens: 250,
};

function okFetch(content = "ok") {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      }),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function sentBody(mock: ReturnType<typeof okFetch>): string {
  return mock.mock.calls[0][1].body as string;
}

function localClient() {
  return new LocalOpenAICompatibleClient({
    apiKey: null,
    model: "gemma4:12b",
    baseUrl: "http://ollama.example.org:11434/v1",
  });
}

function gatewayClient() {
  return new OpenAIClient({
    apiKey: "",
    model: "qwen3",
    baseUrl: "https://gateway.example.org/v1",
    providerType: "openai-compatible",
  });
}

// Captured from the clients before the setting existed. Default must keep
// sending exactly this.
const LOCAL_BODY_BEFORE =
  '{"model":"gemma4:12b","messages":[{"role":"system","content":"s"},{"role":"user","content":"Return strict JSON only, no markdown, no commentary.\\n\\nu"}],"temperature":0.3,"max_tokens":250}';
const GATEWAY_BODY_BEFORE =
  '{"model":"qwen3","messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}],"max_tokens":250,"temperature":0.3}';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetLocalJsonDialectCache();
});

describe("Local client", () => {
  it("Default sends the body it always sent, byte for byte", async () => {
    const mock = okFetch();
    await localClient().generateCompletion(PARAMS);
    expect(sentBody(mock)).toBe(LOCAL_BODY_BEFORE);
    expect(JSON.parse(sentBody(mock))).not.toHaveProperty("reasoning_effort");
  });

  it("Off sends reasoning_effort none and nothing else new", async () => {
    const mock = okFetch();
    const client = localClient();
    client.reasoningEffort = "none";
    await client.generateCompletion(PARAMS);
    const body = JSON.parse(sentBody(mock));
    expect(body.reasoning_effort).toBe("none");
    const { reasoning_effort: _dropped, ...rest } = body;
    expect(JSON.stringify(rest)).toBe(LOCAL_BODY_BEFORE);
  });

  it.each(["low", "medium", "high"] as const)("%s is sent as is", async (v) => {
    const mock = okFetch();
    const client = localClient();
    client.reasoningEffort = v;
    await client.generateCompletion(PARAMS);
    expect(JSON.parse(sentBody(mock)).reasoning_effort).toBe(v);
  });

  it("the streaming request carries it too", async () => {
    const mock = okFetch();
    const client = localClient();
    client.reasoningEffort = "none";
    // A buffered answer to a stream request falls back cleanly; only the
    // first request body matters here.
    await client.generateCompletionStream(PARAMS, () => {}).catch(() => {});
    const body = JSON.parse(sentBody(mock));
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBe("none");
  });
});

describe("OpenAI-compatible gateway", () => {
  it("Default sends the body it always sent, byte for byte", async () => {
    const mock = okFetch();
    await gatewayClient().generateCompletion(PARAMS);
    expect(sentBody(mock)).toBe(GATEWAY_BODY_BEFORE);
  });

  it("Off sends reasoning_effort none", async () => {
    const mock = okFetch();
    const client = gatewayClient();
    client.reasoningEffort = "none";
    await client.generateCompletion(PARAMS);
    expect(JSON.parse(sentBody(mock)).reasoning_effort).toBe("none");
  });

  it("the OpenAI and Codex tags never send it, whatever is stamped", async () => {
    for (const providerType of ["admin-key", "codex"] as const) {
      vi.unstubAllGlobals();
      const mock = okFetch();
      const client = new OpenAIClient({
        apiKey: "k",
        model: "gpt-4o",
        baseUrl: "https://gateway.example.org/v1",
        providerType,
      });
      client.reasoningEffort = "high";
      await client.generateCompletion(PARAMS);
      expect(JSON.parse(sentBody(mock))).not.toHaveProperty("reasoning_effort");
    }
  });
});

describe("bindReasoningEffort", () => {
  const chain = [
    {
      providerType: "local",
      priority: 1,
      enabled: true,
      reasoningEffort: "none",
    },
    {
      providerType: "openai-compatible",
      priority: 2,
      enabled: true,
      reasoningEffort: "high",
    },
    { providerType: "openai", priority: 3, enabled: true },
  ];

  it("stamps each entry's own value, keyed on the instance type", () => {
    expect(bindReasoningEffort(localClient(), chain).reasoningEffort).toBe(
      "none",
    );
    expect(bindReasoningEffort(gatewayClient(), chain).reasoningEffort).toBe(
      "high",
    );
  });

  it("stamps null on every other provider", () => {
    const openai = new OpenAIClient({
      apiKey: "k",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    });
    const anthropic: AIProvider = new AnthropicClient({
      apiKey: "k",
      model: "m",
    });
    expect(bindReasoningEffort(openai, chain).reasoningEffort).toBeNull();
    expect(bindReasoningEffort(anthropic, chain).reasoningEffort).toBeNull();
  });

  it("stamps null for a chain that was never customised", () => {
    expect(bindReasoningEffort(localClient(), null).reasoningEffort).toBeNull();
  });
});

describe("the stored chain", () => {
  it("keeps a valid value on local / openai-compatible and drops it elsewhere", () => {
    const parsed = parseProviderChain([
      {
        providerType: "local",
        priority: 1,
        enabled: true,
        reasoningEffort: "low",
      },
      {
        providerType: "openai",
        priority: 2,
        enabled: true,
        reasoningEffort: "low",
      },
      {
        providerType: "openai-compatible",
        priority: 3,
        enabled: true,
        reasoningEffort: "max",
      },
    ]);
    expect(parsed.map((e) => e.reasoningEffort)).toEqual([
      "low",
      undefined,
      undefined,
    ]);
    expect(serializeProviderChain(parsed)).toBe(
      '[{"providerType":"local","priority":1,"enabled":true,"reasoningEffort":"low"},{"providerType":"openai","priority":2,"enabled":true},{"providerType":"openai-compatible","priority":3,"enabled":true}]',
    );
  });

  it("serialises a chain without the setting exactly as before", () => {
    expect(serializeProviderChain(PROVIDER_CHAIN_DEFAULT)).not.toContain(
      "reasoningEffort",
    );
  });

  it("materialises the default chain to hold a value", () => {
    const next = chainWithReasoningEffort(null, "local", "none");
    expect(next.map((e) => e.providerType)).toEqual(
      PROVIDER_CHAIN_DEFAULT.map((e) => e.providerType),
    );
    expect(reasoningEffortFor(next, "local")).toBe("none");
  });

  it("holds a value for a provider absent from the chain on a disabled entry", () => {
    const stored = [{ providerType: "codex", priority: 7, enabled: true }];
    const next = chainWithReasoningEffort(stored, "openai-compatible", "high");
    expect(next).toEqual([
      { providerType: "codex", priority: 7, enabled: true },
      {
        providerType: "openai-compatible",
        priority: 8,
        enabled: false,
        reasoningEffort: "high",
      },
    ]);
  });

  it("clears without adding an entry", () => {
    const stored = [
      {
        providerType: "local",
        priority: 1,
        enabled: true,
        reasoningEffort: "low",
      },
    ];
    expect(chainWithReasoningEffort(stored, "local", null)).toEqual([
      { providerType: "local", priority: 1, enabled: true },
    ]);
    expect(chainWithReasoningEffort(stored, "openai-compatible", null)).toEqual(
      [
        {
          providerType: "local",
          priority: 1,
          enabled: true,
          reasoningEffort: "low",
        },
      ],
    );
  });
});

describe("schemas", () => {
  const VALUES = [null, "none", "low", "medium", "high"] as const;

  it.each(["local", "openai-compatible"])(
    "a %s chain entry accepts Default, Off, Low, Medium and High",
    (providerType) => {
      for (const reasoningEffort of VALUES) {
        expect(
          providerChainEntrySchema.safeParse({
            providerType,
            enabled: true,
            reasoningEffort,
          }).success,
        ).toBe(true);
      }
    },
  );

  it("refuses a value outside the five", () => {
    expect(
      providerChainEntrySchema.safeParse({
        providerType: "local",
        enabled: true,
        reasoningEffort: "max",
      }).success,
    ).toBe(false);
  });

  it.each(["openai", "anthropic", "codex", "admin-openai", "admin-codex"])(
    "refuses the setting on a %s entry, null included",
    (providerType) => {
      for (const reasoningEffort of VALUES) {
        const result = providerChainEntrySchema.safeParse({
          providerType,
          enabled: true,
          reasoningEffort,
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toEqual(["reasoningEffort"]);
      }
      expect(
        providerChainEntrySchema.safeParse({ providerType, enabled: true })
          .success,
      ).toBe(true);
    },
  );

  it("the chain body still accepts a chain without the setting", () => {
    expect(
      providerChainPutSchema.safeParse({
        chain: [{ providerType: "local", priority: 1, enabled: true }],
      }).success,
    ).toBe(true);
  });

  it("the provider PATCH accepts the five values for both entries", () => {
    for (const v of VALUES) {
      expect(
        aiProviderPatchSchema.safeParse({
          localReasoningEffort: v,
          compatReasoningEffort: v,
        }).success,
      ).toBe(true);
    }
    expect(
      aiProviderPatchSchema.safeParse({ localReasoningEffort: "max" }).success,
    ).toBe(false);
  });
});
