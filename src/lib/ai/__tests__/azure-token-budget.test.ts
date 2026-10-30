import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetJsonModeDialectCache } from "../json-dialect";
import { OpenAIClient } from "../openai-client";
import {
  isAzureOpenAIV1Endpoint,
  isMaxTokensRejection,
  resetMaxTokensRefusals,
  selectOpenAIChatCompletionsCapabilities,
} from "../openai-capabilities";
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import { singleUserTurn } from "../types";

/**
 * #1304 — an OpenAI-compatible gateway entry pointed straight at an Azure
 * OpenAI v1 endpoint. A reasoning deployment refuses `max_tokens` with a 400;
 * the request has to carry `max_completion_tokens` and no sampling controls,
 * as it does on `api.openai.com`. Every other gateway keeps the legacy wire.
 */

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

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

const AZURE = "https://example-resource.openai.azure.com/openai/v1";

// The upstream error the report quotes, verbatim.
const AZURE_REFUSAL = JSON.stringify({
  error: {
    message:
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    type: "invalid_request_error",
    param: "max_tokens",
    code: "unsupported_parameter",
  },
});

function ok() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [
          { message: { content: '{"ok":true}' }, finish_reason: "stop" },
        ],
        usage: { total_tokens: 5 },
      }),
  };
}

function refused(status: number, body: string) {
  return { ok: false, status, text: () => Promise.resolve(body) };
}

function gateway(model: string, baseUrl = AZURE) {
  return new OpenAIClient({
    apiKey: "k",
    model,
    baseUrl,
    providerType: "openai-compatible",
  });
}

const turn = (responseFormat?: "json") =>
  singleUserTurn({ system: "s", user: "u", responseFormat });

function bodyOf(mock: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(mock.mock.calls[call][1].body);
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetJsonModeDialectCache();
  resetReasoningDialectCache();
  resetMaxTokensRefusals();
});

describe("Azure OpenAI v1 endpoint", () => {
  it.each([
    AZURE,
    `${AZURE}/`,
    "https://example-resource.cognitiveservices.azure.com/openai/v1",
    "https://example-resource.services.ai.azure.com/openai/v1",
  ])("recognises %s", (url) => {
    expect(isAzureOpenAIV1Endpoint(url)).toBe(true);
  });

  it.each([
    "http://example-resource.openai.azure.com/openai/v1",
    "https://example-resource.openai.azure.com.example.com/openai/v1",
    "https://openai.azure.com/openai/v1",
    "https://example-resource.openai.azure.com/openai/deployments/x",
    "https://example-resource.openai.azure.com:8443/openai/v1",
    `${AZURE}?api-version=preview`,
    "https://litellm.example.com/v1",
    "not a url",
  ])("does not take %s for one", (url) => {
    expect(isAzureOpenAIV1Endpoint(url)).toBe(false);
  });

  it("sends a reasoning deployment max_completion_tokens and no temperature", async () => {
    const mock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", mock);
    await gateway("gpt-6-luna-example").generateCompletion(turn());
    expect(mock).toHaveBeenCalledTimes(1);
    const body = bodyOf(mock);
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("seed");
  });

  it("keeps the legacy wire for a GPT-4 deployment", async () => {
    const mock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", mock);
    await gateway("gpt-4o").generateCompletion(turn());
    const body = bodyOf(mock);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.temperature).toBe(0.3);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("keeps the legacy wire for a reasoning model name behind another gateway", () => {
    expect(
      selectOpenAIChatCompletionsCapabilities(
        "https://litellm.example.com/v1",
        "gpt-6-luna",
      ).tokenBudgetField,
    ).toBe("max_tokens");
  });
});

describe("an endpoint that refuses max_tokens", () => {
  it("asks again with max_completion_tokens for an opaque deployment name and remembers it", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(refused(400, AZURE_REFUSAL))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", mock);
    const client = gateway("prod-chat");

    const result = await client.generateCompletion(turn());
    expect(result.content).toBe('{"ok":true}');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(bodyOf(mock, 0).max_tokens).toBeGreaterThan(0);
    const repeat = bodyOf(mock, 1);
    expect(repeat.max_completion_tokens).toBe(bodyOf(mock, 0).max_tokens);
    expect(repeat).not.toHaveProperty("max_tokens");
    expect(repeat).not.toHaveProperty("temperature");

    await client.generateCompletion(turn());
    expect(mock).toHaveBeenCalledTimes(3);
    expect(bodyOf(mock, 2)).toHaveProperty("max_completion_tokens");
  });

  it("learns it for that model only", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(refused(400, AZURE_REFUSAL))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", mock);
    await gateway("prod-chat").generateCompletion(turn());
    await gateway("prod-legacy").generateCompletion(turn());
    expect(bodyOf(mock, 2)).toHaveProperty("max_tokens");
  });

  it("keeps JSON mode on the repeat", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(refused(400, AZURE_REFUSAL))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", mock);
    await gateway("prod-chat").generateCompletion(turn("json"));
    expect(bodyOf(mock, 1).response_format).toEqual({ type: "json_object" });
  });

  it("does not take a complaint about the value for a refusal of the field", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        refused(400, '{"error":"max_tokens is too large: 900000"}'),
      );
    vi.stubGlobal("fetch", mock);
    await expect(
      gateway("prod-chat").generateCompletion(turn()),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("asks again on every call that sent max_tokens, also beside one that learned it", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(refused(400, AZURE_REFUSAL))
      .mockResolvedValueOnce(refused(400, AZURE_REFUSAL))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", mock);
    const client = gateway("prod-chat");
    const results = await Promise.allSettled([
      client.generateCompletion(turn()),
      client.generateCompletion(turn()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it("reads only a 400 that names the field", () => {
    expect(isMaxTokensRejection(400, AZURE_REFUSAL)).toBe(true);
    expect(isMaxTokensRejection(422, AZURE_REFUSAL)).toBe(false);
    expect(
      isMaxTokensRejection(400, '{"error":"Unsupported parameter: top_k"}'),
    ).toBe(false);
    // A refusal of another field that echoes the request.
    expect(
      isMaxTokensRejection(
        400,
        '{"error":"Unsupported parameter: reasoning_effort is not supported","request":{"max_tokens":1000}}',
      ),
    ).toBe(false);
    expect(
      isMaxTokensRejection(
        400,
        '{"error":"max_tokens is not supported with this model"}',
      ),
    ).toBe(true);
  });
});
