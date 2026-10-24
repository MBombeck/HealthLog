/**
 * The person's response-timeout setting reaches every model call.
 *
 * A slow self-hosted model could need minutes for a five-page lab report, and
 * raising Settings → AI → response timeout did nothing for it: the document
 * read, the document extraction and the lab OCR called the provider without a
 * `timeoutMs`, so every client fell back to its own 60 s. The setting now rides
 * on the provider instance (stamped by the resolver) and every client reads its
 * ceiling through `callTimeoutMs`, so these surfaces get it without passing it.
 *
 * These cases drive the real clients and the real surface functions down to
 * the `safeFetch` call and read the timeout off it, so they hold the pipe and
 * not just the helper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetch = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...a: unknown[]) => safeFetch(...a),
}));
vi.mock("../local-host-allowlist", () => ({
  aiEgressPolicyFor: () => ({}),
  isLocalAiHostAllowed: () => true,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
// A transcription re-checks the wire before each read; the wire is open here.
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: async () => null,
}));

import { AnthropicClient } from "../anthropic-client";
import { CodexClient } from "../codex-client";
import {
  bindResponseTimeout,
  callTimeoutMs,
  clientAbortMs,
  PROVIDER_DEFAULT_TIMEOUT_MS,
} from "../effective-timeout";
import { LocalOpenAICompatibleClient } from "../local-client";
import { OpenAIClient } from "../openai-client";
import { singleUserTurn, type AIProvider } from "../types";
import { runDocumentAssist } from "@/lib/documents/assist";
import {
  runDocumentSummary,
  transcribeDocument,
} from "@/lib/documents/describe";
import { runInboundExtraction } from "@/lib/documents/extract";
import { runOcrExtraction } from "@/lib/labs/ocr-extract";

const STOP = new Error("stop after the fetch was dialled");

beforeEach(() => {
  safeFetch.mockReset();
  safeFetch.mockRejectedValue(STOP);
});

/** The `timeoutMs` the most recent `safeFetch` call was dialled with. */
function dialledTimeout(): number {
  const call = safeFetch.mock.calls.at(-1);
  expect(call, "safeFetch was never called").toBeDefined();
  return (call![2] as { timeoutMs: number }).timeoutMs;
}

function local(): LocalOpenAICompatibleClient {
  return new LocalOpenAICompatibleClient({
    apiKey: null,
    model: "llama",
    baseUrl: "https://llm.example.org/v1",
  });
}

const CLIENTS: Record<string, () => AIProvider> = {
  local,
  openai: () =>
    new OpenAIClient({
      apiKey: "k",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    }),
  anthropic: () =>
    new AnthropicClient({ apiKey: "k", model: "claude-sonnet-4-6" }),
  codex: () =>
    new CodexClient({
      accessToken: "t",
      accountId: "a",
      onTokenRefresh: vi.fn(),
      slugChain: ["gpt-5.5"],
    }),
};

describe("callTimeoutMs", () => {
  it("lets the setting win over the surface value and the default", () => {
    expect(callTimeoutMs({}, null)).toBe(PROVIDER_DEFAULT_TIMEOUT_MS);
    expect(callTimeoutMs({ timeoutMs: 180_000 }, null)).toBe(180_000);
    expect(callTimeoutMs({}, 300)).toBe(300_000);
    expect(callTimeoutMs({ timeoutMs: 180_000 }, 30)).toBe(30_000);
  });

  it("keeps a surface ceiling where the surface says so", () => {
    expect(
      callTimeoutMs(
        { timeoutMs: 9_000, timeoutPolicy: "surface-ceiling" },
        600,
      ),
    ).toBe(9_000);
  });
});

describe("bindResponseTimeout", () => {
  it("stamps a positive setting and clears an unset one", () => {
    const p = local();
    expect(bindResponseTimeout(p, 240).responseTimeoutSeconds).toBe(240);
    expect(bindResponseTimeout(p, null).responseTimeoutSeconds).toBeNull();
    expect(bindResponseTimeout(p, 0).responseTimeoutSeconds).toBeNull();
  });
});

describe("clientAbortMs", () => {
  it("waits for every model call plus the margin", () => {
    expect(clientAbortMs(300_000, 1)).toBe(330_000);
    expect(clientAbortMs(300_000, 3)).toBe(930_000);
  });

  it("reads a missing or malformed value as the server default", () => {
    expect(clientAbortMs(undefined, 2)).toBe(2 * 60_000 + 30_000);
    expect(clientAbortMs(0, 1)).toBe(90_000);
  });
});

describe.each(Object.entries(CLIENTS))("the %s client", (_name, make) => {
  it("dials with the bound setting, over the surface value", async () => {
    const provider = bindResponseTimeout(make(), 420);
    await expect(
      provider.generateCompletion(
        singleUserTurn({ system: "s", user: "u", timeoutMs: 120_000 }),
      ),
    ).rejects.toBeDefined();
    expect(dialledTimeout()).toBe(420_000);
  });

  it("dials with the default when nothing is set", async () => {
    await expect(
      make().generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toBeDefined();
    expect(dialledTimeout()).toBe(60_000);
  });

  it("keeps a surface ceiling", async () => {
    const provider = bindResponseTimeout(make(), 420);
    await expect(
      provider.generateCompletion(
        singleUserTurn({
          system: "s",
          user: "u",
          timeoutMs: 9_000,
          timeoutPolicy: "surface-ceiling",
        }),
      ),
    ).rejects.toBeDefined();
    expect(dialledTimeout()).toBe(9_000);
  });
});

describe("the surfaces that used to fall back to 60 s", () => {
  const image = [{ mediaType: "image/png" as const, dataBase64: "AAAA" }];

  function bound(): AIProvider {
    return bindResponseTimeout(local(), 300);
  }

  it("document summary", async () => {
    await expect(
      runDocumentSummary({
        provider: bound(),
        providerType: "local",
        images: image,
        locale: "en",
      }),
    ).rejects.toBe(STOP);
    expect(dialledTimeout()).toBe(300_000);
  });

  it("document transcription (Read with AI)", async () => {
    await expect(
      transcribeDocument({
        provider: bound(),
        providerType: "local",
        images: image,
      }),
    ).rejects.toBe(STOP);
    expect(dialledTimeout()).toBe(300_000);
  });

  it("document filing suggestion", async () => {
    await expect(
      runDocumentAssist({
        provider: bound(),
        providerType: "local",
        images: image,
      }),
    ).rejects.toBe(STOP);
    expect(dialledTimeout()).toBe(300_000);
  });

  it("document extraction, which lab staging runs", async () => {
    await expect(
      runInboundExtraction({
        userId: "u1",
        provider: bound(),
        providerType: "local",
        mode: "vision",
        chunks: [{ images: image, pages: [] }],
      }),
    ).rejects.toBe(STOP);
    expect(dialledTimeout()).toBe(300_000);
  });

  it("lab OCR", async () => {
    await expect(
      runOcrExtraction({
        userId: "u1",
        provider: bound(),
        providerType: "local",
        mode: "vision",
        chunks: [{ images: image, pages: [] }],
      }),
    ).rejects.toBe(STOP);
    expect(dialledTimeout()).toBe(300_000);
  });
});
