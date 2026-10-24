/**
 * What one lab-scan read asks of each provider, at the wire.
 *
 * The read used to go out with no reasoning field, which several models read
 * as "reason at the default": OpenAI's reasoning models at `medium`, Codex at
 * its backend's default, Anthropic's 5 generation adaptively. Their reasoning
 * is billed against the same output allowance as the answer, so a report's
 * JSON stopped mid-row while the request looked like it had 8000 tokens to
 * spare. The read now carries an explicit off, and these hold what that
 * becomes on each wire: no reasoning where the model can stop, otherwise its
 * minimum with that minimum's thinking budget added on top, so the answer
 * keeps its full allowance either way.
 *
 * Mutation check: drop `reasoning: TRANSCRIPTION_REASONING` from
 * `ocrChunkParams` and the reasoning-model cases go red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetch = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...a: unknown[]) => safeFetch(...a),
}));
vi.mock("@/lib/ai/local-host-allowlist", () => ({
  aiEgressPolicyFor: () => ({}),
  isLocalAiHostAllowed: () => true,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { AnthropicClient } from "@/lib/ai/anthropic-client";
import { CodexClient } from "@/lib/ai/codex-client";
import { clearCodexSlugCache } from "@/lib/ai/codex-slug-cache";
import { LocalOpenAICompatibleClient } from "@/lib/ai/local-client";
import { OpenAIClient } from "@/lib/ai/openai-client";
import { REASONING_THINKING_BUDGET } from "@/lib/ai/reasoning/levels";
import { resetReasoningDialectCache } from "@/lib/ai/reasoning/dialect-cache";
import type { AIProvider } from "@/lib/ai/types";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { ocrChunkParams } from "@/lib/labs/ocr-extract";

const ANSWER = AI_BUDGETS.ocrExtract.maxTokens;
const STOP = new Error("stop after the request was built");

const read = () =>
  ocrChunkParams(
    "vision",
    {
      images: [{ mediaType: "image/jpeg", dataBase64: "cGFnZQ==" }],
      pages: [1],
    },
    0,
    2,
    2,
  );

/** The JSON body of the request the client dialled. */
async function sentBody(client: AIProvider): Promise<Record<string, unknown>> {
  await expect(client.generateCompletion(read())).rejects.toBe(STOP);
  const call = safeFetch.mock.calls.at(-1);
  expect(call, "safeFetch was never called").toBeDefined();
  return JSON.parse((call![1] as { body: string }).body);
}

beforeEach(() => {
  safeFetch.mockReset();
  safeFetch.mockRejectedValue(STOP);
  resetReasoningDialectCache();
  clearCodexSlugCache();
});

describe("Anthropic", () => {
  const client = (model: string) => new AnthropicClient({ apiKey: "k", model });

  it("adds the minimum thinking budget on top for a model that always thinks", async () => {
    const body = await sentBody(client("claude-sonnet-5"));
    expect(body.thinking).toMatchObject({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.max_tokens).toBe(ANSWER + REASONING_THINKING_BUDGET.low);
  });

  it("sends no thinking and the answer budget where thinking can stay off", async () => {
    for (const model of ["claude-sonnet-4-6", "claude-sonnet-4-5"]) {
      const body = await sentBody(client(model));
      expect(body).not.toHaveProperty("thinking");
      expect(body.max_tokens).toBe(ANSWER);
    }
  });
});

describe("OpenAI", () => {
  const client = (model: string) =>
    new OpenAIClient({
      apiKey: "k",
      model,
      baseUrl: "https://api.openai.com/v1",
    });

  it("asks a gpt-5.1+ model for no reasoning", async () => {
    const body = await sentBody(client("gpt-5.1"));
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_completion_tokens).toBe(ANSWER);
  });

  it("asks bare gpt-5 for its minimum, with that minimum's budget on top", async () => {
    const body = await sentBody(client("gpt-5"));
    expect(body.reasoning_effort).toBe("minimal");
    expect(body.max_completion_tokens).toBe(
      ANSWER + REASONING_THINKING_BUDGET.low,
    );
  });

  it("leaves a model that does not reason as it was", async () => {
    const body = await sentBody(client("gpt-4o"));
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(ANSWER);
  });
});

// #1276 — a gateway or local server cannot promise that `none` is honoured
// (a model behind it may reason anyway), so these wires add the minimum's
// thinking budget on top like a model that always thinks: the answer keeps
// its full allowance either way.
describe("an OpenAI-compatible gateway (Gemini, OpenRouter, LiteLLM)", () => {
  it("asks for no reasoning on the endpoint's own dialect, with the minimum's budget on top", async () => {
    const body = await sentBody(
      new OpenAIClient({
        apiKey: "k",
        model: "gemini-2.5-flash",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        providerType: "openai-compatible",
      }),
    );
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(
      ANSWER + REASONING_THINKING_BUDGET.low,
    );
  });
});

describe("a local server", () => {
  it("asks for no reasoning and keeps the answer budget, with the minimum's on top", async () => {
    const body = await sentBody(
      new LocalOpenAICompatibleClient({
        apiKey: null,
        model: "qwen3-vl",
        baseUrl: "https://llm.example.org/v1",
      }),
    );
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_tokens).toBe(ANSWER + REASONING_THINKING_BUDGET.low);
  });
});

describe("Codex", () => {
  it("asks for no reasoning instead of the backend's default", async () => {
    const body = await sentBody(
      new CodexClient({
        accessToken: "t",
        accountId: "a",
        onTokenRefresh: vi.fn(),
        slugChain: ["gpt-5.5"],
      }),
    );
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("tags a reply cut at the output limit so the read can tell it apart", async () => {
    const event = {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    };
    safeFetch.mockResolvedValueOnce(
      new Response(
        `event: response.incomplete\ndata: ${JSON.stringify(event)}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const err = await new CodexClient({
      accessToken: "t",
      accountId: "a",
      onTokenRefresh: vi.fn(),
      slugChain: ["gpt-5.5"],
    })
      .generateCompletion(read())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: "stream_failed",
      incompleteReason: "max_output_tokens",
    });
  });

  it("carries what it streamed before the cut, out of any serialisation", async () => {
    const delta = { type: "response.output_text.delta", delta: '{"rows":[{' };
    const event = {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    };
    safeFetch.mockResolvedValueOnce(
      new Response(
        `event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n` +
          `event: response.incomplete\ndata: ${JSON.stringify(event)}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const err = await new CodexClient({
      accessToken: "t",
      accountId: "a",
      onTokenRefresh: vi.fn(),
      slugChain: ["gpt-5.5"],
    })
      .generateCompletion(read())
      .catch((e: unknown) => e);
    expect((err as { partialContent?: string }).partialContent).toBe(
      '{"rows":[{',
    );
    expect(JSON.stringify(err)).not.toContain("rows");
    expect(Object.keys(err as object)).not.toContain("partialContent");
  });
});
